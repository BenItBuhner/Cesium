import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "goal-continuation-"));
const WORKSPACE_ROOT = path.join(TEST_DATA_DIR, "standalone-chats", "goal");
await fs.mkdir(WORKSPACE_ROOT, { recursive: true });

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

type ChatMessage = { role: string; content?: unknown };
type ChatRequest = { messages: ChatMessage[]; tools?: unknown[] };
type Responder = (res: ServerResponse) => void;

const scripted: Responder[] = [];
const agentRequests: ChatRequest[] = [];
const modelServer = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "Goal Test" } }] }));
      return;
    }
    agentRequests.push(body);
    const responder = scripted.shift();
    if (!responder) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "no scripted response left" } }));
      return;
    }
    responder(res);
  });
});
await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
const MODEL_PORT = (modelServer.address() as AddressInfo).port;
process.env.CESIUM_BASE_URL = `http://127.0.0.1:${MODEL_PORT}/v1`;
process.env.CESIUM_API_KEY = "sk-test-goal";
process.env.CESIUM_PROVIDER_ID = "goalhost";
process.env.CESIUM_DEFAULT_MODEL = "kimi-k3";
const MODEL_ID = "goalhost/kimi-k3";

const [
  { ensureWorkspaceRegistered },
  { agentRuntimeManager },
  { readConversationSnapshot },
  { readGoalForConversation, ensureGoalForConversation, updateGoalPlan },
  continuation,
  { startGoalContinuationListener },
  { todoEntriesFromReplace, parseTodoItems },
  { normalizeWorkItemStatus },
] = await Promise.all([
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/runtime-manager.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/agents/goal-store.js"),
  import("../src/lib/agents/goal-continuation.js"),
  import("../src/lib/agents/goal-continuation-listener.js"),
  import("../src/lib/agents/cesium/cesium-todo.js"),
  import("../src/lib/agents/work-items.js"),
]);
startGoalContinuationListener();

after(async () => {
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

function sse(res: ServerResponse, payloads: unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const payload of payloads) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}

function toolTurn(id: string, name: string, args: Record<string, unknown>, promptTokens = 1_000): Responder {
  return (res) =>
    sse(res, [
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 10 } },
    ]);
}

function textTurn(text: string, promptTokens = 1_000): Responder {
  return (res) =>
    sse(res, [
      { choices: [{ index: 0, delta: { content: text } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 10 } },
    ]);
}

function messageText(message: ChatMessage | undefined): string {
  return typeof message?.content === "string" ? message.content : "";
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out.");
}

async function settled(workspaceId: string, conversationId: string, ends: number) {
  let snapshot = await readConversationSnapshot(workspaceId, conversationId);
  await waitFor(async () => {
    snapshot = await readConversationSnapshot(workspaceId, conversationId);
    return (
      snapshot?.conversation.status === "idle" &&
      snapshot.events.filter((event: AgentStoredEvent) => event.kind === "assistant_message_end").length >= ends
    );
  });
  // Give the continuation listener its chance to start (or not start) another turn.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await waitFor(async () => (await readConversationSnapshot(workspaceId, conversationId))?.conversation.status === "idle");
  return (await readConversationSnapshot(workspaceId, conversationId))!;
}

test("an active Goal with work left continues on its own, as a persisted message later requests extend", async () => {
  const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "goal");
  const conversation = await agentRuntimeManager.createConversation(workspace, {
    backendId: "cesium-agent",
    modelId: MODEL_ID,
    modelName: "Kimi K3",
  });
  const firstRequest = agentRequests.length;
  scripted.push(
    toolTurn("call_set", "goal_set", {
      objective: "Write two notes",
      todos: [
        { content: "Write note one", status: "in_progress" },
        { content: "Write note two", status: "pending" },
      ],
    }),
    textTurn("Started on note one."),
    toolTurn("call_done", "goal_set", {
      todos: [
        { content: "Write note one", status: "completed" },
        { content: "Write note two", status: "completed" },
      ],
    }),
    textTurn("Both notes are written.")
  );
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Work on the notes goal.");
  const snapshot = await settled(workspace.id, conversation.id, 2);

  const requests = agentRequests.slice(firstRequest).map((request) => request.messages);
  assert.equal(requests.length, 4, "one user turn plus one continuation turn");
  for (let index = 1; index < requests.length; index += 1) {
    assert.deepEqual(requests[index]!.slice(0, requests[index - 1]!.length), requests[index - 1], `request ${index + 1} extends request ${index}`);
  }
  const continuationMessage = requests[2]!.at(-1)!;
  assert.equal(continuationMessage.role, "user");
  assert.match(messageText(continuationMessage), /<goal_context>[\s\S]*Take the next concrete step\.$/);
  const users = snapshot.events.filter(
    (event): event is Extract<AgentStoredEvent, { kind: "user_message" }> => event.kind === "user_message"
  );
  assert.equal(users.length, 2);
  assert.equal(users[1]!.displayContent, "Continuing the Goal (1/8)");
  const goal = await readGoalForConversation({ workspace, conversationId: conversation.id });
  assert.equal(goal?.todos.every((todo) => todo.status === "completed"), true, "the finished Goal stops the loop");
});

