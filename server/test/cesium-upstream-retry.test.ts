import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-upstream-retry-"));
const WORKSPACE_ROOT = path.join(TEST_DATA_DIR, "standalone-chats", "retry-workspace");
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
  "CESIUM_PROJECTS_ENABLED",
]) {
  delete process.env[key];
}
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;

type ChatRequest = { messages: unknown[]; tools?: unknown[] };
type Responder = (res: ServerResponse) => void;

const scripted: Responder[] = [];
let agentRequestCount = 0;

const modelServer = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "Retry Test" } }] }));
      return;
    }
    agentRequestCount += 1;
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
process.env.CESIUM_API_KEY = "sk-test-upstream-retry";
process.env.CESIUM_PROVIDER_ID = "retryhost";
process.env.CESIUM_DEFAULT_MODEL = "kimi-k3";
const MODEL_ID = "retryhost/kimi-k3";

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
  delete process.env.CESIUM_PROJECTS_ENABLED;
});

after(async () => {
  setCompletionRetryDelaysForTests(null);
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

const stop = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };

const text = (content: string): Responder => (res) =>
  sse(res, [{ choices: [{ index: 0, delta: { content } }] }, stop]);

const emptyStream: Responder = (res) => sse(res, [stop]);

/** kimi-k3's degenerate stream: reasoning full of `!` and no reply. */
const reasoningOnly = (reasoning: string): Responder => (res) =>
  sse(res, [{ choices: [{ index: 0, delta: { reasoning_content: reasoning } }] }, stop]);

const errorChunk = (error: Record<string, unknown>): Responder => (res) => sse(res, [{ error }]);

const jsonError = (error: Record<string, unknown>): Responder => (res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ error }));
};

function eventsOfKind<K extends AgentStoredEvent["kind"]>(
  events: AgentStoredEvent[],
  kind: K
): Array<Extract<AgentStoredEvent, { kind: K }>> {
  return events.filter((event): event is Extract<AgentStoredEvent, { kind: K }> => event.kind === kind);
}

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null | undefined>,
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

async function runTurn(title: string, responders: Responder[]) {
  const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "retry-workspace");
  const conversation = await agentRuntimeManager.createConversation(workspace, {
    backendId: "cesium-agent",
    mode: "agent",
    modelId: MODEL_ID,
    modelName: title,
  });
  scripted.push(...responders);
  const startRequests = agentRequestCount;
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Say something.");
  const snapshot = await waitFor(
    `${title} to settle`,
    () => readConversationSnapshot(workspace.id, conversation.id),
    (value) =>
      (value.conversation.status === "idle" || value.conversation.status === "failed") &&
      eventsOfKind(value.events, "user_message").length > 0 &&
      (value.conversation.status === "failed" ||
        eventsOfKind(value.events, "assistant_message_end").length > 0)
  );
  return { snapshot, requests: agentRequestCount - startRequests };
}

function retryStatuses(events: AgentStoredEvent[]): string[] {
  return eventsOfKind(events, "status")
    .map((event) => event.detail ?? "")
    .filter((detail) => detail.startsWith("Taking longer"));
}

test("a Projects turn retries an error chunk, a reasoning-only stream and blank text, then answers", async () => {
  const { snapshot, requests } = await runTurn("Recovers", [
    errorChunk({ message: "Service temporarily unavailable", type: "service_unavailable", code: 503 }),
    reasoningOnly("!!!!!!!!!!!!!!!!"),
    text("\n\n"),
    text("Recovered answer."),
  ]);
  assert.equal(snapshot.conversation.status, "idle", snapshot.conversation.lastError ?? "");
  assert.equal(requests, 4, "three retries, then the good reply");
  assert.deepEqual(retryStatuses(snapshot.events), [
    "Taking longer - retrying provider request (1/3)…",
    "Taking longer - retrying provider request (2/3)…",
    "Taking longer - retrying provider request (3/3)…",
  ]);
  const chunks = eventsOfKind(snapshot.events, "assistant_message_chunk").map((event) => event.text);
  assert.equal(chunks.join(""), "Recovered answer.", "nothing from the failed attempts reaches the transcript");
  assert.deepEqual(eventsOfKind(snapshot.events, "reasoning"), [], "the degenerate reasoning was discarded");
});

test("a retryable 200 JSON error body is retried like a stream error", async () => {
  const { snapshot, requests } = await runTurn("JSON body", [
    jsonError({ message: "Provider returned error", code: 502 }),
    text("Second try worked."),
  ]);
  assert.equal(snapshot.conversation.status, "idle", snapshot.conversation.lastError ?? "");
  assert.equal(requests, 2);
  assert.equal(retryStatuses(snapshot.events).length, 1);
});

test("retries are bounded: four empty replies fail the turn with the attempt count", async () => {
  const { snapshot, requests } = await runTurn("Exhausted", [
    emptyStream,
    reasoningOnly("!!!!"),
    emptyStream,
    emptyStream,
    text("never reached"),
  ]);
  assert.equal(snapshot.conversation.status, "failed");
  assert.equal(requests, 4, "one attempt plus three retries, no more");
  assert.equal(retryStatuses(snapshot.events).length, 3);
  assert.match(
    snapshot.conversation.lastError ?? "",
    /empty model response from retryhost\/kimi-k3 with no text and no tool calls after 4 attempts/
  );
});

test("an upstream error that retrying cannot fix fails at once with the provider's message", async () => {
  const { snapshot, requests } = await runTurn("Bad key", [
    errorChunk({ message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" }),
    text("never reached"),
  ]);
  assert.equal(snapshot.conversation.status, "failed");
  assert.equal(requests, 1);
  assert.deepEqual(retryStatuses(snapshot.events), []);
  assert.equal(
    snapshot.conversation.lastError,
    "retryhost/kimi-k3 returned an error instead of a reply: invalid_api_key: Incorrect API key provided"
  );
});

test("with Projects off an empty reply still fails the turn on the first attempt", async () => {
  process.env.CESIUM_PROJECTS_ENABLED = "0";
  const { snapshot, requests } = await runTurn("Projects off", [
    errorChunk({ message: "Service temporarily unavailable", code: 503 }),
    text("never reached"),
  ]);
  assert.equal(snapshot.conversation.status, "failed");
  assert.equal(requests, 1);
  assert.deepEqual(retryStatuses(snapshot.events), []);
  assert.match(
    snapshot.conversation.lastError ?? "",
    /^Cesium received an empty model response from retryhost\/kimi-k3 with no text and no tool calls\. /
  );
});
