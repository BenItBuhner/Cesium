import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-event-log-storage-"));
const WORKSPACE_ROOT = path.join(TEST_DATA_DIR, "standalone-chats", "event-log");
await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
const MEDIUM = Array.from({ length: 400 }, (_, index) => `medium ${String(index).padStart(4, "0")} ${"m".repeat(40)}`).join("\n");
await fs.writeFile(path.join(WORKSPACE_ROOT, "medium.txt"), MEDIUM);
const HUGE = Array.from({ length: 900 }, (_, index) => `huge ${String(index).padStart(4, "0")} ${"h".repeat(90)}`).join("\n");
await fs.writeFile(path.join(WORKSPACE_ROOT, "huge.txt"), HUGE);

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
      res.end(JSON.stringify({ choices: [{ message: { content: "Event Log Test" } }] }));
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
process.env.CESIUM_API_KEY = "sk-test-event-log";
process.env.CESIUM_PROVIDER_ID = "eventloghost";
process.env.CESIUM_MODELS = JSON.stringify([{ id: "wide", contextWindow: 400_000 }]);
process.env.CESIUM_DEFAULT_MODEL = "wide";
const MODEL_ID = "eventloghost/wide";

const [
  { ensureWorkspaceRegistered },
  { agentRuntimeManager },
  { readConversationSnapshot },
  { normalizeEventsToHistory, normalizeCesiumToolResultForModel },
  { CesiumRawFrameLog },
  { findUpstreamErrorPayload },
  { hydrateToolResultBlobs, toolResultBlobPath },
  { agentRoutes },
  { WORKSPACE_ID_HEADER },
] = await Promise.all([
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/runtime-manager.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/agents/cesium/cesium-history.js"),
  import("../src/lib/agents/cesium/cesium-model-adapters.js"),
  import("../src/lib/agents/completion-retry.js"),
  import("../src/lib/agents/cesium/cesium-tool-result-blobs.js"),
  import("../src/routes/agents.js"),
  import("../src/lib/request-workspace.js"),
]);

