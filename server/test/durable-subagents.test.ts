import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-durable-subagents-"));
const WORKSPACE_ROOT = path.join(TEST_DATA_DIR, "standalone-chats", "durable");
await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
await fs.writeFile(path.join(WORKSPACE_ROOT, "notes.txt"), "alpha beta\ngamma\n");

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
]) {
  delete process.env[key];
}
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;

type ChatMessage = { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string };
type ChatRequest = { messages: ChatMessage[]; tools?: Array<{ function?: { name: string; parameters?: unknown } }> };
type Responder = (res: ServerResponse) => void;

function messageText(message: ChatMessage | undefined): string {
  return typeof message?.content === "string" ? message.content : "";
}

/** Requests are routed by who sends them: a child's first user message names its path. */
function agentOf(body: ChatRequest): string {
  const first = body.messages.find((message) => message.role === "user" && /You are subagent \/root\/\w+/.test(messageText(message)));
  return first ? /You are subagent (\/root\/\w+)/.exec(messageText(first))![1]! : "parent";
}

const scripts = new Map<string, Responder[]>();
const requests: Array<{ agent: string; body: ChatRequest }> = [];
function script(agent: string, ...responders: Responder[]) {
  scripts.set(agent, [...(scripts.get(agent) ?? []), ...responders]);
}
const modelServer = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "Durable Test" } }] }));
      return;
    }
    const agent = agentOf(body);
    requests.push({ agent, body });
    const responder = scripts.get(agent)?.shift();
    if (!responder) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `no scripted response left for ${agent}` } }));
      return;
    }
    responder(res);
  });
});
await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
process.env.CESIUM_BASE_URL = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`;
process.env.CESIUM_API_KEY = "sk-test-durable";
process.env.CESIUM_PROVIDER_ID = "durablehost";
process.env.CESIUM_DEFAULT_MODEL = "kimi-k3";
const MODEL_ID = "durablehost/kimi-k3";

const [
  { ensureWorkspaceRegistered },
  { agentRuntimeManager },
  { readConversationSnapshot, readConversationEvents, listWorkspaceConversationRecords, updateConversationRecord },
  { patchCesiumAgentSettings },
  { DurableSubagents },
  { defaultHarnessSettings },
  { applyToolRevision, CESIUM_TOOL_REVISION },
] = await Promise.all([
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/runtime-manager.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/cesium-agent-settings.js"),
  import("../src/lib/agents/cesium/features/subagents/durable-children.js"),
  import("../src/lib/agents/cesium/features/limits.js"),
  import("../src/lib/agents/cesium/cesium-tools.js"),
]);

after(async () => {
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "durable");

function sse(res: ServerResponse, payloads: unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const payload of payloads) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}

function toolTurn(id: string, name: string, args: Record<string, unknown>): Responder {
  return (res) =>
    sse(res, [
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
}

function textTurn(text: string): Responder {
  return (res) =>
    sse(res, [
      { choices: [{ index: 0, delta: { content: text } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
}

async function waitForIdle(conversationId: string, turns: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const snapshot = await readConversationSnapshot(workspace.id, conversationId);
    const ended = snapshot?.events.filter((event: AgentStoredEvent) => event.kind === "assistant_message_end").length ?? 0;
    if (snapshot && snapshot.conversation.status === "idle" && ended >= turns) {
      return snapshot;
    }
    if (snapshot?.conversation.status === "failed") {
      throw new Error(`turn failed: ${snapshot.conversation.lastError}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the turn to finish.");
}

function toolNames(body: ChatRequest): string[] {
  return (body.tools ?? []).map((tool) => tool.function?.name ?? "");
}

function assertPureAppend(list: ChatRequest[], label: string) {
  for (let index = 1; index < list.length; index += 1) {
    assert.deepEqual(list[index]!.tools, list[index - 1]!.tools, `${label}: request ${index + 1} keeps the tool list`);
    assert.deepEqual(
      list[index]!.messages.slice(0, list[index - 1]!.messages.length),
      list[index - 1]!.messages,
      `${label}: request ${index + 1} extends request ${index}`
    );
  }
}

