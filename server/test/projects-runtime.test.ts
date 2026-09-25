import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ProjectSnapshot, ProjectSummary } from "@cesium/core/projects";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";
import {
  messageText,
  startFakeChatModel,
  text,
  toolCall,
  waitFor,
  type Responder,
} from "./helpers/fake-chat-model.js";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-projects-runtime-"));
const REPO_ALPHA = path.join(TEST_DATA_DIR, "repos", "alpha");
const REPO_BETA = path.join(TEST_DATA_DIR, "repos", "beta");
await fs.mkdir(REPO_ALPHA, { recursive: true });
await fs.mkdir(REPO_BETA, { recursive: true });

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
  "CESIUM_ENGINE_LABEL",
]) {
  delete process.env[key];
}
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
process.env.WORKSPACE_ALLOWED_ROOTS = TEST_DATA_DIR;

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
  { formatMidTurnSteer },
  { startProjectWatcher, settleProjectWatcher, kickProjectWatcher },
  { PROJECT_ORCHESTRATOR_SYSTEM_PROMPT, PROJECT_ORCHESTRATOR_TOOLS },
  { readProject },
  { getWorkspaceById, listWorkspaces },
  { buildAgentConversationsAllPayload },
  { createStandaloneChatWorkspace },
] = await Promise.all([
  import("../src/app.js"),
  import("../src/lib/agents/runtime-manager.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/agents/prompt-queue-drain.js"),
  import("../src/lib/agents/cesium-provider.js"),
  import("../src/lib/projects/project-watcher.js"),
  import("../src/lib/projects/orchestrator-tool-definitions.js"),
  import("../src/lib/projects/project-store.js"),
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/rail-payload.js"),
  import("../src/lib/standalone-chats.js"),
]);

const app = createCesiumApp();
startAgentPromptQueueDrainListener();
const stopWatcher = startProjectWatcher();

