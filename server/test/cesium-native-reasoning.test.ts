import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-native-reasoning-"));
const WORKSPACE_ROOT = path.join(TEST_DATA_DIR, "standalone-chats", "native-reasoning");
await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
await fs.writeFile(path.join(WORKSPACE_ROOT, "notes.txt"), "alpha\nbeta\n");

for (const key of [
  "REDIS_URL",
  "DATABASE_URL",
  "OPENCURSOR_STORAGE_DRIVER",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CESIUM_BASE_URL",
  "CESIUM_API_KEY",
  "CESIUM_DEFAULT_MODEL",
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

type ResponsesRequest = { input: Array<Record<string, unknown>>; tools?: unknown[] };
type Responder = (res: ServerResponse) => void;

const scripted: Responder[] = [];
const agentRequests: ResponsesRequest[] = [];

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>));
  });
}

const modelServer = createServer(async (req, res) => {
  const body = await readBody(req);
  if (!Array.isArray(body.tools) || body.tools.length === 0) {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "Reasoning Test" } }],
        output_text: "Reasoning Test",
      })
    );
    return;
  }
  agentRequests.push(body as ResponsesRequest);
  const responder = scripted.shift();
  if (!responder) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "no scripted response left" } }));
    return;
  }
  responder(res);
});
await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
const MODEL_BASE_URL = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`;
const MODEL_ID = "openai/gpt-reasoning-test";

const [
  { ensureWorkspaceRegistered },
  { agentRuntimeManager },
  { readConversationSnapshot },
  { upsertCesiumProviderKey },
  { streamAdapter },
] = await Promise.all([
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/runtime-manager.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/cesium-agent-settings.js"),
  import("../src/lib/agents/cesium/cesium-model-adapters.js"),
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

function reasoningItem(id: string, text: string) {
  return { type: "reasoning", id, status: "completed", summary: [], content: [{ type: "reasoning_text", text }] };
}

function toolCallResponse(reasoning: string, callId: string, name: string, args: Record<string, unknown>): Responder {
  return (res) =>
    sse(res, [
      { type: "response.reasoning_text.delta", delta: reasoning },
      { type: "response.output_item.done", item: reasoningItem(`rs_${callId}`, reasoning) },
      {
        type: "response.output_item.done",
        item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: JSON.stringify(args) },
      },
      { type: "response.completed", response: { status: "completed", output: [] } },
    ]);
}

function textResponse(reasoning: string, text: string): Responder {
  return (res) =>
    sse(res, [
      { type: "response.reasoning_text.delta", delta: reasoning },
      { type: "response.output_item.done", item: reasoningItem("rs_final", reasoning) },
      { type: "response.output_text.delta", delta: text },
      { type: "response.completed", response: { status: "completed", output: [] } },
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

test("Responses reasoning items go back with their tool calls, in the turn and on later turns", async () => {
  await upsertCesiumProviderKey({
    providerId: "openai",
    apiKind: "openai-responses",
    apiKey: "sk-test-native-reasoning",
    baseUrl: MODEL_BASE_URL,
  });
  const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "native-reasoning");
  const conversation = await agentRuntimeManager.createConversation(workspace, {
    backendId: "cesium-agent",
    modelId: MODEL_ID,
    modelName: "Reasoning Test",
  });

  scripted.push(
    toolCallResponse("I should read notes.txt first.", "call_read", "read_file", { path: "notes.txt" }),
    toolCallResponse("Now glob for other text files.", "call_glob", "glob", { pattern: "*.txt" }),
    textResponse("Both calls are done; answer.", "The notes say alpha and beta.")
  );
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "What is in notes.txt?");
  await waitForIdle(workspace.id, conversation.id, 1);

  scripted.push(textResponse("Short recap.", "We read notes.txt."));
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Recap.");
  const snapshot = await waitForIdle(workspace.id, conversation.id, 2);

  assert.equal(agentRequests.length, 4);
  for (let index = 1; index < agentRequests.length; index += 1) {
    const previous = agentRequests[index - 1]!;
    const current = agentRequests[index]!;
    assert.deepEqual(current.tools, previous.tools, `request ${index + 1} keeps the tool list`);
    assert.deepEqual(
      current.input.slice(0, previous.input.length),
      previous.input,
      `request ${index + 1} extends request ${index} without rewriting it`
    );
  }

  const second = agentRequests[1]!.input;
  const readCallIndex = second.findIndex((item) => item.type === "function_call" && item.call_id === "call_read");
  assert.deepEqual(
    second[readCallIndex - 1],
    { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "I should read notes.txt first." }] },
    "the reasoning item opens its tool calls, without its id"
  );

  const last = agentRequests.at(-1)!.input;
  const reasoningTexts = last
    .filter((item) => item.type === "reasoning")
    .map((item) => ((item.content as Array<{ text: string }>)[0]!).text);
  assert.deepEqual(
    reasoningTexts,
    ["I should read notes.txt first.", "Now glob for other text files."],
    "the next turn repeats the tool batches' reasoning; the final answer's is not sent back"
  );
  assert.ok(
    last.every((item) => typeof item.content !== "string" || !item.content.includes("[Reasoning]")),
    "reasoning never turns into message text"
  );

  const shown = snapshot.events
    .filter((event: AgentStoredEvent) => event.kind === "reasoning")
    .map((event) => (event as Extract<AgentStoredEvent, { kind: "reasoning" }>).text)
    .join("");
  assert.match(shown, /I should read notes\.txt first\./, "streamed reasoning deltas are shown");
});

async function captureRequest(
  run: (baseUrl: string) => Promise<unknown>,
  reply: (res: ServerResponse) => void
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {};
  const server = createServer(async (req, res) => {
    captured = await readBody(req);
    reply(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return captured;
}

async function drain(input: Parameters<typeof streamAdapter>[0]): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  for await (const event of streamAdapter(input)) {
    events.push(event as Record<string, unknown>);
  }
  return events;
}

const tools = [{ name: "read_file", description: "Read a file.", parameters: { type: "object" } }];

test("Anthropic signed thinking is captured from the stream and opens its assistant content on replay", async () => {
  const signed = { type: "thinking", thinking: "Read the file.", signature: "sig-abc" };
  let events: Array<Record<string, unknown>> = [];
  await captureRequest(
    async (baseUrl) => {
      events = await drain({
        apiKind: "anthropic",
        apiKey: "sk-ant-test",
        baseUrl,
        providerId: "anthropic",
        modelId: "anthropic/claude-test",
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "read it" },
        ],
        tools,
      });
    },
    (res) =>
      sse(res, [
        { type: "message_start", message: { usage: { input_tokens: 10 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Read the file." } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque" } },
        { type: "content_block_stop", index: 1 },
        {
          type: "content_block_start",
          index: 2,
          content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' },
        },
        { type: "content_block_stop", index: 2 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
      ])
  );
  const native = events
    .filter((event) => event.kind === "native_reasoning")
    .flatMap((event) => (event.reasoning as { items: unknown[] }).items);
  assert.deepEqual(native, [signed, { type: "redacted_thinking", data: "opaque" }]);

  const body = await captureRequest(
    (baseUrl) =>
      drain({
        apiKind: "anthropic",
        apiKey: "sk-ant-test",
        baseUrl,
        providerId: "anthropic",
        modelId: "anthropic/claude-test",
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "read it" },
          {
            role: "assistant",
            content: "Reading.",
            toolCalls: [{ id: "toolu_1", name: "read_file", arguments: '{"path":"a.txt"}' }],
            nativeReasoning: { format: "anthropic", items: [signed] },
          },
          { role: "tool", toolCallId: "toolu_1", name: "read_file", content: "alpha" },
        ],
        tools,
      }),
    (res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
    }
  );
  const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  const assistant = messages.find((message) => message.role === "assistant")!;
  assert.deepEqual(
    assistant.content.map((block) => block.type),
    ["thinking", "text", "tool_use"]
  );
  assert.deepEqual(assistant.content[0], signed);
});

test("Responses reasoning replays only in its own format, and id-only items only where the host stores them", async () => {
  const assistantWith = (format: "openai-responses" | "anthropic") => ({
    role: "assistant" as const,
    content: "",
    toolCalls: [{ id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' }],
    nativeReasoning: { format, items: [{ type: format === "anthropic" ? "thinking" : "reasoning", summary: [] }] },
  });
  let events: Array<Record<string, unknown>> = [];
  const request = (messages: Parameters<typeof streamAdapter>[0]["messages"]) =>
    captureRequest(
      async (baseUrl) => {
        events = await drain({
          apiKind: "openai-responses",
          apiKey: "sk-test",
          baseUrl,
          providerId: "openai",
          modelId: "openai/gpt-test",
          messages,
          tools,
        });
      },
      (res) =>
        sse(res, [
          { type: "response.output_item.done", item: { type: "reasoning", id: "rs_ref", summary: [] } },
          { type: "response.output_text.delta", delta: "ok" },
          { type: "response.completed", response: { status: "completed", output: [] } },
        ])
    );
  const base = [
    { role: "system" as const, content: "system" },
    { role: "user" as const, content: "read it" },
  ];
  const foreign = await request([
    ...base,
    assistantWith("anthropic"),
    { role: "tool", toolCallId: "call_1", content: "a" },
  ]);
  assert.equal(
    (foreign.input as Array<Record<string, unknown>>).some(
      (item) => item.type === "thinking" || item.type === "reasoning"
    ),
    false,
    "another provider's reasoning is not sent"
  );
  assert.equal(
    events.some((event) => event.kind === "native_reasoning"),
    false,
    "an id-only item from a host that is not api.openai.com is not kept"
  );

  const own = await request([...base, assistantWith("openai-responses"), { role: "tool", toolCallId: "call_1", content: "a" }]);
  const input = own.input as Array<Record<string, unknown>>;
  assert.deepEqual(
    input.map((item) => item.type ?? item.role),
    ["developer", "user", "reasoning", "function_call", "function_call_output"]
  );
});
