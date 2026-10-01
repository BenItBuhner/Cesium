import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-workflow-tools-"));
const WORKSPACE_ROOT = path.join(TEST_DATA_DIR, "standalone-chats", "workflow");
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
      res.end(JSON.stringify({ choices: [{ message: { content: "Workflow Test" } }] }));
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
process.env.CESIUM_BASE_URL = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`;
process.env.CESIUM_API_KEY = "sk-test-workflow";
process.env.CESIUM_PROVIDER_ID = "wfhost";
process.env.CESIUM_DEFAULT_MODEL = "kimi-k3";
const MODEL_ID = "wfhost/kimi-k3";

const [
  { ensureWorkspaceRegistered },
  { agentRuntimeManager },
  { appendConversationEvents, readConversationSnapshot },
  goals,
  ledger,
  orchestration,
  { getStorage },
] = await Promise.all([
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/runtime-manager.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/agents/goal-store.js"),
  import("../src/lib/agents/work-ledger.js"),
  import("../src/lib/orchestration/store.js"),
  import("../src/storage/runtime.js"),
]);

after(async () => {
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

await fs.writeFile(path.join(WORKSPACE_ROOT, "notes.txt"), "alpha\nbeta\n");
const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "workflow");

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
            delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
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

async function waitForIdle(conversationId: string, turns: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
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

function messageText(message: ChatMessage | undefined): string {
  return typeof message?.content === "string" ? message.content : "";
}


test("a workflow agent works with the parent's tools and its card shows the calls", async () => {
  const conversation = await agentRuntimeManager.createConversation(workspace, { backendId: "cesium-agent", modelId: MODEL_ID });
  await getStorage();
  const script = [
    "export const meta = { name: 'notes', description: 'read notes', phases: ['read'] };",
    "const first = await agent('Read notes.txt and reply with its first line only.', { label: 'reader' });",
    "return { first };",
  ].join("\n");
  const firstParent = agentRequests.length;
  scripted.push(
    toolTurn("call_wf", "workflow_run", { script, wait: true }),
    toolTurn("call_read", "read_file", { path: "notes.txt" }),
    textTurn("alpha"),
    textTurn("The first line is alpha.")
  );
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Run the notes workflow.");
  const snapshot = await waitForIdle(conversation.id, 1);

  const sent = agentRequests.slice(firstParent);
  assert.equal(sent.length, 4);
  const [parentFirst, childFirst, childSecond, parentSecond] = sent;
  assert.ok(
    (childFirst!.tools ?? []).some((tool) => JSON.stringify(tool).includes('"read_file"')),
    "the workflow agent is offered the workspace tools"
  );
  assert.deepEqual(
    childSecond!.messages.slice(0, childFirst!.messages.length),
    childFirst!.messages,
    "the agent's own loop is a pure append"
  );
  const readResult = childSecond!.messages.find((message) => message.role === "tool");
  assert.match(messageText(readResult), /1\|alpha/);
  assert.deepEqual(
    parentSecond!.messages.slice(0, parentFirst!.messages.length),
    parentFirst!.messages,
    "the parent's next request extends its previous one"
  );
  const workflowResult = parentSecond!.messages.find((message) => message.role === "tool" && message.tool_call_id === "call_wf");
  assert.match(messageText(workflowResult), /alpha/);

  const cards = snapshot.events.filter((event) => event.kind === "subagent");
  const last = cards.at(-1);
  assert.equal(last?.kind === "subagent" ? last.status : null, "completed");
  assert.ok(
    last?.kind === "subagent" && last.transcript.some((event) => event.kind === "tool_call" && event.status === "completed"),
    "the card's transcript has the read_file call"
  );
});