async function setSubagentsVersion(version: 1 | 2) {
  await patchCesiumAgentSettings({ harness: { features: { subagents: { version, enabled: true } } } });
}

async function childOf(parentId: string, childPath: string) {
  const records = await listWorkspaceConversationRecords(workspace.id);
  return records.find(
    (record) => record.origin?.kind === "subagent" && record.origin.parentConversationId === parentId && record.origin.path === childPath
  );
}

test("revision 2 has one wait; conversations from before revisions keep their exact tool block", async () => {
  const fresh = await agentRuntimeManager.createConversation(workspace, { backendId: "cesium-agent", modelId: MODEL_ID });
  assert.equal(fresh.config.toolRevision, CESIUM_TOOL_REVISION);
  const legacy = await agentRuntimeManager.createConversation(workspace, { backendId: "cesium-agent", modelId: MODEL_ID });
  await updateConversationRecord(workspace.id, legacy.id, (current) => {
    const { toolRevision: _dropped, ...config } = current.config;
    return { ...current, config };
  });

  script("parent", textTurn("Fresh."), textTurn("Old one."), textTurn("Old two."));
  const before = requests.length;
  await agentRuntimeManager.promptConversation(workspace, fresh.id, "Hello.");
  await waitForIdle(fresh.id, 1);
  await agentRuntimeManager.promptConversation(workspace, legacy.id, "Hello.");
  await waitForIdle(legacy.id, 1);
  await agentRuntimeManager.promptConversation(workspace, legacy.id, "Again.");
  await waitForIdle(legacy.id, 2);
  const [freshRequest, legacyFirst, legacySecond] = requests.slice(before).map((entry) => entry.body);

  const freshTools = toolNames(freshRequest!);
  assert.equal(freshTools.filter((name) => name === "wait").length, 1);
  for (const replaced of ["orchestration_wait", "workflow_await", "wait_agent"]) {
    assert.equal(freshTools.includes(replaced), false, `${replaced} is folded into wait`);
  }
  const wait = freshRequest!.tools!.find((tool) => tool.function?.name === "wait");
  assert.match(JSON.stringify(wait), /"until"/);

  const legacyTools = toolNames(legacyFirst!);
  assert.ok(legacyTools.includes("orchestration_wait") && legacyTools.includes("workflow_await"), "revision 1 keeps its separate waits");
  assert.doesNotMatch(JSON.stringify(legacyFirst!.tools!.find((tool) => tool.function?.name === "wait")), /"until"/);
  assertPureAppend([legacyFirst!, legacySecond!], "revision 1 conversation");

  assert.deepEqual(
    applyToolRevision([{ name: "wait", description: "x", parameters: {} }, { name: "workflow_await", description: "y", parameters: {} }], 1).map((tool) => tool.name),
    ["wait", "workflow_await"]
  );
});