after(async () => {
  stopWatcher();
  await model.close();
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

function eventsOfKind<K extends AgentStoredEvent["kind"]>(
  events: AgentStoredEvent[],
  kind: K
): Array<Extract<AgentStoredEvent, { kind: K }>> {
  return events.filter((event): event is Extract<AgentStoredEvent, { kind: K }> => event.kind === kind);
}

async function api<T = Record<string, unknown>>(
  method: string,
  pathname: string,
  body?: unknown
): Promise<{ status: number; json: T }> {
  const response = await app.request(pathname, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as T };
}

let project: ProjectSnapshot;

async function orchestratorSnapshot() {
  return readConversationSnapshot(project.orchestrator.workspaceId, project.orchestrator.conversationId);
}

async function orchestratorWorkspace() {
  const workspace = await getWorkspaceById(project.orchestrator.workspaceId);
  assert.ok(workspace);
  return workspace;
}

async function childRecord(name: string) {
  const record = await readProject(project.id);
  const child = record?.children.find((entry) => entry.name === name);
  assert.ok(child, `child ${name} exists`);
  return child;
}

async function childSnapshot(name: string) {
  const child = await childRecord(name);
  return readConversationSnapshot(child.workspaceId, child.conversationId);
}

function noticeMessages(events: AgentStoredEvent[]) {
  return eventsOfKind(events, "user_message").filter((event) =>
    event.displayContent?.startsWith("Agent update · ")
  );
}

async function waitForOrchestratorIdle(label: string) {
  return waitFor(
    label,
    orchestratorSnapshot,
    (snapshot) =>
      snapshot.conversation.status === "idle" && snapshot.conversation.queuedPrompts.length === 0
  );
}

async function promptOrchestrator(textValue: string) {
  await agentRuntimeManager.promptConversation(
    await orchestratorWorkspace(),
    project.orchestrator.conversationId,
    textValue
  );
}

function toolResult(events: AgentStoredEvent[], toolCallId: string): string {
  const update = eventsOfKind(events, "tool_call_update").find(
    (event) => event.toolCallId === toolCallId && event.status !== "in_progress"
  );
  assert.ok(update, `tool ${toolCallId} finished`);
  return update.detail ?? "";
}

async function waitForTool(toolCallId: string) {
  const snapshot = await waitFor(
    `tool ${toolCallId}`,
    orchestratorSnapshot,
    (value) =>
      eventsOfKind(value.events, "tool_call_update").some(
        (event) => event.toolCallId === toolCallId && event.status !== "in_progress"
      )
  );
  return toolResult(snapshot.events, toolCallId);
}

test("Projects routes answer 404 projects_disabled while the Beta flag is off", async () => {
  const list = await api("GET", "/api/projects");
  assert.equal(list.status, 404);
  assert.equal(list.json.code, "projects_disabled");
  const create = await api("POST", "/api/projects", { name: "Nope" });
  assert.equal(create.status, 404);
  assert.equal(create.json.code, "projects_disabled");
  await kickProjectWatcher();
  process.env.CESIUM_PROJECTS_ENABLED = "1";
});

test("creating a multi-repo Project provisions a hidden cesium-agent orchestrator", async () => {
  const created = await api<ProjectSnapshot>("POST", "/api/projects", {
    name: "Launch",
    modelId: MODEL_ID,
    repos: [{ root: REPO_ALPHA }, { root: REPO_BETA, name: "web" }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  project = created.json;
  assert.match(project.id, /^prj_[a-f0-9]{12}$/);
  assert.deepEqual(project.repos.map((repo) => repo.name), ["alpha", "web"]);
  assert.equal(project.orchestrator.modelId, MODEL_ID);

  const patched = await api<ProjectSnapshot>("PATCH", `/api/projects/${project.id}`, {
    settings: { defaultChildModelId: MODEL_ID, maxActiveChildren: 99 },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.settings.defaultChildModelId, MODEL_ID);
  assert.equal(patched.json.settings.maxActiveChildren, 32, "limits are clamped");
  project = patched.json;

  const orchestrator = await readConversationRecord(
    project.orchestrator.workspaceId,
    project.orchestrator.conversationId
  );
  assert.ok(orchestrator);
  assert.equal(orchestrator.config.backendId, "cesium-agent");
  assert.equal(orchestrator.title, "Launch");
  assert.deepEqual(
    orchestrator.origin && { kind: orchestrator.origin.kind, projectId: "projectId" in orchestrator.origin ? orchestrator.origin.projectId : null },
    { kind: "project-orchestrator", projectId: project.id }
  );

  const workspace = await orchestratorWorkspace();
  assert.equal(workspace.kind, "project");
  assert.equal(workspace.root, project.contextRoot);
  const rail = await buildAgentConversationsAllPayload({ limit: 50, offset: 0 });
  assert.equal(
    rail.groups.some((group) => group.workspace.id === workspace.id),
    false,
    "the Project context folder is not a rail group"
  );
  assert.equal(
    rail.groups.some((group) =>
      group.conversations.some((conversation) => conversation.id === project.orchestrator.conversationId)
    ),
    false,
    "the orchestrator never shows in the rail"
  );

  const context = await api<{ files: Array<{ path: string }> }>("GET", `/api/projects/${project.id}/context`);
  assert.deepEqual(context.json.files.map((file) => file.path), ["notes.md"]);

  const duplicate = await api("POST", `/api/projects/${project.id}/repos`, { root: REPO_ALPHA });
  assert.equal(duplicate.status, 409);
  const sandbox = await createStandaloneChatWorkspace("scratch");
  const sandboxRepo = await api("POST", `/api/projects/${project.id}/repos`, { workspaceId: sandbox.id });
  assert.equal(sandboxRepo.status, 400);
  assert.match(String(sandboxRepo.json.error), /cannot be added as repositories/);

  const listed = await api<{ projects: ProjectSummary[] }>("GET", "/api/projects");
  assert.deepEqual(
    listed.json.projects.map((entry) => [
      entry.id,
      entry.repoCount,
      entry.orchestratorConversationId,
      entry.orchestratorWorkspaceId,
      entry.turnsCompleted,
    ]),
    [[project.id, 2, project.orchestrator.conversationId, workspace.id, 0]]
  );
});

test("the orchestrator gets only the Project tools, its own prompt and the Project state", async () => {
  script("orchestrator", text(["Ready to plan."]));
  await promptOrchestrator("What can you do?");
  const snapshot = await waitForOrchestratorIdle("first orchestrator turn");
  const request = requestsFor("orchestrator").at(-1)!;
  const toolNames = (request.tools ?? []).map((tool) => tool.function?.name).sort();
  assert.deepEqual(
    toolNames,
    [...PROJECT_ORCHESTRATOR_TOOLS.map((tool) => tool.name), "ask_question"].sort(),
    "exactly the Project tool set plus ask_question"
  );
  const allText = request.messages.map(messageText).join("\n\n");
  assert.ok(allText.includes(PROJECT_ORCHESTRATOR_SYSTEM_PROMPT), "orchestrator system prompt");
  assert.doesNotMatch(allText, /<harness-features>/, "no ordinary mode reminder");
  assert.match(allText, /<project>\nProject: Launch/);
  assert.match(allText, /Engines:\n- home: .+ \(this engine\)\n\nRepositories:/);
  assert.match(allText, /- alpha \(id rep_[a-f0-9]{8}, engine home\)/);
  assert.match(allText, /- web \(id rep_[a-f0-9]{8}, engine home\)/);
  assert.match(allText, /<project_notes path="notes.md">\n# Launch/);
  assert.equal(snapshot.conversation.title, "Launch", "title generation leaves the Project name alone");
  const files = await fs.readdir(project.contextRoot);
  assert.deepEqual(files.sort(), ["notes.md"], "no skills mirror in the Project folder");
});

test("orchestrator calls to ordinary tools are refused", async () => {
  script(
    "orchestrator",
    toolCall("call_terminal", "terminal", { command: "ls" }),
    text(["Understood, I will delegate."])
  );
  await promptOrchestrator("Just run ls yourself.");
  const snapshot = await waitForOrchestratorIdle("refused tool turn");
  assert.match(toolResult(snapshot.events, "call_terminal"), /not available to a Project orchestrator/);
});

test("a child created by the orchestrator runs in its repo and reports back as an orchestrator turn", async () => {
  script("api", text(["API scaffolded with ", "three routes."]));
  script(
    "orchestrator",
    toolCall("call_create_api", "project_create_agent", {
      name: "API",
      repo: "alpha",
      instructions: "Scaffold the API.",
    }),
    text(["Started api."]),
    text(["api finished; next up is the web app."])
  );
  await promptOrchestrator("Build the API.");
  const created = JSON.parse(await waitForTool("call_create_api")) as {
    created: { name: string; repo: string; harness: string };
  };
  assert.equal(created.created.name, "api");
  assert.equal(created.created.repo, "alpha");
  assert.equal(created.created.harness, "cesium-agent");

  const snapshot = await waitFor(
    "api notice turn",
    orchestratorSnapshot,
    (value) =>
      value.conversation.status === "idle" &&
      noticeMessages(value.events).some((event) => event.displayContent === "Agent update · api")
  );
  const notices = noticeMessages(snapshot.events);
  assert.equal(notices.length, 1, "one finished turn, one notice");
  assert.match(notices[0]!.content, /<agent name="api" event="finished" status="idle">\nAPI scaffolded with three routes\.\n<\/agent>/);
  assert.match(
    messageText(requestsFor("orchestrator").at(-1)!.messages.at(-1)),
    /<project_agent_updates>/,
    "the notice is the newest message the orchestrator sees"
  );

  const child = await childRecord("api");
  const alpha = project.repos.find((repo) => repo.name === "alpha")!;
  assert.equal(child.workspaceId, alpha.workspaceId);
  assert.equal(child.repoId, alpha.id);
  assert.equal(child.turnsCompleted, 1);
  assert.equal(child.lastReplyPreview, "API scaffolded with three routes.");
  const conversation = await childSnapshot("api");
  assert.ok(conversation);
  assert.equal(conversation.conversation.title, "api");
  assert.equal(child.lastReportedSeq, conversation.conversation.lastEventSeq);
  const firstUser = eventsOfKind(conversation.events, "user_message")[0]!;
  assert.equal(firstUser.displayContent, "Scaffold the API.");
  assert.match(firstUser.content, /<project_brief>[\s\S]*You are "api"[\s\S]*Scaffold the API\.$/);
});

test("steer lands mid-turn on a busy child and queued work runs as its next turn", async () => {
  script(
    "web",
    toolCall("call_web_wait", "wait", { seconds: 2, reason: "long build" }),
    text(["Web built with dark mode."]),
    text(["Docs written."])
  );
  script(
    "orchestrator",
    toolCall("call_create_web", "project_create_agent", {
      name: "web",
      repo: "web",
      instructions: "Build the web app.",
    }),
    text(["Started web."])
  );
  await promptOrchestrator("Build the web app.");
  await waitForTool("call_create_web");
  await waitFor(
    "web wait tool",
    () => childSnapshot("web"),
    (value) => eventsOfKind(value.events, "tool_call").some((event) => event.toolCallId === "call_web_wait")
  );
  await waitForOrchestratorIdle("orchestrator idle before steering");

  script(
    "orchestrator",
    toolCall("call_steer_web", "project_steer_agent", { agent: "web", message: "Add dark mode." }),
    toolCall("call_queue_web", "project_queue_agent", { agent: "web", message: "Then write docs." }),
    text(["Steered web and queued docs."])
  );
  await promptOrchestrator("Web needs dark mode, then docs.");
  assert.deepEqual(JSON.parse(await waitForTool("call_steer_web")), { agent: "web", delivery: "mid_turn" });
  assert.deepEqual(JSON.parse(await waitForTool("call_queue_web")), { agent: "web", delivery: "queued" });

  await waitFor(
    "web queue to drain",
    () => childSnapshot("web"),
    (value) =>
      value.conversation.status === "idle" &&
      value.conversation.queuedPrompts.length === 0 &&
      eventsOfKind(value.events, "assistant_message_chunk").some((event) => event.text.includes("Docs written"))
  );
  const webRequests = requestsFor("web");
  assert.equal(webRequests.length, 3);
  assert.equal(messageText(webRequests[1]!.messages.at(-1)), formatMidTurnSteer("Add dark mode."));
  assert.match(messageText(webRequests[2]!.messages.at(-1)), /Then write docs\./);

  const final = await waitFor(
    "web reports settled",
    orchestratorSnapshot,
    (value) =>
      value.conversation.status === "idle" &&
      value.conversation.queuedPrompts.length === 0 &&
      noticeMessages(value.events).some((event) => event.content.includes("Docs written."))
  );
  const webNotices = noticeMessages(final.events).filter((event) => event.content.includes('name="web"'));
  assert.ok(webNotices.length >= 1 && webNotices.length <= 2, "each web turn reported at most once");
  const child = await childRecord("web");
  assert.equal(child.turnsCompleted, 2);
  assert.equal(child.lastReplyPreview, "Docs written.");
  const listed = await api<{ projects: ProjectSummary[] }>("GET", "/api/projects");
  const summary = listed.json.projects.find((entry) => entry.id === project.id);
  assert.ok(summary && summary.turnsCompleted >= 2, "the summary counts finished child turns");
});

test("reports from children that finish while the orchestrator is busy coalesce into one turn", async () => {
  script("orchestrator", text(["Thinking ", "about ", "the plan ", "slowly."], { delayMs: 700 }));
  script("one", text(["One done."]));
  script("two", text(["Two done."]));
  await promptOrchestrator("Think for a while.");
  await waitFor("orchestrator busy", orchestratorSnapshot, (value) => value.conversation.status === "running");
  const first = await api("POST", `/api/projects/${project.id}/agents`, { name: "one", instructions: "Do one." });
  const second = await api("POST", `/api/projects/${project.id}/agents`, { name: "two", instructions: "Do two." });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(second.status, 201, JSON.stringify(second.json));

  const queued = await waitFor(
    "coalesced notice queued",
    orchestratorSnapshot,
    (value) => {
      const entry = value.conversation.queuedPrompts[0];
      return Boolean(entry?.text.includes('name="one"') && entry.text.includes('name="two"'));
    }
  );
  assert.equal(queued.conversation.status, "running", "still busy with the slow turn");
  assert.equal(queued.conversation.queuedPrompts.length, 1, "one queued turn for both reports");
  assert.equal(queued.conversation.queuedPrompts[0]!.coalesceKey, `project-notice:${project.id}`);

  const drained = await waitForOrchestratorIdle("coalesced notice drained");
  const combined = noticeMessages(drained.events).filter(
    (event) => event.content.includes('name="one"') && event.content.includes('name="two"')
  );
  assert.equal(combined.length, 1);
  assert.match(combined[0]!.displayContent ?? "", /^Agent update · (one, two|two, one)$/);
});

test("a report queued behind an orchestrator turn that fails upstream still reaches it", async () => {
  const upstreamOutage: Responder = async (_request, res) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: "All routes failed", type: "service_unavailable" } }));
  };
  script("orchestrator", upstreamOutage, text(["Picked up the late report."]));
  script("late", text(["Late work done."]));
  await promptOrchestrator("Plan the next step.");
  await waitFor("orchestrator busy", orchestratorSnapshot, (value) => value.conversation.status === "running");
  const created = await api("POST", `/api/projects/${project.id}/agents`, {
    name: "late",
    instructions: "Do the late work.",
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  await waitFor("report queued behind the failing turn", orchestratorSnapshot, (value) =>
    value.conversation.queuedPrompts.some((entry) => entry.text.includes('name="late"'))
  );

  const recovered = await waitFor("report delivered after the failure", orchestratorSnapshot, (value) =>
    value.conversation.status === "idle" &&
    value.conversation.queuedPrompts.length === 0 &&
    eventsOfKind(value.events, "assistant_message_chunk").some((event) =>
      event.text.includes("Picked up the late report.")
    )
  );
  const failedAt = recovered.events.findIndex(
    (event) => event.kind === "status" && event.status === "failed"
  );
  const reportAt = recovered.events.findIndex(
    (event) =>
      event.kind === "user_message" &&
      event.displayContent === "Agent update · late"
  );
  assert.ok(failedAt >= 0, "the first turn failed upstream");
  assert.ok(reportAt > failedAt, "the queued report ran as the next turn without a human prompt");
  const removed = await api("DELETE", `/api/projects/${project.id}/agents/late`);
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
});

test("stopping a busy child is silent, and a human turn in the child reports again", async () => {
  script("slow", toolCall("call_slow_wait", "wait", { seconds: 5, reason: "slow work" }));
  const created = await api("POST", `/api/projects/${project.id}/agents`, {
    name: "slow",
    instructions: "Take your time.",
  });
  assert.equal(created.status, 201);
  await waitFor(
    "slow wait tool",
    () => childSnapshot("slow"),
    (value) => eventsOfKind(value.events, "tool_call").some((event) => event.toolCallId === "call_slow_wait")
  );
  const noticeCount = noticeMessages((await orchestratorSnapshot())!.events).length;

  const stopped = await api<{ stopped: boolean; status: string }>(
    "POST",
    `/api/projects/${project.id}/agents/slow/stop`
  );
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.stopped, true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await settleProjectWatcher();
  const afterStop = await orchestratorSnapshot();
  assert.equal(noticeMessages(afterStop!.events).length, noticeCount, "no notice for a stop the orchestrator caused");
  assert.equal(
    afterStop!.conversation.queuedPrompts.some((entry) => entry.text.includes('name="slow"')),
    false
  );
  const suppressed = await childRecord("slow");
  assert.equal(suppressed.suppressReports, true);
  assert.equal(typeof suppressed.suppressedThroughSeq, "number");

  const idleAgain = await api<{ stopped: boolean }>("POST", `/api/projects/${project.id}/agents/slow/stop`);
  assert.equal(idleAgain.json.stopped, false, "stopping an idle child is a no-op");

  script("slow", text(["Continued by a human."]));
  const child = await childRecord("slow");
  const childWorkspace = await getWorkspaceById(child.workspaceId);
  assert.ok(childWorkspace);
  await agentRuntimeManager.promptConversation(childWorkspace, child.conversationId, "Please continue.");
  const reported = await waitFor(
    "human turn reported",
    orchestratorSnapshot,
    (value) =>
      value.conversation.status === "idle" &&
      noticeMessages(value.events).some((event) => event.content.includes("Continued by a human."))
  );
  assert.ok(reported);
  const resumed = await childRecord("slow");
  assert.equal(resumed.suppressReports, false);
  assert.equal(resumed.suppressedThroughSeq, null);
});

test("rename, transcript, delete and context tools work from the orchestrator", async () => {
  await waitForOrchestratorIdle("idle before management tools");
  const before = noticeMessages((await orchestratorSnapshot())!.events).length;
  script(
    "orchestrator",
    toolCall("call_rename", "project_update_agent", { agent: "api", name: "Backend" }),
    toolCall("call_transcript", "project_read_transcript", { agent: "backend", turns: 2 }),
    toolCall("call_delete", "project_delete_agent", { agent: "one" }),
    toolCall("call_list", "project_list_agents", {}),
    toolCall("call_steer_deleted", "project_steer_agent", { agent: "one", message: "hello?" }),
    toolCall("call_notes", "project_context_write", {
      path: "notes.md",
      content: "# Launch\n\n- backend: API done\n- web: done",
    }),
    toolCall("call_bad_path", "project_context_write", { path: "../escape.md", content: "no" }),
    text(["Housekeeping done."])
  );
  await promptOrchestrator("Tidy up.");
  const snapshot = await waitForOrchestratorIdle("management turn");

  const renamed = JSON.parse(toolResult(snapshot.events, "call_rename")) as { updated: { name: string } };
  assert.equal(renamed.updated.name, "backend");
  const backend = await childRecord("backend");
  assert.equal((await readConversationRecord(backend.workspaceId, backend.conversationId))?.title, "backend");

  const transcript = toolResult(snapshot.events, "call_transcript");
  assert.match(transcript, /^Agent backend \(status: idle\)/);
  assert.match(transcript, /User: Scaffold the API\./);
  assert.match(transcript, /Assistant: API scaffolded with three routes\./);

  assert.deepEqual(JSON.parse(toolResult(snapshot.events, "call_delete")), { agent: "one", deleted: true });
  const one = (await readProject(project.id))!.children.find((entry) => entry.name === "one")!;
  assert.ok(one.deletedAt);
  assert.equal(await readConversationRecord(one.workspaceId, one.conversationId), null);
  assert.equal(await getWorkspaceById(one.workspaceId), null, "the scratch folder is removed with the child");

  const listed = JSON.parse(toolResult(snapshot.events, "call_list")) as { agents: Array<{ name: string }> };
  assert.deepEqual(listed.agents.map((agent) => agent.name).sort(), ["backend", "slow", "two", "web"]);
  assert.match(toolResult(snapshot.events, "call_steer_deleted"), /Agent "one" was deleted/);
  assert.match(toolResult(snapshot.events, "call_bad_path"), /not allowed/);

  const notes = await api<{ content: string }>(
    "GET",
    `/api/projects/${project.id}/context/file?path=notes.md`
  );
  assert.match(notes.json.content, /- backend: API done/);

  script("orchestrator", text(["Noted."]));
  await promptOrchestrator("Status?");
  await waitForOrchestratorIdle("status turn");
  const reminder = requestsFor("orchestrator").at(-1)!.messages.map(messageText).join("\n");
  assert.match(reminder, /- backend: API done/, "the next reminder carries the updated notes");
  assert.match(reminder, /- backend: Idle \(idle\) · cesium-agent/);
  assert.doesNotMatch(reminder, /- one: /, "deleted agents leave the roster");

  await kickProjectWatcher();
  await settleProjectWatcher();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await settleProjectWatcher();
  const afterKick = await waitForOrchestratorIdle("idle after restart check");
  assert.equal(
    noticeMessages(afterKick.events).length,
    before,
    "re-checking every child (as on engine restart) re-reports nothing"
  );
});

test("the working-agent limit and bad agent input are rejected", async () => {
  await api("PATCH", `/api/projects/${project.id}`, { settings: { maxActiveChildren: 1 } });
  script("busy", toolCall("call_busy_wait", "wait", { seconds: 5, reason: "occupy the slot" }));
  const busy = await api("POST", `/api/projects/${project.id}/agents`, { name: "busy", instructions: "Stay busy." });
  assert.equal(busy.status, 201);
  const blocked = await api("POST", `/api/projects/${project.id}/agents`, { name: "extra", instructions: "More." });
  assert.equal(blocked.status, 409);
  assert.match(String(blocked.json.error), /working agents \(limit 1\)/);
  await api("POST", `/api/projects/${project.id}/agents/busy/stop`);
  await api("PATCH", `/api/projects/${project.id}`, { settings: { maxActiveChildren: 8 } });

  const noName = await api("POST", `/api/projects/${project.id}/agents`, { name: "!!!", instructions: "x" });
  assert.equal(noName.status, 400);
  const badRepo = await api("POST", `/api/projects/${project.id}/agents`, {
    name: "lost",
    repo: "nowhere",
    instructions: "x",
  });
  assert.equal(badRepo.status, 400);
  assert.match(String(badRepo.json.error), /Unknown repository "nowhere"\. Repositories: alpha, web\./);
  const badHarness = await api("POST", `/api/projects/${project.id}/agents`, {
    name: "odd",
    harness: "no-such-harness",
    instructions: "x",
  });
  assert.equal(badHarness.status, 400);
  const missing = await api("GET", `/api/projects/${project.id}/agents/ghost`);
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, "agent_not_found");
});

test("deleting the Project removes its orchestrator and children but keeps the repos", async () => {
  const record = (await readProject(project.id))!;
  const response = await api("DELETE", `/api/projects/${project.id}`);
  assert.equal(response.status, 200);
  assert.equal(
    await readConversationRecord(project.orchestrator.workspaceId, project.orchestrator.conversationId),
    null
  );
  for (const child of record.children) {
    assert.equal(await readConversationRecord(child.workspaceId, child.conversationId), null, child.name);
  }
  assert.equal(await getWorkspaceById(project.orchestrator.workspaceId), null);
  const workspaceIds = new Set((await listWorkspaces()).map((workspace) => workspace.id));
  for (const repo of record.repos) {
    assert.ok(workspaceIds.has(repo.workspaceId), `repo ${repo.name} stays registered`);
  }
  const gone = await api("GET", `/api/projects/${project.id}`);
  assert.equal(gone.status, 404);
  assert.equal(gone.json.code, "project_not_found");
  await assert.rejects(fs.stat(path.dirname(project.contextRoot)));
});
