import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-context-pruning-"));
const WORKSPACE_ROOT = path.join(TEST_DATA_DIR, "standalone-chats", "pruning");
await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
const bigFile = (label: string) =>
  Array.from({ length: 600 }, (_, index) => `${label} line ${String(index).padStart(4, "0")} ${"x".repeat(30)}`).join("\n");
for (const label of ["one", "two", "three"]) {
  await fs.writeFile(path.join(WORKSPACE_ROOT, `${label}.txt`), bigFile(label));
}

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
      res.end(JSON.stringify({ choices: [{ message: { content: "Pruning Test" } }] }));
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
process.env.CESIUM_API_KEY = "sk-test-pruning";
process.env.CESIUM_PROVIDER_ID = "prunehost";
process.env.CESIUM_MODELS = JSON.stringify([{ id: "tiny", contextWindow: 20_000 }]);
process.env.CESIUM_DEFAULT_MODEL = "tiny";
const MODEL_ID = "prunehost/tiny";

const [{ ensureWorkspaceRegistered }, { agentRuntimeManager }, { readConversationSnapshot }] =
  await Promise.all([
    import("../src/lib/workspace-registry.js"),
    import("../src/lib/agents/runtime-manager.js"),
    import("../src/lib/agents/session-store.js"),
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

function readTurn(id: string, file: string, promptTokens: number): Responder {
  return (res) =>
    sse(res, [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: file }) } },
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 20 } },
    ]);
}

function textTurn(text: string, promptTokens: number): Responder {
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

test("tool results shrink with the headroom and old ones are pruned once, at a boundary later requests extend", async () => {
  const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "pruning");
  const conversation = await agentRuntimeManager.createConversation(workspace, {
    backendId: "cesium-agent",
    modelId: MODEL_ID,
    modelName: "Tiny",
  });
  scripted.push(
    readTurn("call_one", "one.txt", 4_000),
    readTurn("call_two", "two.txt", 9_000),
    readTurn("call_three", "three.txt", 17_500),
    textTurn("Read all three.", 12_000)
  );
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Read one, two and three.");
  await waitForIdle(workspace.id, conversation.id, 1);
  scripted.push(textTurn("Yes, all three.", 12_500));
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Did you read them?");
  const snapshot = await waitForIdle(workspace.id, conversation.id, 2);

  assert.equal(agentRequests.length, 5);
  const [r1, r2, r3, r4, r5] = agentRequests.map((request) => request.messages);
  const extends_ = (current: ChatMessage[], previous: ChatMessage[]) =>
    assert.deepEqual(current.slice(0, previous.length), previous);
  extends_(r2!, r1!);
  extends_(r3!, r2!);

  const toolResult = (messages: ChatMessage[], id: string) =>
    messages.find((message) => message.role === "tool" && message.tool_call_id === id);
  const updates = snapshot.events.filter(
    (event): event is Extract<AgentStoredEvent, { kind: "tool_call_update" }> =>
      event.kind === "tool_call_update" && event.status === "completed"
  );
  const budgetOf = (id: string) =>
    (updates.find((event) => event.toolCallId === id)?.raw as { modelBudget?: number } | undefined)?.modelBudget;
  assert.equal(budgetOf("call_one"), 12_000, "a result over the cap keeps the per-result budget");
  assert.ok((budgetOf("call_two") ?? 0) < 12_000, "less headroom, smaller budget");
  assert.equal(budgetOf("call_three"), 2_000, "a nearly full window still leaves the floor");
  const spillPath = (updates.find((event) => event.toolCallId === "call_one")?.raw as { spillPath?: string }).spillPath!;
  assert.match(messageText(toolResult(r2!, "call_one")), new RegExp(`saved at ${spillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(
    await fs.readFile(spillPath, "utf8"),
    updates.find((event) => event.toolCallId === "call_one")?.detail,
    "the full output is kept for read_file"
  );

  const boundary = snapshot.events.find(
    (event): event is Extract<AgentStoredEvent, { kind: "compression_summary" }> =>
      event.kind === "compression_summary" && Boolean(event.prunedToolCallIds)
  );
  assert.deepEqual(boundary?.prunedToolCallIds, ["call_one"], "only results outside the newest two batches");

  const prunedIndex = r3!.findIndex((message) => message.role === "tool" && message.tool_call_id === "call_one");
  assert.deepEqual(r4!.slice(0, prunedIndex), r3!.slice(0, prunedIndex), "the boundary keeps everything before the pruned result");
  assert.match(messageText(r4![prunedIndex]), /^\[read_file output \(\d+ chars\) pruned to free context\. It is saved at /);
  assert.deepEqual(r4!.slice(prunedIndex + 1, r3!.length), r3!.slice(prunedIndex + 1), "and everything after it");
  assert.ok(r4!.length > r3!.length);

  extends_(r5!, r4!);
  assert.equal(messageText(r5!.at(-1)).endsWith("Did you read them?"), true);
});
