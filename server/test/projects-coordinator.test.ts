import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { collectProjectMessageCalls } from "@cesium/core";
import { parseProjectNoticeNames, type ProjectSnapshot } from "@cesium/core/projects";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";
import {
  messageText,
  startFakeChatModel,
  text,
  toolCall,
  waitFor,
  type Responder,
} from "./helpers/fake-chat-model.js";
import { createRepoWithRemote, git } from "./helpers/git-fixtures.js";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-projects-coordinator-"));
const SHOP_REPO = path.join(TEST_DATA_DIR, "repos", "shop");
const SHOP_REMOTE = path.join(TEST_DATA_DIR, "remotes", "shop.git");
const { headSha: SHOP_HEAD } = await createRepoWithRemote({
  repoDir: SHOP_REPO,
  remoteDir: SHOP_REMOTE,
  files: { "README.md": "# Shop\n", "src/cart.js": "export const total = (items) => items.length;\n" },
});

for (const key of [
  "REDIS_URL",
  "DATABASE_URL",
  "OPENCURSOR_STORAGE_DRIVER",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "OPENCURSOR_TRANSCRIPTION_BASE_URL",
  "OPENCURSOR_TRANSCRIPTION_API_KEY",
  "OPENCURSOR_TITLE_MODEL",
  "CESIUM_MODELS",
  "CESIUM_PROJECTS_ENABLED",
  "CESIUM_GITHUB_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
]) {
  delete process.env[key];
}
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
process.env.WORKSPACE_ALLOWED_ROOTS = TEST_DATA_DIR;
process.env.CESIUM_ENGINE_LABEL = "Home";
// No GitHub in this suite: point the client at nothing so gh on the host is never consulted.
process.env.CESIUM_GITHUB_API_URL = "http://127.0.0.1:9";

const model = await startFakeChatModel();
const { script, requestsFor } = model;
process.env.CESIUM_BASE_URL = model.baseUrl;
process.env.CESIUM_API_KEY = "sk-test-projects";
process.env.CESIUM_PROVIDER_ID = "projhost";
process.env.CESIUM_DEFAULT_MODEL = "kimi-k3";
const MODEL_ID = "projhost/kimi-k3";

const [
  { createCesiumApp },
  { agentRuntimeManager },
  { readConversationRecord, readConversationSnapshot },
  { startAgentPromptQueueDrainListener },
  { startProjectWatcher, deliverProjectNotice },
  { readProject },
  { getWorkspaceById },
  { buildAgentConversationsAllPayload },
  { buildProjectOrchestratorReminder, executeProjectOrchestratorTool },
  { PROJECT_ORCHESTRATOR_TOOLS, PROJECT_ORCHESTRATOR_SYSTEM_PROMPT },
  { setExploreWaitForTests },
  { getPreferencesPath },
] = await Promise.all([
  import("../src/app.js"),
  import("../src/lib/agents/runtime-manager.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/agents/prompt-queue-drain.js"),
  import("../src/lib/projects/project-watcher.js"),
  import("../src/lib/projects/project-store.js"),
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/rail-payload.js"),
  import("../src/lib/projects/orchestrator-tools.js"),
  import("../src/lib/projects/orchestrator-tool-definitions.js"),
  import("../src/lib/projects/helpers.js"),
  import("../src/lib/projects/preferences.js"),
]);

const app = createCesiumApp();
startAgentPromptQueueDrainListener();
const stopWatcher = startProjectWatcher();

