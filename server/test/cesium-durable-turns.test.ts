import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AgentConversationRecord, AgentStoredEvent } from "../src/lib/agents/types.js";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-durable-turns-"));
const WORKSPACE_ROOT = path.join(TEST_DATA_DIR, "standalone-chats", "durable-turns");
await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
await fs.writeFile(path.join(WORKSPACE_ROOT, "notes.txt"), "alpha\nbeta\n");

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
      res.end(JSON.stringify({ choices: [{ message: { content: "Durable Test" } }] }));
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
process.env.CESIUM_API_KEY = "sk-test-durable-turns";
process.env.CESIUM_PROVIDER_ID = "durablehost";
process.env.CESIUM_DEFAULT_MODEL = "kimi-k3";
const MODEL_ID = "durablehost/kimi-k3";

const [
  { ensureWorkspaceRegistered },
  { AgentRuntimeManager },
  { appendConversationEvents, readConversationEvents, readConversationRecord, updateConversationRecord },
  { reconcileStaleAgentRunsOnBoot },
  { AgentRequestNotLiveError },
] = await Promise.all([
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/runtime-manager.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/agents/stale-run-reconciler.js"),
  import("../src/lib/agents/turn-interruption.js"),
]);

after(async () => {
  modelServer.closeAllConnections();
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

function sse(res: ServerResponse, payloads: unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const payload of payloads) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}

function toolCallTurn(textBefore: string, id: string, name: string, args: Record<string, unknown>): Responder {
  return (res) =>
    sse(res, [
      { choices: [{ index: 0, delta: { content: textBefore } }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
            },
          },
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

function messageText(message: ChatMessage | undefined): string {
  return typeof message?.content === "string" ? message.content : "";
}

function toolResult(messages: ChatMessage[], toolCallId: string): string {
  return messageText(messages.find((message) => message.role === "tool" && message.tool_call_id === toolCallId));
}

function assertPureAppends(requests: ChatRequest[]): void {
  for (let index = 1; index < requests.length; index += 1) {
    assert.deepEqual(
      requests[index]!.messages.slice(0, requests[index - 1]!.messages.length),
      requests[index - 1]!.messages,
      `request ${index + 1} extends request ${index}`
    );
  }
}

async function waitForRecord(
  workspaceId: string,
  conversationId: string,
  label: string,
  done: (record: AgentConversationRecord) => boolean
): Promise<AgentConversationRecord> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    const record = await readConversationRecord(workspaceId, conversationId);
    if (record && done(record)) {
      return record;
    }
    if (record?.status === "failed") {
      throw new Error(`turn failed while waiting for ${label}: ${record.lastError}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function waitForIdle(workspaceId: string, conversationId: string) {
  return waitForRecord(workspaceId, conversationId, "an idle turn", (record) => record.status === "idle");
}

function eventsAfter<K extends AgentStoredEvent["kind"]>(
  events: AgentStoredEvent[],
  kind: K,
  afterSeq = 0
): Array<Extract<AgentStoredEvent, { kind: K }>> {
  return events.filter(
    (event): event is Extract<AgentStoredEvent, { kind: K }> => event.kind === kind && event.seq > afterSeq
  );
}

function latestStatus(events: AgentStoredEvent[]) {
  return eventsAfter(events, "status").at(-1);
}

async function startConversation() {
  const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "durable-turns");
  const manager = new AgentRuntimeManager();
  const conversation = await manager.createConversation(workspace, {
    backendId: "cesium-agent",
    modelId: MODEL_ID,
    modelName: "Kimi K3",
  });
  return { workspace, manager, conversationId: conversation.id };
}

/** Runs a turn on a fresh manager until the model's first tool call parks on the user. */
async function parkOnUser(
  prompt: string,
  responder: Responder,
  status: "awaiting_permission" | "awaiting_question"
) {
  const started = await startConversation();
  const firstRequest = agentRequests.length;
  scripted.push(responder);
  await started.manager.promptConversation(started.workspace, started.conversationId, prompt);
  const parked = await waitForRecord(started.workspace.id, started.conversationId, status, (record) =>
    status === "awaiting_permission" ? record.pendingPermission != null : record.pendingQuestion != null
  );
  return { ...started, parked, firstRequest };
}

test("shutdown drains a turn parked on permission, refuses new turns, and Continue closes the card unanswered", async () => {
  const target = path.join(WORKSPACE_ROOT, "shutdown.txt");
  const { workspace, manager, conversationId, parked, firstRequest } = await parkOnUser(
    "Write shutdown.txt.",
    toolCallTurn("Writing it.", "call_shutdown_write", "write_file", { path: "shutdown.txt", content: "hi\n" }),
    "awaiting_permission"
  );
  const requestId = parked.pendingPermission!.requestId;

  const result = await manager.shutdown({ timeoutMs: 5_000 });
  assert.deepEqual(result, { interrupted: [conversationId], drained: true });
  const record = await readConversationRecord(workspace.id, conversationId);
  assert.equal(record?.status, "interrupted");
  assert.equal(record?.pendingPermission, null);
  assert.ok(record?.providerSessionId, "the session id survives, so the next runtime reloads it");
  const events = await readConversationEvents(workspace.id, conversationId);
  assert.deepEqual(latestStatus(events)?.raw, { interruption: { cause: "shutdown" } });
  assert.match(latestStatus(events)?.detail ?? "", /server shut down.*Press Continue/);
  assert.equal(eventsAfter(events, "permission_resolved").length, 0, "the card stays answerable");
  assert.equal(eventsAfter(events, "tool_call_update").length, 0, "the parked call is left open");
  await assert.rejects(
    manager.promptConversation(workspace, conversationId, "One more thing."),
    /shutting down/
  );

  const afterRestart = new AgentRuntimeManager();
  scripted.push(textTurn("I could not write it without permission."));
  await afterRestart.continueInterruptedConversation(workspace, conversationId);
  await waitForIdle(workspace.id, conversationId);

  const requests = agentRequests.slice(firstRequest);
  assert.equal(requests.length, 2);
  assertPureAppends(requests);
  const continued = requests[1]!.messages;
  assert.match(toolResult(continued, "call_shutdown_write"), /^Not run: .*never answered\.$/);
  assert.match(messageText(continued.at(-1)), /interrupted before it finished: the Cesium server shut down\./);
  const settled = await readConversationEvents(workspace.id, conversationId);
  assert.deepEqual(
    eventsAfter(settled, "permission_resolved").map((event) => [event.requestId, event.outcome]),
    [[requestId, "cancelled"]]
  );
  const userMessages = eventsAfter(settled, "user_message");
  assert.equal(userMessages.at(-1)?.displayContent, "Continue");
  await assert.rejects(fs.access(target), "the unanswered write never ran");
});

test("a permission allowed after the runtime is lost fails loudly, and Continue runs the call once", async () => {
  const { workspace, conversationId, parked, firstRequest } = await parkOnUser(
    "Write granted.txt.",
    toolCallTurn("Writing it.", "call_grant_write", "write_file", { path: "granted.txt", content: "granted\n" }),
    "awaiting_permission"
  );
  const requestId = parked.pendingPermission!.requestId;

  // A new process: the manager that asked is gone and nothing marked the run.
  const afterRestart = new AgentRuntimeManager();
  assert.equal(afterRestart.hasLiveRuntime(conversationId), false);
  const answered = await afterRestart.answerPermission(workspace, conversationId, {
    requestId,
    optionId: "allow_once",
  });
  assert.equal(answered.interrupted, true);
  assert.equal(answered.conversation.status, "interrupted");
  assert.equal(answered.conversation.pendingPermission, null);
  const events = await readConversationEvents(workspace.id, conversationId);
  const interruption = eventsAfter(events, "status").find((event) => event.status === "interrupted");
  assert.deepEqual(interruption?.raw, { interruption: { cause: "runtime_lost" } });
  assert.match(latestStatus(events)?.detail ?? "", /^Permission allowed\. .*press Continue/);
  const resolved = eventsAfter(events, "permission_resolved");
  assert.deepEqual(
    resolved.map((event) => [event.requestId, event.outcome, event.optionId]),
    [[requestId, "selected", "allow_once"]]
  );
  const answeredAt = resolved[0]!.seq;
  const again = await afterRestart.answerPermission(workspace, conversationId, {
    requestId,
    optionId: "allow_once",
  });
  assert.equal(again.interrupted, false, "a repeated answer is a no-op");

  scripted.push(
    toolCallTurn("Writing it now.", "call_grant_write_2", "write_file", { path: "granted.txt", content: "granted\n" }),
    textTurn("Wrote granted.txt.")
  );
  await afterRestart.continueInterruptedConversation(workspace, conversationId);
  await waitForIdle(workspace.id, conversationId);
  scripted.push(textTurn("It holds granted."));
  await afterRestart.promptConversation(workspace, conversationId, "What is in it?");
  await waitForIdle(workspace.id, conversationId);

  assert.equal(await fs.readFile(path.join(WORKSPACE_ROOT, "granted.txt"), "utf8"), "granted\n");
  const finalEvents = await readConversationEvents(workspace.id, conversationId);
  assert.equal(eventsAfter(finalEvents, "permission_request", answeredAt).length, 0, "the grant is not asked again");
  assert.ok(
    eventsAfter(finalEvents, "status", answeredAt).some((event) =>
      /you allowed it before the interruption/.test(event.detail ?? "")
    )
  );
  const requests = agentRequests.slice(firstRequest);
  assert.equal(requests.length, 4);
  assertPureAppends(requests);
  const continued = requests[1]!.messages;
  assert.match(toolResult(continued, "call_grant_write"), /^Not run: the user allowed this call/);
  assert.match(messageText(continued.at(-1)), /interrupted before it finished: the agent runtime stopped\./);
  assert.match(messageText(continued.at(-1)), /Continue from where you left off\.$/);
  assert.equal(
    requests[3]!.messages.filter((message) => message.role === "tool").length,
    2,
    "the second write ran once; the first stays a recorded result"
  );
});

test("a question answered after the runtime is lost is the result Continue resumes with", async () => {
  const { workspace, conversationId, parked, firstRequest } = await parkOnUser(
    "Pick a color with me.",
    toolCallTurn("Let me ask.", "call_color", "ask_question", {
      prompt: "Which color?",
      options: ["Red", "Blue"],
    }),
    "awaiting_question"
  );
  const questionId = parked.pendingQuestion!.questionId;

  const afterRestart = new AgentRuntimeManager();
  const answered = await afterRestart.answerQuestion(workspace, conversationId, { questionId, answer: "Blue" });
  assert.equal(answered.interrupted, true);
  assert.equal(answered.conversation.status, "interrupted");
  assert.equal(answered.conversation.pendingQuestion, null);
  const events = await readConversationEvents(workspace.id, conversationId);
  assert.deepEqual(
    eventsAfter(events, "question").map((event) => [event.questionId, event.status]),
    [
      [questionId, "pending"],
      [questionId, "answered"],
    ]
  );
  assert.match(latestStatus(events)?.detail ?? "", /^Answer saved\. .*press Continue/);
  const repeated = await afterRestart.answerQuestion(workspace, conversationId, { questionId, answer: "Red" });
  assert.equal(repeated.interrupted, false, "the first answer stands");

  scripted.push(textTurn("Blue it is."));
  await afterRestart.continueInterruptedConversation(workspace, conversationId);
  await waitForIdle(workspace.id, conversationId);
  const requests = agentRequests.slice(firstRequest);
  assert.equal(requests.length, 2);
  assertPureAppends(requests);
  assert.equal(toolResult(requests[1]!.messages, "call_color"), "User answer:\nBlue");

  await assert.rejects(
    afterRestart.answerQuestion(workspace, conversationId, { questionId: "q-unknown", answer: "Green" }),
    AgentRequestNotLiveError
  );
  await assert.rejects(
    afterRestart.answerPermission(workspace, conversationId, { requestId: "perm-unknown", optionId: "allow_once" }),
    AgentRequestNotLiveError
  );
  assert.equal((await readConversationRecord(workspace.id, conversationId))?.status, "idle");
});

test("the boot sweep repairs a half-finished turn so Continue keeps its work where the model saw it", async () => {
  const { workspace, manager, conversationId } = await startConversation();
  const firstRequest = agentRequests.length;
  scripted.push(textTurn("Hello."));
  await manager.promptConversation(workspace, conversationId, "Say hello.");
  await waitForIdle(workspace.id, conversationId);
  await manager.disposeRuntime(conversationId);

  // What a crash leaves behind: a streamed reply whose tool call never returned.
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  await appendConversationEvents(workspace.id, conversationId, [
    { eventId: randomUUID(), conversationId, kind: "user_message", messageId: userMessageId, content: "Read the notes." },
    { eventId: randomUUID(), conversationId, kind: "assistant_message_chunk", messageId: assistantMessageId, text: "Reading the notes." },
    {
      eventId: randomUUID(),
      conversationId,
      kind: "tool_call",
      toolCallId: "call_crashed_read",
      title: "Read notes.txt",
      toolKind: "read",
      status: "in_progress",
      detail: JSON.stringify({ path: "notes.txt" }),
      raw: { id: "call_crashed_read", name: "read_file", arguments: { path: "notes.txt" } },
    },
  ]);
  await updateConversationRecord(workspace.id, conversationId, (current) => ({ ...current, status: "running" }));

  const swept = await reconcileStaleAgentRunsOnBoot({ hasLiveRuntime: (id) => id !== conversationId });
  assert.equal(swept, 1);
  const events = await readConversationEvents(workspace.id, conversationId);
  const repair = eventsAfter(events, "tool_call_update").find((event) => event.toolCallId === "call_crashed_read");
  assert.equal(repair?.status, "failed");
  assert.match(repair?.detail ?? "", /^Interrupted: .*Re-verify/);
  assert.deepEqual(latestStatus(events)?.raw, { interruption: { cause: "restart" } });

  const afterRestart = new AgentRuntimeManager();
  scripted.push(textTurn("The notes say alpha and beta."));
  await afterRestart.continueInterruptedConversation(workspace, conversationId);
  await waitForIdle(workspace.id, conversationId);

  const requests = agentRequests.slice(firstRequest);
  assert.equal(requests.length, 2);
  const continued = requests[1]!.messages;
  assert.deepEqual(continued.slice(0, requests[0]!.messages.length), requests[0]!.messages);
  const crashedCall = continued.findIndex(
    (message) => message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0
  );
  assert.equal(messageText(continued[crashedCall]), "Reading the notes.");
  assert.equal(continued[crashedCall + 1]?.role, "tool");
  assert.match(toolResult(continued, "call_crashed_read"), /^Interrupted: /);
  assert.equal(continued.length, crashedCall + 3, "the continue message follows the repaired call");
  assert.match(messageText(continued.at(-1)), /the Cesium server restarted\./);
});

test("a dangling half-streamed reply is closed at its position, not moved after Continue", async () => {
  const { workspace, manager, conversationId } = await startConversation();
  scripted.push(textTurn("Sure."));
  await manager.promptConversation(workspace, conversationId, "Can you tell stories?");
  await waitForIdle(workspace.id, conversationId);
  await manager.disposeRuntime(conversationId);
  const firstRequest = agentRequests.length;
  const assistantMessageId = randomUUID();
  await appendConversationEvents(workspace.id, conversationId, [
    { eventId: randomUUID(), conversationId, kind: "user_message", messageId: randomUUID(), content: "Tell me a story." },
    { eventId: randomUUID(), conversationId, kind: "assistant_message_chunk", messageId: assistantMessageId, text: "Once upon a" },
  ]);
  await updateConversationRecord(workspace.id, conversationId, (current) => ({ ...current, status: "running" }));
  await reconcileStaleAgentRunsOnBoot({ hasLiveRuntime: (id) => id !== conversationId });
  const events = await readConversationEvents(workspace.id, conversationId);
  assert.deepEqual(
    eventsAfter(events, "assistant_message_end")
      .filter((event) => event.messageId === assistantMessageId)
      .map((event) => event.stopReason),
    ["interrupted"]
  );

  const afterRestart = new AgentRuntimeManager();
  scripted.push(textTurn("time, there was a cache."));
  await afterRestart.continueInterruptedConversation(workspace, conversationId);
  await waitForIdle(workspace.id, conversationId);
  assertPureAppends(agentRequests.slice(firstRequest - 1, firstRequest + 1));
  const messages = agentRequests[firstRequest]!.messages;
  const partial = messages.findLastIndex((message) => message.role === "assistant");
  assert.equal(messageText(messages[partial]), "Once upon a");
  assert.equal(messages[partial + 1]?.role, "user", "the continue message comes after the partial reply");
  assert.equal(partial + 2, messages.length);
});