test("spawned subagents are durable child conversations the parent waits on with the one wait", async () => {
  await setSubagentsVersion(2);
  const parent = await agentRuntimeManager.createConversation(workspace, { backendId: "cesium-agent", modelId: MODEL_ID });
  script(
    "parent",
    toolTurn("call_spawn", "spawn_agent", { task_name: "counter", message: "Count the lines in notes.txt.", fork_turns: "none" }),
    toolTurn("call_wait", "wait", { until: "agents", seconds: 20 }),
    textTurn("The child counted two lines.")
  );
  script("/root/counter", toolTurn("child_read", "read_file", { path: "notes.txt" }), textTurn("notes.txt has 2 lines."));
  const parentBefore = requests.filter((entry) => entry.agent === "parent").length;
  await agentRuntimeManager.promptConversation(workspace, parent.id, "Delegate the line count.");
  const first = await waitForIdle(parent.id, 1);

  const child = await childOf(parent.id, "/root/counter");
  assert.ok(child, "the child is a stored conversation with a subagent origin");
  assert.equal(child.origin?.kind === "subagent" ? child.origin.depth : null, 1);
  const parentRequests = requests.filter((entry) => entry.agent === "parent").slice(parentBefore).map((entry) => entry.body);
  assertPureAppend(parentRequests, "parent");
  const waitResult = JSON.parse(
    messageText(parentRequests.at(-1)!.messages.find((message) => message.role === "tool" && message.tool_call_id === "call_wait"))
  ) as { agents: Array<{ path: string; status: string; summary: string }> };
  assert.deepEqual(waitResult.agents.map((agent) => [agent.path, agent.status, agent.summary]), [["/root/counter", "completed", "notes.txt has 2 lines."]]);
  const cards = first.events.filter((event) => event.kind === "subagent" && event.subagentId === "/root/counter");
  assert.ok(cards.length > 0, "the parent shows the child as a card");

  script(
    "parent",
    toolTurn("call_note", "send_message", { target: "counter", message: "Words are separated by spaces." }),
    toolTurn("call_followup", "followup_task", { target: "counter", message: "Now count the words." }),
    toolTurn("call_wait2", "wait", { until: "agents", target: "counter", seconds: 20 }),
    textTurn("Three words.")
  );
  script("/root/counter", textTurn("notes.txt has 3 words."));
  await agentRuntimeManager.promptConversation(workspace, parent.id, "Ask it for the word count.");
  await waitForIdle(parent.id, 2);

  const childRequests = requests.filter((entry) => entry.agent === "/root/counter").map((entry) => entry.body);
  assert.equal(childRequests.length, 3);
  assertPureAppend(childRequests, "child");
  const lastTask = messageText(childRequests.at(-1)!.messages.filter((message) => message.role === "user").at(-1));
  assert.match(lastTask, /Message Type: MESSAGE[\s\S]*Words are separated by spaces\.[\s\S]*Message Type: NEW_TASK[\s\S]*Now count the words\./);
  assert.match(messageText(childRequests.at(-1)!.messages.find((message) => message.role === "user")), /You are subagent \/root\/counter/, "the child keeps its first turn in history");

  // A new handle (as after a restart) finds the child from its stored origin.
  const reopened = new DurableSubagents({
    workspace,
    conversationId: parent.id,
    parentPath: "/root",
    limits: () => defaultHarnessSettings().limits,
    resolveDefaultModelId: () => MODEL_ID,
    resolveSpawnModel: async (requested, fallback) => requested ?? fallback,
    appendEvents: async () => {},
    parentTranscript: async () => "",
    isCancelled: () => false,
  });
  const listed = await reopened.listAgents();
  assert.deepEqual(listed.map((agent) => [agent.agent_name, agent.agent_status, agent.conversation_id]), [["/root/counter", "completed", child.id]]);
  assert.match(await reopened.readTranscript({ subagentId: "/root/counter" }), /notes\.txt has 3 words\./);
  reopened.dispose();
  await setSubagentsVersion(1);
});

test("the blocking subagent tool runs a durable child to the end of its turn", async () => {
  await setSubagentsVersion(1);
  const parent = await agentRuntimeManager.createConversation(workspace, { backendId: "cesium-agent", modelId: MODEL_ID });
  script(
    "parent",
    toolTurn("call_sub", "subagent", { title: "Reader", instructions: "Read notes.txt and report the first word." }),
    textTurn("The first word is alpha.")
  );
  script("/root/subagent_1", textTurn("The first word is alpha."));
  const before = requests.filter((entry) => entry.agent === "parent").length;
  await agentRuntimeManager.promptConversation(workspace, parent.id, "Use a subagent.");
  const snapshot = await waitForIdle(parent.id, 1);
  const parentRequests = requests.filter((entry) => entry.agent === "parent").slice(before).map((entry) => entry.body);
  assertPureAppend(parentRequests, "parent");
  assert.equal(
    messageText(parentRequests.at(-1)!.messages.find((message) => message.role === "tool" && message.tool_call_id === "call_sub")),
    "Subagent /root/subagent_1 completed: The first word is alpha."
  );
  assert.ok(await childOf(parent.id, "/root/subagent_1"), "the child is a stored conversation");
  const card = snapshot.events.filter((event) => event.kind === "subagent").at(-1);
  assert.equal(card?.kind === "subagent" ? [card.subagentId, card.status].join(":") : null, "call_sub:completed", "the card merges with the tool call");
});

