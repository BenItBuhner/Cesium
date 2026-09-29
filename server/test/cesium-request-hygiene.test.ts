import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-request-hygiene-"));
const WORKSPACE_ROOT = path.join(TEST_DATA_DIR, "standalone-chats", "hygiene-workspace");
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
  "CESIUM_STREAM_IDLE_TIMEOUT_MS",
]) {
  delete process.env[key];
}
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;

type ChatMessage = { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string };
type ChatRequest = { messages: ChatMessage[]; tools?: unknown[]; max_tokens?: number };
type Responder = (res: ServerResponse, body: ChatRequest) => void;

const scripted: Responder[] = [];
const agentRequests: ChatRequest[] = [];
/** Agent requests whose connection closed before the server finished the response. */
let abortedResponses = 0;

const modelServer = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "Hygiene Test" } }] }));
      return;
    }
    agentRequests.push(body);
    res.on("close", () => {
      if (!res.writableEnded) {
        abortedResponses += 1;
      }
    });
    const responder = scripted.shift();
    if (!responder) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "no scripted response left" } }));
      return;
    }
    responder(res, body);
  });
});
await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
const MODEL_PORT = (modelServer.address() as AddressInfo).port;

process.env.CESIUM_BASE_URL = `http://127.0.0.1:${MODEL_PORT}/v1`;
process.env.CESIUM_API_KEY = "sk-test-request-hygiene";
process.env.CESIUM_PROVIDER_ID = "hygienehost";
process.env.CESIUM_DEFAULT_MODEL = "kimi-k3";
const MODEL_ID = "hygienehost/kimi-k3";

const [
  { ensureWorkspaceRegistered },
  { agentRuntimeManager },
  { readConversationSnapshot },
  { setCompletionRetryDelaysForTests },
] = await Promise.all([
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/runtime-manager.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/agents/completion-retry.js"),
]);

setCompletionRetryDelaysForTests([20, 20, 20]);

afterEach(() => {
  scripted.length = 0;
  delete process.env.CESIUM_STREAM_IDLE_TIMEOUT_MS;
});

after(async () => {
  setCompletionRetryDelaysForTests(null);
  modelServer.closeAllConnections();
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

function sseHead(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
}

function sse(res: ServerResponse, payloads: unknown[]): void {
  sseHead(res);
  for (const payload of payloads) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}

const textDelta = (content: string) => ({ choices: [{ index: 0, delta: { content } }] });
const finish = (reason: string) => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });

const text = (content: string): Responder => (res) => sse(res, [textDelta(content), finish("stop")]);

/** Sends the head and one delta, then never finishes on its own. */
const hang: Responder = (res) => {
  sseHead(res);
  res.write(`data: ${JSON.stringify(textDelta("Thinking about it"))}\n\n`);
};