after(async () => {
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

function toolTurn(id: string, name: string, args: Record<string, unknown>): Responder {
  return (res) =>
    sse(res, [
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
      { choices: [], usage: { prompt_tokens: 2_000, completion_tokens: 20 } },
    ]);
}

function streamedTextTurn(words: number): Responder {
  return (res) =>
    sse(res, [
      ...Array.from({ length: words }, (_, index) => ({
        id: "chatcmpl-words",
        choices: [{ index: 0, delta: { content: `word${index} ` } }],
      })),
      { id: "chatcmpl-words", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "chatcmpl-words", choices: [], usage: { prompt_tokens: 3_000, completion_tokens: words } },
    ]);
}

function textTurn(text: string): Responder {
  return (res) =>
    sse(res, [
      { choices: [{ index: 0, delta: { content: text } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 3_500, completion_tokens: 5 } },
    ]);
}

async function waitForIdle(workspaceId: string, conversationId: string, turns: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    const snapshot = await readConversationSnapshot(workspaceId, conversationId);
    const ended =
      snapshot?.events.filter((event: AgentStoredEvent) => event.kind === "assistant_message_end").length ?? 0;
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

async function newConversation() {
  const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "event-log");
  const conversation = await agentRuntimeManager.createConversation(workspace, {
    backendId: "cesium-agent",
    modelId: MODEL_ID,
    modelName: "Wide",
  });
  return { workspace, conversation };
}

function extendsPrevious(current: ChatMessage[], previous: ChatMessage[], label: string) {
  assert.deepEqual(current.slice(0, previous.length), previous, label);
}

function updatesOf(events: AgentStoredEvent[]) {
  return events.filter(
    (event): event is Extract<AgentStoredEvent, { kind: "tool_call_update" }> =>
      event.kind === "tool_call_update" && event.status === "completed"
  );
}

test("a tool result is stored once, in detail, and a turn keeps a frame summary instead of every frame", async () => {
  const { workspace, conversation } = await newConversation();
  const firstRequest = agentRequests.length;
  scripted.push(toolTurn("call_medium", "read_file", { path: "medium.txt" }), streamedTextTurn(300));
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Read medium.txt.");
  await waitForIdle(workspace.id, conversation.id, 1);
  scripted.push(textTurn("done"));
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Thanks.");
  const snapshot = await waitForIdle(workspace.id, conversation.id, 2);

  const [update] = updatesOf(snapshot.events);
  assert.ok(update?.detail?.startsWith("1|medium 0000"), "the full result is in detail");
  const raw = update!.raw as Record<string, unknown>;
  assert.equal("result" in raw, false, "raw no longer repeats the result");
  assert.equal((raw.request as { name?: string }).name, "read_file");

  const ends = snapshot.events.filter((event) => event.kind === "assistant_message_end");
  assert.equal(Array.isArray(ends[0]!.raw), false, "a reply with text keeps one frame, not all of them");
  assert.ok(JSON.stringify(ends[0]!.raw).length < 500, "and only its summary");

  const requests = agentRequests.slice(firstRequest).map((request) => request.messages);
  assert.equal(requests.length, 3);
  extendsPrevious(requests[1]!, requests[0]!, "the tool result request extends the first");
  extendsPrevious(requests[2]!, requests[1]!, "the rebuilt next turn extends the live requests");
});

test("history rebuilt from a log that also copied results to raw.result matches the single-copy log", () => {
  const base = { conversationId: "c1", createdAt: 1 };
  const request = { id: "call_old", name: "read_file", arguments: { path: "a.txt" } };
  const events = (updateRaw: Record<string, unknown>): AgentStoredEvent[] => [
    { ...base, seq: 1, eventId: "u", kind: "user_message", messageId: "m1", content: "Read a.txt" },
    {
      ...base,
      seq: 2,
      eventId: "t",
      kind: "tool_call",
      toolCallId: "call_old",
      title: "Read a.txt",
      toolKind: "read",
      status: "in_progress",
      detail: JSON.stringify(request.arguments),
      raw: request,
    },
    {
      ...base,
      seq: 3,
      eventId: "r",
      kind: "tool_call_update",
      toolCallId: "call_old",
      title: "Read a.txt",
      toolKind: "read",
      status: "completed",
      detail: "1|alpha\n2|beta",
      raw: updateRaw,
    },
    { ...base, seq: 4, eventId: "a", kind: "assistant_message_chunk", messageId: "m2", text: "Two lines." },
    { ...base, seq: 5, eventId: "e", kind: "assistant_message_end", messageId: "m2", stopReason: "end_turn" },
  ];
  const legacy = normalizeEventsToHistory(events({ request, result: "1|alpha\n2|beta" }));
  const current = normalizeEventsToHistory(events({ request }));
  assert.deepEqual(current, legacy);
  assert.equal(current.find((message) => message.role === "tool")?.content, "1|alpha\n2|beta");
});

test("a very large result is stored once as a blob and history rebuilt from the preview event is identical", async () => {
  const { workspace, conversation } = await newConversation();
  const firstRequest = agentRequests.length;
  scripted.push(toolTurn("call_huge", "read_file", { path: "huge.txt" }), textTurn("read it"));
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Read huge.txt.");
  await waitForIdle(workspace.id, conversation.id, 1);
  scripted.push(textTurn("done"));
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Thanks.");
  const snapshot = await waitForIdle(workspace.id, conversation.id, 2);

  const full = HUGE.split("\n").map((line, index) => `${index + 1}|${line}`).join("\n");
  const [update] = updatesOf(snapshot.events);
  const raw = update!.raw as { blobRef?: { sha256: string; chars: number }; spillPath?: string; modelBudget?: number };
  assert.equal(raw.blobRef?.chars, full.length, "the event references the full result");
  assert.ok((update!.detail?.length ?? 0) < 13_000, "and keeps only a preview");
  assert.ok(update!.detail?.startsWith("1|huge 0000"), "the preview starts with the result head");
  assert.ok(update!.detail?.endsWith(full.slice(-200)), "and ends with its tail");

  const blobPath = toolResultBlobPath(raw.blobRef!.sha256);
  assert.equal(await fs.readFile(blobPath, "utf8"), full, "the blob holds the full result");
  const [blobStat, spillStat] = await Promise.all([fs.stat(blobPath), fs.stat(raw.spillPath!)]);
  assert.equal(spillStat.ino, blobStat.ino, "the spill file is the blob, not a second copy");

  const requests = agentRequests.slice(firstRequest).map((request) => request.messages);
  assert.equal(requests.length, 3);
  const toolMessage = requests[1]!.find((message) => message.role === "tool");
  assert.equal(
    toolMessage?.content,
    normalizeCesiumToolResultForModel({ toolName: "read_file", result: full, budget: raw.modelBudget, spillPath: raw.spillPath }).content,
    "the model saw the full result's head, tail and omitted count"
  );
  extendsPrevious(requests[1]!, requests[0]!, "the tool result request extends the first");
  extendsPrevious(requests[2]!, requests[1]!, "the next turn, rebuilt from the preview event, extends the live requests");

  const hydrated = await hydrateToolResultBlobs(snapshot.events);
  assert.equal(updatesOf(hydrated)[0]!.detail, full, "loading on read restores the full result");
  assert.notEqual(updatesOf(snapshot.events)[0]!.detail, full, "without mutating the stored events");
  const singleCopy = snapshot.events.map((event) =>
    event === update ? ({ ...update, detail: full, raw: { ...raw, blobRef: undefined } } as AgentStoredEvent) : event
  );
  assert.deepEqual(normalizeEventsToHistory(hydrated), normalizeEventsToHistory(singleCopy));

  const missing = snapshot.events.map((event) =>
    event === update ? ({ ...update, raw: { ...raw, blobRef: { sha256: "0".repeat(64), chars: full.length } } } as AgentStoredEvent) : event
  );
  assert.equal(updatesOf(await hydrateToolResultBlobs(missing))[0]!.detail, update!.detail, "a missing blob keeps the preview");

  const route = `/api/agents/conversations/${conversation.id}/tool-results`;
  const headers = { [WORKSPACE_ID_HEADER]: workspace.id };
  const found = await agentRoutes.request(`${route}/call_huge`, { headers });
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), { toolCallId: "call_huge", content: full });
  assert.equal((await agentRoutes.request(`${route}/call_unknown`, { headers })).status, 404);
});

test("raw frames: an empty reply keeps its newest frames, a reply with output keeps a summary", () => {
  const empty = new CesiumRawFrameLog();
  for (let index = 0; index < 40; index += 1) {
    empty.record({ kind: "raw", raw: { choices: [{ index: 0, delta: {} }], n: index } });
  }
  empty.record({ kind: "raw", raw: { error: { message: "upstream overloaded", code: "overloaded" } } });
  const kept = empty.result() as unknown[];
  assert.equal(kept.length, 32, "bounded to the newest frames");
  assert.match(findUpstreamErrorPayload(kept)?.message ?? "", /upstream overloaded/);

  const full = new CesiumRawFrameLog();
  const completed = {
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "x".repeat(5_000) }] }],
      instructions: "system prompt ".repeat(500),
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
  full.record({ kind: "text_delta", text: "Hello", raw: { type: "response.output_text.delta", delta: "Hello" } });
  full.record({ kind: "usage", usage: { inputTokens: 10, outputTokens: 5 }, raw: completed });
  assert.deepEqual(full.result(), {
    type: "response.completed",
    response: { id: "resp_1", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } },
  });
});