test("spawn rules hold before any child conversation exists", async () => {
  const parent = await agentRuntimeManager.createConversation(workspace, { backendId: "cesium-agent", modelId: MODEL_ID });
  const base = {
    workspace,
    conversationId: parent.id,
    limits: () => defaultHarnessSettings().limits,
    resolveDefaultModelId: () => MODEL_ID,
    appendEvents: async () => {},
    parentTranscript: async () => "Parent said hello.",
    isCancelled: () => false,
  };
  const deep = new DurableSubagents({ ...base, parentPath: "/root/counter", resolveSpawnModel: async (requested, fallback) => requested ?? fallback });
  await assert.rejects(deep.spawnAgent({ task_name: "grandchild", message: "x" }), /maximum agent spawn depth \(1\) exceeded/);
  const strict = new DurableSubagents({
    ...base,
    parentPath: "/root",
    resolveSpawnModel: async () => {
      throw new Error('Model "nope/model" is not available for subagents.');
    },
  });
  await assert.rejects(strict.spawnAgent({ task_name: "picky", message: "x", modelId: "nope/model" }), /not available for subagents/);
  assert.equal(await childOf(parent.id, "/root/picky"), undefined, "a rejected model creates no child");

  script("/root/forked", textTurn("Saw the parent."));
  const forking = new DurableSubagents({ ...base, parentPath: "/root", resolveSpawnModel: async (requested, fallback) => requested ?? fallback });
  await forking.spawnAgent({ task_name: "forked", message: "What did the parent say?" });
  const child = await childOf(parent.id, "/root/forked");
  assert.ok(child);
  const events = await readConversationEvents(workspace.id, child.id);
  const fork = events.find((event) => event.kind === "chat_fork");
  assert.equal(fork?.kind === "chat_fork" ? fork.transcript : null, "Parent said hello.", "fork_turns defaults to the whole parent transcript");
  await forking.waitForChildren(10_000);
  forking.dispose();
  deep.dispose();
  strict.dispose();
});

test("wait until=issue takes a ledger key and returns once the issue is done", async () => {
  const ledger = await import("../src/lib/agents/work-ledger.js");
  const orchestration = await import("../src/lib/orchestration/store.js");
  const parent = await agentRuntimeManager.createConversation(workspace, { backendId: "cesium-agent", modelId: MODEL_ID });
  await ledger.writeWorkLedger({ workspace, conversationId: parent.id }, () => [
    ledger.newLedgerItem({ key: "todo-1", kind: "task", title: "Review the release" }),
  ]);
  script("parent", toolTurn("call_wait_issue", "wait", { until: "issue", target: "todo-1", seconds: 20 }), textTurn("Reviewed."));
  const before = requests.filter((entry) => entry.agent === "parent").length;
  await agentRuntimeManager.promptConversation(workspace, parent.id, "Wait for the review.");
  setTimeout(() => {
    void (async () => {
      const board = await orchestration.findOrchestrationBoardForHeadConversation(workspace.id, parent.id);
      const issue = board!.issues.find((candidate) => candidate.ledger?.key === "todo-1")!;
      await orchestration.upsertOrchestrationIssue(board!.board.id, { id: issue.id, columnId: "done" });
    })();
  }, 1500);
  await waitForIdle(parent.id, 1);
  const last = requests.filter((entry) => entry.agent === "parent").slice(before).at(-1)!.body;
  const result = JSON.parse(
    messageText(last.messages.find((message) => message.role === "tool" && message.tool_call_id === "call_wait_issue"))
  ) as { conditionMet: boolean; waitFor: string; issue: { title: string } };
  assert.equal(result.conditionMet, true);
  assert.equal(result.waitFor, "issue_done");
  assert.equal(result.issue.title, "Review the release");
});