function eventsOfKind<K extends AgentStoredEvent["kind"]>(
  events: AgentStoredEvent[],
  kind: K
): Array<Extract<AgentStoredEvent, { kind: K }>> {
  return events.filter((event): event is Extract<AgentStoredEvent, { kind: K }> => event.kind === kind);
}

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null | undefined> | T | null | undefined,
  predicate: (value: T) => boolean,
  timeoutMs = 15_000
): Promise<T> {
  const startedAt = Date.now();
  let last: T | null | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    last = await probe();
    if (last != null && predicate(last)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(last)?.slice(0, 2000)}`);
}

async function startConversation(title: string) {
  const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "hygiene-workspace");
  const conversation = await agentRuntimeManager.createConversation(workspace, {
    backendId: "cesium-agent",
    mode: "agent",
    modelId: MODEL_ID,
    modelName: title,
  });
  return { workspace, conversation };
}

async function settle(workspaceId: string, conversationId: string, ends: number) {
  return waitFor(
    "the turn to settle",
    () => readConversationSnapshot(workspaceId, conversationId),
    (value) =>
      value.conversation.status === "failed" ||
      (value.conversation.status === "idle" &&
        eventsOfKind(value.events, "assistant_message_end").filter((event) => event.stopReason !== "discarded")
          .length >= ends)
  );
}

test("cancel aborts the in-flight provider request instead of letting it run", async () => {
  const { workspace, conversation } = await startConversation("Cancel");
  scripted.push(hang);
  const abortedBefore = abortedResponses;
  const requestsBefore = agentRequests.length;
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Take your time.");
  await waitFor("the request to arrive", () => agentRequests.length, (count) => count > requestsBefore);
  await waitFor(
    "the first delta to be persisted",
    () => readConversationSnapshot(workspace.id, conversation.id),
    (value) => eventsOfKind(value.events, "assistant_message_chunk").length > 0
  );
  await agentRuntimeManager.cancelConversation(workspace, conversation.id);
  await waitFor("the server to see the socket close", () => abortedResponses, (count) => count > abortedBefore, 5_000);
  const snapshot = await waitFor(
    "the conversation to be cancelled",
    () => readConversationSnapshot(workspace.id, conversation.id),
    (value) => value.conversation.status === "cancelled"
  );
  assert.equal(agentRequests.length, requestsBefore + 1, "a cancelled turn does not retry");
  assert.equal(eventsOfKind(snapshot.events, "system").filter((event) => event.level === "error").length, 0);
});

test("a stream that goes idle is aborted and retried", async () => {
  process.env.CESIUM_STREAM_IDLE_TIMEOUT_MS = "300";
  const { workspace, conversation } = await startConversation("Idle");
  scripted.push((res) => sseHead(res), text("Answer after the stall."));
  const abortedBefore = abortedResponses;
  const requestsBefore = agentRequests.length;
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Answer me.");
  const snapshot = await settle(workspace.id, conversation.id, 1);
  assert.equal(snapshot.conversation.status, "idle", snapshot.conversation.lastError ?? "");
  assert.equal(agentRequests.length - requestsBefore, 2);
  assert.equal(abortedResponses - abortedBefore, 1, "the idle attempt's socket was closed");
  assert.deepEqual(
    eventsOfKind(snapshot.events, "assistant_message_chunk").map((event) => event.text).join(""),
    "Answer after the stall."
  );
});

/** Streams some text, then drops the connection mid-response. */
const dropAfter = (content: string): Responder => (res) => {
  sseHead(res);
  res.write(`data: ${JSON.stringify(textDelta(content))}\n\n`);
  setTimeout(() => res.socket?.destroy(), 150);
};

function assistantContents(request: ChatRequest): string[] {
  return request.messages
    .filter((message) => message.role === "assistant")
    .map((message) => (typeof message.content === "string" ? message.content : ""));
}

test("a stream that breaks after partial text is retried and only the retry reaches history", async () => {
  const { workspace, conversation } = await startConversation("Mid-stream");
  scripted.push(dropAfter("Half an ans"), text("The full answer."));
  const requestsBefore = agentRequests.length;
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Answer me.");
  let snapshot = await settle(workspace.id, conversation.id, 1);
  assert.equal(snapshot.conversation.status, "idle", snapshot.conversation.lastError ?? "");
  assert.equal(agentRequests.length - requestsBefore, 2);
  assert.deepEqual(agentRequests.at(-1)!.messages, agentRequests.at(-2)!.messages, "the retry resends the same request");

  const ends = eventsOfKind(snapshot.events, "assistant_message_end");
  const discarded = ends.filter((event) => event.stopReason === "discarded");
  assert.equal(discarded.length, 1, "the partial attempt was persisted and then discarded");
  const discardedText = eventsOfKind(snapshot.events, "assistant_message_chunk")
    .filter((event) => event.messageId === discarded[0]!.messageId)
    .map((event) => event.text)
    .join("");
  assert.equal(discardedText, "Half an ans");

  scripted.push(text("Second reply."));
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "And again.");
  snapshot = await settle(workspace.id, conversation.id, 2);
  assert.equal(snapshot.conversation.status, "idle", snapshot.conversation.lastError ?? "");
  const nextTurn = agentRequests.at(-1)!;
  assert.deepEqual(assistantContents(nextTurn), ["The full answer."]);
  assert.equal(JSON.stringify(nextTurn.messages).includes("Half an ans"), false);
  assert.deepEqual(
    nextTurn.messages.slice(0, agentRequests.at(-2)!.messages.length),
    agentRequests.at(-2)!.messages,
    "the next turn's request extends the retried one"
  );
});