test("a Goal whose token budget is spent stops as budget_limited instead of continuing", async () => {
  const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "goal");
  const conversation = await agentRuntimeManager.createConversation(workspace, {
    backendId: "cesium-agent",
    modelId: MODEL_ID,
    modelName: "Kimi K3",
  });
  const firstRequest = agentRequests.length;
  scripted.push(
    toolTurn("call_budget", "goal_set", {
      objective: "Refactor the parser",
      tokenBudget: 5_000,
      todos: [{ content: "Split the lexer", status: "in_progress" }],
    }, 4_000),
    textTurn("Working on the lexer.", 6_000)
  );
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Start the parser goal.");
  const snapshot = await settled(workspace.id, conversation.id, 1);
  assert.equal(agentRequests.length - firstRequest, 2, "no continuation turn");
  const goal = await readGoalForConversation({ workspace, conversationId: conversation.id });
  assert.equal(goal?.status, "budget_limited");
  assert.ok(goal!.tokensUsed >= 5_000);
  assert.ok(
    snapshot.events.some((event: AgentStoredEvent) => event.kind === "system" && /token budget/.test(event.text)),
    "the user is told why it stopped"
  );
});

function turnEvents(userMessageId: string, toolDetail: string): AgentStoredEvent[] {
  const base = { conversationId: "c", createdAt: 10 };
  return [
    { ...base, seq: 1, eventId: "u", kind: "user_message", messageId: userMessageId, content: "go" },
    { ...base, seq: 2, eventId: "t", kind: "tool_call", toolCallId: `t-${userMessageId}`, title: "Read a.ts", toolKind: "read", status: "in_progress", detail: toolDetail, raw: { name: "read_file" } },
    { ...base, seq: 3, eventId: "e", kind: "assistant_message_end", messageId: "a", stopReason: "end_turn" },
  ] as AgentStoredEvent[];
}

test("continuation stops after the turn limit, after repeated no-progress turns, and for busy or Project chats", async () => {
  const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "goal");
  const created = await agentRuntimeManager.createConversation(workspace, { backendId: "cesium-agent", modelId: MODEL_ID });
  await ensureGoalForConversation({ workspace, conversationId: created.id, objective: "Ship it" });
  const goal = await updateGoalPlan({
    workspace,
    conversationId: created.id,
    todos: [{ content: "Ship it", status: "in_progress" }],
  });
  const record = { status: "idle" as const, queuedPrompts: [], origin: null };
  let state = continuation.freshGoalContinuationState();

  const first = continuation.decideGoalContinuation({ record, goal, events: turnEvents("m1", '{"path":"a.ts"}'), state });
  assert.equal(first.kind, "continue");
  state = continuation.advanceGoalContinuationState(state, "m1", first);
  assert.equal(
    continuation.decideGoalContinuation({ record, goal, events: turnEvents("m1", '{"path":"a.ts"}'), state }).kind,
    "stop",
    "a turn is continued at most once"
  );
  const second = continuation.decideGoalContinuation({ record, goal, events: turnEvents("m2", '{"path":"a.ts"}'), state });
  assert.equal(second.kind, "continue", "one repeat is tolerated");
  state = continuation.advanceGoalContinuationState(state, "m2", second);
  const third = continuation.decideGoalContinuation({ record, goal, events: turnEvents("m3", '{"path":"a.ts"}'), state });
  assert.equal(third.kind, "stop");
  assert.match(third.kind === "stop" ? third.notice ?? "" : "", /no progress/);

  const capped = continuation.decideGoalContinuation({
    record,
    goal,
    events: turnEvents("m9", '{"path":"b.ts"}'),
    state: { ...continuation.freshGoalContinuationState(), count: continuation.GOAL_AUTO_CONTINUE_MAX },
  });
  assert.equal(capped.kind, "stop");
  assert.match(capped.kind === "stop" ? capped.notice ?? "" : "", /waiting for you/);

  const fresh = continuation.freshGoalContinuationState();
  for (const busy of [
    { ...record, status: "cancelled" as const },
    { ...record, queuedPrompts: [{ id: "q", text: "next", createdAt: 1 }] },
    { ...record, origin: { kind: "project-agent" } },
  ]) {
    assert.equal(
      continuation.decideGoalContinuation({ record: busy as never, goal, events: turnEvents("m4", "{}"), state: fresh }).kind,
      "stop"
    );
  }
});