after(async () => {
  stopWatcher();
  setExploreWaitForTests(null);
  await model.close();
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

type Json = Record<string, unknown>;

async function api<T = Json>(method: string, pathname: string, body?: unknown): Promise<{ status: number; json: T }> {
  const response = await app.request(pathname, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as T };
}

function eventsOfKind<K extends AgentStoredEvent["kind"]>(events: AgentStoredEvent[], kind: K) {
  return events.filter((event): event is Extract<AgentStoredEvent, { kind: K }> => event.kind === kind);
}

let project: ProjectSnapshot;

async function orchestrator() {
  const snapshot = await readConversationSnapshot(project.orchestrator.workspaceId, project.orchestrator.conversationId);
  assert.ok(snapshot);
  return snapshot;
}

async function orchestratorIdle(label: string) {
  return waitFor(
    label,
    () => readConversationSnapshot(project.orchestrator.workspaceId, project.orchestrator.conversationId),
    (snapshot) => snapshot.conversation.status === "idle" && snapshot.conversation.queuedPrompts.length === 0,
    30_000
  );
}

/** Waits until an agent update naming `name` (and matching `pattern`) reached the coordinator. */
async function updateDelivered(name: string, pattern?: RegExp) {
  return waitFor(
    `an agent update for ${name}`,
    orchestrator,
    (value) =>
      eventsOfKind(value.events, "user_message").some(
        (event) =>
          parseProjectNoticeNames(event.displayContent).includes(name) && (!pattern || pattern.test(event.content))
      ),
    30_000
  );
}

async function firstRequest(key: string) {
  const [request] = await waitFor(`a model request from ${key}`, async () => requestsFor(key), (list) => list.length > 0);
  return request!.messages.map(messageText).join("\n");
}

async function prompt(textValue: string) {
  const workspace = await getWorkspaceById(project.orchestrator.workspaceId);
  assert.ok(workspace);
  await agentRuntimeManager.promptConversation(workspace, project.orchestrator.conversationId, textValue);
}

async function childRecord(name: string) {
  const record = await readProject(project.id);
  const child = record?.children.find((entry) => entry.name === name);
  assert.ok(child, `child ${name} exists`);
  return child;
}

function toolResult(events: AgentStoredEvent[], toolCallId: string): string {
  const update = eventsOfKind(events, "tool_call_update").find(
    (event) => event.toolCallId === toolCallId && event.status !== "in_progress"
  );
  assert.ok(update, `tool ${toolCallId} finished`);
  return update.detail ?? "";
}

function toolFinished(events: AgentStoredEvent[], toolCallId: string): boolean {
  return eventsOfKind(events, "tool_call_update").some(
    (event) => event.toolCallId === toolCallId && event.status !== "in_progress"
  );
}

function gated(reply: Responder): { responder: Responder; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    responder: async (request, res) => {
      await gate;
      await reply(request, res);
    },
    release,
  };
}

test("the coordinator runs on its contract: delegate, plan vague asks, talk through messages", async () => {
  const created = await api<ProjectSnapshot>("POST", "/api/projects", {
    name: "Checkout revamp",
    modelId: MODEL_ID,
    repos: [{ root: SHOP_REPO }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  project = created.json;
  script("orchestrator", text(["Ready."]));
  await prompt("Hi");
  await orchestratorIdle("first turn");
  const request = requestsFor("orchestrator").at(-1)!;
  const tools = (request.tools ?? []).map((tool) => tool.function?.name);
  for (const name of ["project_message_user", "project_explore", "project_browser_check", "project_preferences", "project_create_agent"]) {
    assert.ok(tools.includes(name), name);
  }
  assert.deepEqual(tools.sort(), [...PROJECT_ORCHESTRATOR_TOOLS.map((tool) => tool.name), "ask_question"].sort());
  const system = request.messages.map(messageText).join("\n");
  assert.ok(system.includes(PROJECT_ORCHESTRATOR_SYSTEM_PROMPT));
  assert.match(PROJECT_ORCHESTRATOR_SYSTEM_PROMPT, /You never do the work yourself/);
  assert.match(PROJECT_ORCHESTRATOR_SYSTEM_PROMPT, /Vague requests: plan it yourself, never ask the user for steps/);
  assert.match(PROJECT_ORCHESTRATOR_SYSTEM_PROMPT, /Talk to the user with project_message_user/);
  assert.match(PROJECT_ORCHESTRATOR_SYSTEM_PROMPT, /research agent that writes its findings to docs\/ in the Project context \(it changes no code, so it opens no pull request\)/);
  assert.match(PROJECT_ORCHESTRATOR_SYSTEM_PROMPT, /You can merge pull requests but not close them: when one should be closed \(redundant, superseded\), tell the user instead of saying you closed it\./);
});

test("messages to the user flag embedded evidence that doesn't exist", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  const upload = await app.request(`/api/projects/${project.id}/context/upload?path=media/cart/after.png`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: png,
  });
  assert.equal(upload.status, 201);
  const result = JSON.parse(
    await executeProjectOrchestratorTool(project.id, "project_message_user", {
      message: "The cart total works now.\n\n![after](context:media/cart/after.png)\n![nope](context:media/cart/missing.png)",
    })
  ) as { delivered: boolean; missingMedia?: string[] };
  assert.equal(result.delivered, true);
  assert.deepEqual(result.missingMedia, ["media/cart/missing.png"]);
  const clean = JSON.parse(
    await executeProjectOrchestratorTool(project.id, "project_message_user", { message: "All good." })
  ) as Json;
  assert.deepEqual(clean, { delivered: true });
  await assert.rejects(executeProjectOrchestratorTool(project.id, "project_message_user", { message: "  " }), /required/);
});

test("a vague request: the coordinator asks an explorer, then starts parallel workers and tells the user", async () => {
  script("explore", text(["The total is computed in src/cart.js:1 as items.length (ignores quantity). There are no tests."]));
  script("cart-total", text(["Total now multiplies by quantity."]));
  script("cart-tests", text(["Added node:test coverage for the cart."]));
  script(
    "orchestrator",
    toolCall("call_explore", "project_explore", {
      repo: "shop",
      questions: ["Where is the cart total computed and which tests cover it?"],
    }),
    toolCall("call_total", "project_create_agent", {
      name: "cart-total",
      repo: "shop",
      instructions: "Make the cart total multiply price by quantity.",
    }),
    toolCall("call_tests", "project_create_agent", {
      name: "cart-tests",
      repo: "shop",
      instructions: "Add tests for the cart total with node:test.",
    }),
    toolCall("call_tell", "project_message_user", {
      message: "The total ignores quantity and nothing tests it. I started **cart-total** (the fix) and **cart-tests** (tests) in parallel.",
    }),
    text(["Explored, started cart-total and cart-tests, told the user."])
  );
  await prompt("Checkout totals look wrong. Make it right.");
  const snapshot = await waitFor(
    "vague request turn",
    orchestrator,
    (value) => eventsOfKind(value.events, "tool_call_update").some((event) => event.toolCallId === "call_tell" && event.status !== "in_progress"),
    60_000
  );
  const explored = toolResult(snapshot.events, "call_explore");
  assert.match(explored, /^Explorer explore answered \(saved to internal\/explore\/explore\.md\):\n\nThe total is computed in src\/cart\.js:1/);

  const record = await readProject(project.id);
  const explorer = record!.children.find((child) => child.name === "explore")!;
  assert.equal(explorer.kind, "helper");
  assert.equal(explorer.helperKind, "explore");
  const explorerTools = (requestsFor("explore")[0]?.tools ?? []).map((tool) => tool.function?.name);
  assert.ok(explorerTools.includes("read_file") && explorerTools.includes("grep"), "the explorer can read and search");
  for (const mutating of ["edit_file", "write_file", "terminal", "call_mcp_tool"]) {
    assert.equal(explorerTools.includes(mutating), false, `the explorer is read-only: no ${mutating}`);
  }
  assert.equal(explorer.baseSha, SHOP_HEAD, "it read a clean checkout of the remote base");
  assert.equal(typeof explorer.deletedAt, "number", "one-shot: the explorer is removed after answering");
  await assert.rejects(fs.access(explorer.worktreePath!), "its checkout is gone");
  assert.equal((await git(SHOP_REPO, ["worktree", "list"])).split("\n").length, 3, "the user's checkout plus the two workers");
  const explorerBrief = await firstRequest("explore");
  assert.match(explorerBrief, /<project_helper_brief>\nYou are "explore", a helper agent in the Cesium Project "Checkout revamp": a read-only code explorer/);
  assert.match(explorerBrief, new RegExp(`a clean checkout of origin/main \\(${SHOP_HEAD.slice(0, 12)}\\)`));
  const saved = await fs.readFile(path.join(project.contextRoot, "internal", "explore", "explore.md"), "utf8");
  assert.match(saved, /Question: Where is the cart total computed and which tests cover it\?/);
  assert.match(saved, /## Answer\n\nThe total is computed in src\/cart\.js:1/);

  const total = await childRecord("cart-total");
  const tests = await childRecord("cart-tests");
  assert.equal(total.kind, "worker");
  assert.notEqual(total.branch, tests.branch);
  assert.ok(total.worktreePath && tests.worktreePath);
  const told = eventsOfKind(snapshot.events, "tool_call").find((event) => event.toolCallId === "call_tell");
  assert.ok(told, "the coordinator messaged the user");
  await updateDelivered("cart-total", /Total now multiplies by quantity/);
  await updateDelivered("cart-tests", /Added node:test coverage/);
  await orchestratorIdle("after the workers report");
  const notices = eventsOfKind((await orchestrator()).events, "user_message").filter((event) =>
    event.displayContent?.startsWith("Agent update · ")
  );
  assert.equal(
    notices.some((event) => event.displayContent?.includes("explore")),
    false,
    "an answered explorer does not also arrive as an update"
  );
  const rail = await buildAgentConversationsAllPayload({ limit: 200, offset: 0 });
  assert.equal(
    rail.groups.some((group) => group.conversations.some((conversation) => conversation.id === explorer.conversationId)),
    false
  );
});

test("a slow explorer keeps working and reports back as an agent update", async () => {
  setExploreWaitForTests(150);
  try {
    script("explore-2", text(["Checkout lives in src/checkout.js (not written yet)."], { delayMs: 1_200 }));
    script("orchestrator", text(["The explorer answered; noted."]));
    const output = await executeProjectOrchestratorTool(project.id, "project_explore", {
      repo: "shop",
      questions: ["Where is checkout?"],
    });
    assert.match(output, /^Explorer explore-2 is still working; its answer arrives as an agent update\.\n\n---\n\nAgents report back on their own/);
    await updateDelivered(
      "explore-2",
      /Checkout lives in src\/checkout\.js[\s\S]*Full answer: internal\/explore\/explore-2\.md in the Project context\./
    );
    const explorer = await childRecord("explore-2");
    assert.equal(typeof explorer.deletedAt, "number", "reported once, then removed");
    const saved = await fs.readFile(path.join(project.contextRoot, "internal", "explore", "explore-2.md"), "utf8");
    assert.match(saved, /Question: Where is checkout\?[\s\S]*## Answer\n\nCheckout lives in src\/checkout\.js/);
    await orchestratorIdle("after the slow explorer");
  } finally {
    setExploreWaitForTests(null);
  }
});

test("separate questions run as explorers working at the same time on one base commit", async () => {
  const tax = gated(text(["Tax is computed in src/tax.js."]));
  const shipping = gated(text(["Shipping has no code yet."]));
  script("explore-3", tax.responder);
  script("explore-4", shipping.responder);
  const call = executeProjectOrchestratorTool(project.id, "project_explore", {
    repo: "shop",
    questions: ["Where is tax computed?", "Where is shipping computed?"],
  });
  // Both are asked before either may answer: sequential explorers would time out here.
  await waitFor(
    "both explorers at work",
    async () => [requestsFor("explore-3").length, requestsFor("explore-4").length],
    (counts) => counts.every((count) => count > 0)
  );
  shipping.release();
  tax.release();
  const output = await call;
  const [taxPart, shippingPart] = output.split("\n\n---\n\n");
  assert.equal(
    taxPart,
    'Explorer explore-3 answered "Where is tax computed?" (saved to internal/explore/explore-3.md):\n\nTax is computed in src/tax.js.'
  );
  assert.equal(
    shippingPart,
    'Explorer explore-4 answered "Where is shipping computed?" (saved to internal/explore/explore-4.md):\n\nShipping has no code yet.'
  );
  const record = await readProject(project.id);
  const explorers = record!.children.filter((child) => child.name === "explore-3" || child.name === "explore-4");
  assert.equal(explorers.length, 2);
  for (const explorer of explorers) {
    assert.equal(explorer.baseSha, SHOP_HEAD);
    assert.equal(typeof explorer.deletedAt, "number");
    await assert.rejects(fs.access(explorer.worktreePath!));
  }
  assert.notEqual(explorers[0]!.worktreePath, explorers[1]!.worktreePath);
  await assert.rejects(
    executeProjectOrchestratorTool(project.id, "project_explore", { repo: "shop", questions: ["a", "b", "c", "d", "e"] }),
    /at most 4 questions/
  );
});

test("an explorer that answers just after the wait ends still reports, exactly once", async () => {
  // The wait looks once, before the answer; the hand-off comes after the
  // watcher has already seen the finished turn while reports were held back.
  setExploreWaitForTests(100, { pollMs: 5_000 });
  const late = gated(text(["Payments are in src/pay.js."]));
  script("explore-5", late.responder);
  try {
    const call = executeProjectOrchestratorTool(project.id, "project_explore", {
      repo: "shop",
      question: "Where are payments handled?",
    });
    await firstRequest("explore-5");
    late.release();
    await waitFor(
      "the watcher to see the finished turn with reports held back",
      () => childRecord("explore-5"),
      (child) => child.suppressReports && child.lastStatus === "idle" && child.lastReportedSeq > 0
    );
    const output = await call;
    assert.match(output, /^Explorer explore-5 is still working/);
    await updateDelivered("explore-5", /Payments are in src\/pay\.js/);
    await orchestratorIdle("after the late explorer");
    const updates = eventsOfKind((await orchestrator()).events, "user_message").filter((event) =>
      parseProjectNoticeNames(event.displayContent).includes("explore-5")
    );
    assert.equal(updates.length, 1);
    assert.equal(typeof (await childRecord("explore-5")).deletedAt, "number");
    await fs.access(path.join(project.contextRoot, "internal", "explore", "explore-5.md"));
  } finally {
    setExploreWaitForTests(null);
  }
});

test("agent names are never reused, even when creations overlap", async () => {
  type Created = { agent: { name: string } };
  const [first, second] = await Promise.all([
    api<Created>("POST", `/api/projects/${project.id}/agents`, { name: "dup", instructions: "First." }),
    api<Created>("POST", `/api/projects/${project.id}/agents`, { name: "dup", instructions: "Second." }),
  ]);
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(second.status, 201, JSON.stringify(second.json));
  assert.deepEqual([first.json.agent.name, second.json.agent.name].sort(), ["dup", "dup-2"]);
  await updateDelivered("dup");
  await updateDelivered("dup-2");
  assert.equal((await api("DELETE", `/api/projects/${project.id}/agents/dup`)).status, 200);
  const third = await api<Created>("POST", `/api/projects/${project.id}/agents`, { name: "dup", instructions: "Third." });
  assert.equal(third.json.agent.name, "dup-3", "a deleted agent's name stays taken");
  await updateDelivered("dup-3");
  const renamed = await api<Created>("PATCH", `/api/projects/${project.id}/agents/dup-3`, { name: "dup" });
  assert.equal(renamed.json.agent.name, "dup-4");
  await orchestratorIdle("after the name checks");
});

test("preferences persist across Projects and reach the coordinator and every agent", async () => {
  const added = JSON.parse(
    await executeProjectOrchestratorTool(project.id, "project_preferences", {
      action: "add",
      text: "Always write tests with node:test.",
    })
  ) as { preferences: string[] };
  assert.deepEqual(added.preferences, ["Always write tests with node:test."]);
  await executeProjectOrchestratorTool(project.id, "project_preferences", { action: "add", text: "always write tests with node:test." });
  const file = await fs.readFile(getPreferencesPath(), "utf8");
  assert.equal((file.match(/node:test/g) ?? []).length, 1, "duplicates are not added");
  const reminder = await buildProjectOrchestratorReminder(project.id, { dateLabel: "today", modelName: "m" });
  assert.match(reminder, /<user_preferences>\n- Always write tests with node:test\.\n<\/user_preferences>/);

  script("docs", text(["Docs done."]));
  await api("POST", `/api/projects/${project.id}/agents`, { name: "docs", repo: "shop", instructions: "Write docs." });
  const brief = await firstRequest("docs");
  assert.match(brief, /The user's preferences \(follow them\)\n- Always write tests with node:test\./);

  const other = await api<ProjectSnapshot>("POST", "/api/projects", { name: "Another", modelId: MODEL_ID });
  const otherReminder = await buildProjectOrchestratorReminder(other.json.id, { dateLabel: "today", modelName: "m" });
  assert.match(otherReminder, /- Always write tests with node:test\./, "preferences apply to every Project");
  const route = await api<{ lines: string[] }>("GET", "/api/projects/preferences");
  assert.deepEqual(route.json.lines, ["Always write tests with node:test."]);

  const removed = JSON.parse(
    await executeProjectOrchestratorTool(project.id, "project_preferences", { action: "remove", text: "node:test" })
  ) as { removed: string[]; preferences: string[] };
  assert.deepEqual(removed.removed, ["Always write tests with node:test."]);
  assert.deepEqual(removed.preferences, []);
  await assert.rejects(
    executeProjectOrchestratorTool(project.id, "project_preferences", { action: "remove", text: "nothing like this" }),
    /No preference mentions/
  );
  assert.equal((await api("DELETE", `/api/projects/${other.json.id}`)).status, 200);
  await updateDelivered("docs", /Docs done\./);
  await orchestratorIdle("after docs");
});

test("the decision log's tail reaches the coordinator every turn", async () => {
  await executeProjectOrchestratorTool(project.id, "project_context_write", {
    path: "docs/decisions.md",
    content: "# Decisions\n\n- 2026-09-27: Totals multiply price by quantity (the explorer found items.length).\n",
  });
  const reminder = await buildProjectOrchestratorReminder(project.id, { dateLabel: "today", modelName: "m" });
  assert.match(reminder, /<project_decisions path="docs\/decisions\.md">\n# Decisions\n\n- 2026-09-27: Totals multiply price by quantity/);
});

test("a message typed while the coordinator is busy reaches its running turn, ahead of queued agent updates", async () => {
  const before = requestsFor("orchestrator").length;
  const hold = gated(toolCall("call_hold", "project_list_agents", {}));
  script("orchestrator", hold.responder, text(["Prioritizing tests."]), text(["Update noted."]));
  await prompt("Hold on a second.");
  await waitFor("the coordinator at the model", async () => requestsFor("orchestrator"), (list) => list.length > before);
  await deliverProjectNotice((await readProject(project.id))!, [
    { name: "cart-total", event: "finished", status: "idle", detail: "Another pass done." },
  ]);
  await prompt("Actually, prioritize the tests.");
  const queued = (await orchestrator()).conversation.queuedPrompts;
  assert.deepEqual(
    queued.map((entry) => (entry.coalesceKey ? "notice" : entry.text)),
    ["Actually, prioritize the tests.", "notice"],
    "the user's message waits in view, ahead of the queued update"
  );
  hold.release();
  const snapshot = await orchestratorIdle("queue drained");
  const requests = requestsFor("orchestrator").slice(before);
  assert.equal(requests.length, 3, "the held turn, its next step, and the update");
  const nextStep = requests[1]!.messages;
  assert.ok(nextStep.some((message) => message.role === "tool" && message.tool_call_id === "call_hold"));
  assert.ok(
    nextStep.some(
      (message) =>
        message.role === "user" &&
        messageText(message).startsWith("[Steering message - sent while you were working on this turn]") &&
        messageText(message).includes("Actually, prioritize the tests.")
    ),
    "the coordinator read it at its next step, in the same turn"
  );
  assert.ok(requests[2]!.messages.some((message) => messageText(message).includes("<project_agent_updates>")));
  const users = eventsOfKind(snapshot.events, "user_message").map((event) => event.displayContent ?? event.content);
  const at = users.indexOf("Actually, prioritize the tests.");
  assert.equal(users.filter((entry) => entry === "Actually, prioritize the tests.").length, 1, "delivered once");
  assert.deepEqual(users.slice(at - 1, at + 2), [
    "Hold on a second.",
    "Actually, prioritize the tests.",
    "Agent update · cart-total",
  ]);
});

test("a queued message the user removes before the coordinator's next step never reaches it", async () => {
  const before = requestsFor("orchestrator").length;
  const hold = gated(toolCall("call_hold_again", "project_list_agents", {}));
  script("orchestrator", hold.responder, text(["Carrying on."]));
  await prompt("Start something.");
  await waitFor("the coordinator at the model", async () => requestsFor("orchestrator"), (list) => list.length > before);
  await prompt("Never mind this one.");
  const entry = (await orchestrator()).conversation.queuedPrompts.find((item) => item.text === "Never mind this one.");
  assert.ok(entry, "it waits in the queue");
  const workspace = await getWorkspaceById(project.orchestrator.workspaceId);
  await agentRuntimeManager.removeQueuedPrompt(workspace!, project.orchestrator.conversationId, entry.id);
  hold.release();
  const snapshot = await orchestratorIdle("after the removed message");
  const requests = requestsFor("orchestrator").slice(before);
  assert.equal(requests.length, 2, "the turn went on without it, and it never ran on its own");
  assert.ok(!requests.some((request) => request.messages.some((message) => messageText(message).includes("Never mind this one."))));
  assert.ok(
    !eventsOfKind(snapshot.events, "user_message").some((event) =>
      (event.displayContent ?? event.content).includes("Never mind this one.")
    )
  );
});

test("agents act without asking by default; with approvals on, a command waits for the user", async () => {
  script("runner", toolCall("call_ls", "terminal", { command: "ls" }), text(["Listed the files."]));
  const created = await api("POST", `/api/projects/${project.id}/agents`, {
    name: "runner",
    repo: "shop",
    instructions: "List the files.",
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const runner = await childRecord("runner");
  const ran = await waitFor(
    "the runner's command to run",
    () => readConversationSnapshot(runner.workspaceId, runner.conversationId),
    (snapshot) =>
      snapshot.conversation.status === "idle" &&
      eventsOfKind(snapshot.events, "tool_call_update").some(
        (event) => event.toolCallId === "call_ls" && event.status === "completed"
      ),
    30_000
  );
  assert.equal(eventsOfKind(ran.events, "permission_request").length, 0, "nobody was asked");
  assert.ok(
    eventsOfKind(ran.events, "status").some((event) => /this Project's agents act without asking/.test(event.detail ?? ""))
  );
  await updateDelivered("runner", /Listed the files/);

  assert.equal((await api("PATCH", `/api/projects/${project.id}`, { settings: { autoApproveAgents: false } })).status, 200);
  try {
    script("careful", toolCall("call_ls_careful", "terminal", { command: "ls" }), text(["Done."]));
    await api("POST", `/api/projects/${project.id}/agents`, { name: "careful", repo: "shop", instructions: "List the files." });
    const careful = await childRecord("careful");
    await waitFor(
      "the command to wait for the user",
      () => readConversationRecord(careful.workspaceId, careful.conversationId),
      (record) => record.status === "awaiting_permission"
    );
    await updateDelivered("careful", /Permission request/);
    assert.equal((await api("DELETE", `/api/projects/${project.id}/agents/careful`)).status, 200);
  } finally {
    await api("PATCH", `/api/projects/${project.id}`, { settings: { autoApproveAgents: true } });
  }
  await orchestratorIdle("after the approval checks");
});

test("an agent writes into the Project context with its file tools; other paths outside its worktree stay refused", async () => {
  const outside = path.join(TEST_DATA_DIR, "outside-the-worktree.txt");
  script(
    "scribe",
    toolCall("call_findings", "write_file", {
      path: path.join(project.contextRoot, "internal", "scribe", "findings.md"),
      content: "The cart total needed quantities.\n",
    }),
    toolCall("call_outside", "write_file", { path: outside, content: "nope" }),
    text(["Findings saved."])
  );
  await api("POST", `/api/projects/${project.id}/agents`, { name: "scribe", repo: "shop", instructions: "Save your findings." });
  const scribe = await childRecord("scribe");
  const done = await waitFor(
    "the scribe's turn",
    () => readConversationSnapshot(scribe.workspaceId, scribe.conversationId),
    (snapshot) => snapshot.conversation.status === "idle" && toolFinished(snapshot.events, "call_outside"),
    30_000
  );
  assert.equal(
    await fs.readFile(path.join(project.contextRoot, "internal", "scribe", "findings.md"), "utf8"),
    "The cart total needed quantities.\n"
  );
  assert.match(toolResult(done.events, "call_outside"), /Path escapes workspace/);
  await assert.rejects(fs.access(outside));
  await updateDelivered("scribe", /Findings saved/);
  await orchestratorIdle("after the scribe");
});

test("tool call ids a model repeats across rounds and turns stay distinct, so every message reaches the page", async () => {
  // kimi-k3 numbers calls per response: the same id comes back every round.
  script(
    "orchestrator",
    toolCall("project_message_user:0", "project_message_user", { message: "First update." }),
    toolCall("project_message_user:0", "project_message_user", { message: "Second update." }),
    text(["Sent two updates."])
  );
  await prompt("Give me two updates.");
  await orchestratorIdle("the turn with a repeated id");
  script(
    "orchestrator",
    toolCall("project_message_user:0", "project_message_user", { message: "Third update." }),
    text(["Sent a third."])
  );
  await prompt("And one more.");
  const snapshot = await orchestratorIdle("the next turn with the same id");
  const ids = eventsOfKind(snapshot.events, "tool_call")
    .filter((event) => event.toolCallId.startsWith("project_message_user:0"))
    .map((event) => event.toolCallId);
  assert.deepEqual(ids, ["project_message_user:0", "project_message_user:0~2", "project_message_user:0~3"]);
  assert.deepEqual(
    [...collectProjectMessageCalls(snapshot.events).values()].map((call) => call.message).slice(-3),
    ["First update.", "Second update.", "Third update."]
  );
  const history = requestsFor("orchestrator").at(-1)!.messages;
  const called = history.flatMap((message) =>
    Array.isArray(message.tool_calls) ? (message.tool_calls as Array<{ id?: string }>).map((call) => call.id) : []
  );
  const answered = history.filter((message) => message.role === "tool").map((message) => message.tool_call_id);
  for (const id of ids) {
    assert.ok(called.includes(id) && answered.includes(id), `the model sees ${id} called and answered`);
  }
});

test("a browser check runs an agent's branch, reports with evidence, and never takes the worktree with it", async () => {
  script("browser-check", text(["Checked the cart: total 5 for 2+3 items. Screenshot: media/browser-check/cart.png"]));
  script("orchestrator", text(["The browser check passed."]));
  const started = JSON.parse(
    await executeProjectOrchestratorTool(project.id, "project_browser_check", {
      what: "The cart shows 5 for quantities 2 and 3.",
      agent: "cart-total",
    })
  ) as { started: string; evidence: string };
  assert.equal(started.started, "browser-check");
  assert.equal(started.evidence, path.join(project.contextRoot, "media", "browser-check"));
  await fs.access(started.evidence);
  const helper = await childRecord("browser-check");
  const worker = await childRecord("cart-total");
  assert.equal(helper.helperKind, "browser");
  assert.equal(helper.workspaceId, worker.workspaceId, "it runs in the agent's working tree");
  assert.equal(helper.mode, "agent");
  const brief = await firstRequest("browser-check");
  assert.match(brief, /a QA tester with a real browser/);
  assert.match(brief, /agent cart-total's working tree at .+ \(branch `cesium\/checkout-revamp\/cart-total-[0-9a-f]{4}`\)/);
  assert.match(brief, /call_mcp_tool on server "browser"/);
  assert.ok(brief.includes(started.evidence), "evidence goes to the Project's media folder");
  await updateDelivered("browser-check", /Checked the cart/);
  await orchestratorIdle("after the browser check");
  const rail = await buildAgentConversationsAllPayload({ limit: 200, offset: 0 });
  assert.equal(
    rail.groups.some((group) => group.conversations.some((conversation) => conversation.id === helper.conversationId)),
    false,
    "helpers stay out of the rail"
  );
  const removed = await api("DELETE", `/api/projects/${project.id}/agents/browser-check`);
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  await fs.access(worker.worktreePath!);
  assert.ok(await getWorkspaceById(worker.workspaceId), "the worker keeps its worktree and workspace");
  const record = await readConversationRecord(worker.workspaceId, worker.conversationId);
  assert.ok(record, "the worker's conversation is untouched");
});