test("goal_complete's verifier wants a command after the last edit and a passed requirement", async () => {
  const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "goal");
  const created = await agentRuntimeManager.createConversation(workspace, { backendId: "cesium-agent", modelId: MODEL_ID });
  const goal = await ensureGoalForConversation({ workspace, conversationId: created.id, objective: "Fix bug" });
  const at = goal.createdAt + 1;
  const events = (names: string[]) =>
    names.flatMap((name, index) => [
      { seq: index * 2 + 1, eventId: `c${index}`, conversationId: created.id, createdAt: at, kind: "tool_call", toolCallId: `t${index}`, title: name, toolKind: "other", status: "in_progress", raw: { name } },
      { seq: index * 2 + 2, eventId: `u${index}`, conversationId: created.id, createdAt: at, kind: "tool_call_update", toolCallId: `t${index}`, status: "completed", detail: "ok" },
    ]) as AgentStoredEvent[];
  assert.deepEqual(
    continuation.verifyGoalCompletion(goal, events(["terminal", "edit_file"])).map((finding) => finding.split(":")[0]),
    ["Files were edited after the last command ran", "No requirement is recorded as passed"]
  );
  const verified = { ...goal, verificationEvidence: [{ requirement: "tests pass", status: "passed" as const, updatedAt: at }] };
  assert.deepEqual(continuation.verifyGoalCompletion(verified, events(["edit_file", "terminal"])), []);
});

test("todos and Goal items keep their ids when a list is reordered or rewritten", async () => {
  const existing = todoEntriesFromReplace(parseTodoItems(["Read the code", "Write tests", "Run the suite"]));
  assert.deepEqual(existing.map((entry) => entry.id), ["todo-1", "todo-2", "todo-3"]);
  const reordered = todoEntriesFromReplace(
    parseTodoItems([
      { content: "run the suite", status: "in_progress" },
      { content: "Read the code", status: "done" },
      { content: "Open the PR" },
    ]),
    existing
  );
  assert.deepEqual(reordered, [
    { id: "todo-3", content: "run the suite", status: "in_progress" },
    { id: "todo-1", content: "Read the code", status: "completed" },
    { id: "todo-4", content: "Open the PR", status: "pending" },
  ]);

  const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "goal");
  const created = await agentRuntimeManager.createConversation(workspace, { backendId: "cesium-agent", modelId: MODEL_ID });
  await ensureGoalForConversation({ workspace, conversationId: created.id, objective: "Ship" });
  const first = await updateGoalPlan({
    workspace,
    conversationId: created.id,
    todos: [
      { content: "Build", evidence: "build log" },
      { content: "Test", milestoneId: "m1" },
    ],
  });
  const second = await updateGoalPlan({
    workspace,
    conversationId: created.id,
    todos: [{ content: "Test" }, { content: "Build", status: "done" }],
  });
  assert.deepEqual(
    second.todos.map((todo) => [todo.id, todo.content, todo.evidence ?? null, todo.milestoneId ?? null, todo.status]),
    [
      [first.todos[1]!.id, "Test", null, "m1", "pending"],
      [first.todos[0]!.id, "Build", "build log", null, "completed"],
    ],
    "reordering keeps each item's evidence and milestone"
  );

  assert.equal(normalizeWorkItemStatus("In Progress"), "in_progress");
  assert.equal(normalizeWorkItemStatus("done"), "completed");
  assert.equal(normalizeWorkItemStatus("stuck"), "blocked");
  assert.equal(normalizeWorkItemStatus("whatever"), "pending");
  assert.equal(normalizeWorkItemStatus(undefined), undefined);
});

test("the chat's Goal summary falls back to completed todos and pins a complete Goal at 100%", async () => {
  const { createGoalRecord } = await import("../src/lib/agents/goal-store.js");
  const { goalSummaryForChat } = await import("../src/lib/agents/goal-types.js");
  const base = createGoalRecord({
    workspace: { id: "ws", root: "/tmp/ws", name: "ws", createdAt: 1, updatedAt: 1, lastOpenedAt: 1 },
    conversationId: "c1",
    objective: "Ship it",
  });
  const todos = [
    { id: "todo-1", content: "a", status: "completed" as const, updatedAt: 1 },
    { id: "todo-2", content: "b", status: "pending" as const, updatedAt: 1 },
    { id: "todo-3", content: "c", status: "completed" as const, updatedAt: 1 },
  ];
  const fromTodos = goalSummaryForChat({ ...base, todos, progressPercent: null });
  assert.equal(fromTodos.progressPercent, 67);
  assert.equal(fromTodos.todosCompleted, 2);
  assert.equal(fromTodos.todosTotal, 3);
  assert.equal(goalSummaryForChat({ ...base, todos, progressPercent: 30 }).progressPercent, 30);
  assert.equal(goalSummaryForChat({ ...base, todos, status: "complete", progressPercent: 80 }).progressPercent, 100);
});
