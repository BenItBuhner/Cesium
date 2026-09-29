import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-prompt-cache-"));
const WORKSPACE_ROOT = path.join(TEST_DATA_DIR, "standalone-chats", "prompt-cache");
await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
await fs.writeFile(path.join(WORKSPACE_ROOT, "notes.txt"), "alpha\nbeta\n");
await fs.writeFile(path.join(WORKSPACE_ROOT, "AGENTS.md"), "# Rules\n\nAlways be brief.\n");

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
type ChatRequest = {
  messages: ChatMessage[];
  tools?: unknown[];
  prompt_cache_key?: string;
  stream_options?: { include_usage?: boolean };
};
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
      res.end(JSON.stringify({ choices: [{ message: { content: "Cache Test" } }] }));
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
process.env.CESIUM_API_KEY = "sk-test-prompt-cache";
process.env.CESIUM_PROVIDER_ID = "cachehost";
process.env.CESIUM_DEFAULT_MODEL = "kimi-k3";
const MODEL_ID = "cachehost/kimi-k3";

const [
  { ensureWorkspaceRegistered },
  { agentRuntimeManager },
  { readConversationSnapshot },
  history,
  reminders,
  { streamAdapter },
] = await Promise.all([
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/runtime-manager.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/agents/cesium/cesium-history.js"),
  import("../src/lib/agents/cesium-reminders.js"),
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

type ChatUsage = { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens: number } };

function usageChunk(usage: ChatUsage | undefined): unknown[] {
  return usage ? [{ choices: [], usage }] : [];
}

function toolCallTurn(
  textBefore: string,
  id: string,
  name: string,
  args: Record<string, unknown>,
  usage?: ChatUsage
): Responder {
  return (res) =>
    sse(res, [
      { choices: [{ index: 0, delta: { reasoning_content: `Thinking about ${name}.` } }] },
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
      ...usageChunk(usage),
    ]);
}

function textTurn(text: string, usage?: ChatUsage): Responder {
  return (res) =>
    sse(res, [
      { choices: [{ index: 0, delta: { reasoning_content: "Wrapping up." } }] },
      { choices: [{ index: 0, delta: { content: text } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ...usageChunk(usage),
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
      snapshot?.events.filter(
        (event: AgentStoredEvent) => event.kind === "assistant_message_end"
      ).length ?? 0;
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

test("every request extends the previous one byte for byte across turns", async () => {
  const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "prompt-cache");
  const conversation = await agentRuntimeManager.createConversation(workspace, {
    backendId: "cesium-agent",
    modelId: MODEL_ID,
    modelName: "Kimi K3",
  });

  scripted.push(
    toolCallTurn("Let me read the notes.", "call_read", "read_file", { path: "notes.txt" }),
    textTurn("The notes say alpha and beta.")
  );
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "What is in notes.txt?");
  await waitForIdle(workspace.id, conversation.id, 1);

  scripted.push(
    toolCallTurn("I will track this.", "call_todo", "todo", {
      action: "replace",
      items: [{ content: "Summarize notes", status: "completed" }],
    }),
    textTurn("Tracked.")
  );
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Track that as a todo.");
  await waitForIdle(workspace.id, conversation.id, 2);

  scripted.push(textTurn("We read notes.txt and tracked a todo."));
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Summarize what we did.");
  await waitForIdle(workspace.id, conversation.id, 3);

  assert.equal(agentRequests.length, 5);
  for (let index = 1; index < agentRequests.length; index += 1) {
    const previous = agentRequests[index - 1]!;
    const current = agentRequests[index]!;
    assert.deepEqual(current.tools, previous.tools, `request ${index + 1} keeps the tool list`);
    assert.deepEqual(
      current.messages.slice(0, previous.messages.length),
      previous.messages,
      `request ${index + 1} extends request ${index} without rewriting it`
    );
  }

  const final = agentRequests.at(-1)!.messages;
  const users = final.filter((message) => message.role === "user").map(messageText);
  assert.equal(users.length, 3, "each user turn appears exactly once");
  assert.match(users[0]!, /## Project Instruction Files[\s\S]*Always be brief/);
  for (const later of users.slice(1)) {
    assert.doesNotMatch(later, /## Project Instruction Files/, "unchanged context is not re-sent");
    assert.match(later, /## Current Environment/);
  }
  assert.ok(final.every((message) => !messageText(message).includes("[Reasoning]")), "reasoning is not replayed");
  const readCall = final.find(
    (message) => message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0
  );
  assert.equal(messageText(readCall), "Let me read the notes.", "text streamed with the call stays on it");
  assert.equal(
    final.filter((message) => message.role === "tool").length,
    2,
    "the todo plan event does not split its tool call"
  );
});

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function imageUrls(message: ChatMessage | undefined): string[] {
  if (!Array.isArray(message?.content)) {
    return [];
  }
  return (message.content as Array<{ type?: string; image_url?: { url?: string } }>)
    .filter((part) => part.type === "image_url")
    .map((part) => part.image_url?.url ?? "");
}

test("a tool image stays in history on later turns, exactly as the model saw it", async () => {
  await fs.writeFile(path.join(WORKSPACE_ROOT, "pixel.png"), Buffer.from(ONE_PIXEL_PNG, "base64"));
  const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "prompt-cache");
  const conversation = await agentRuntimeManager.createConversation(workspace, {
    backendId: "cesium-agent",
    modelId: MODEL_ID,
    modelName: "Kimi K3",
  });
  const firstRequest = agentRequests.length;
  scripted.push(
    toolCallTurn("Opening the image.", "call_image", "read_file", { path: "pixel.png" }),
    textTurn("It is a single pixel.")
  );
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "What is in pixel.png?");
  await waitForIdle(workspace.id, conversation.id, 1);
  scripted.push(textTurn("Still one pixel."));
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "And now?");
  await waitForIdle(workspace.id, conversation.id, 2);

  const requests = agentRequests.slice(firstRequest);
  assert.equal(requests.length, 3);
  for (let index = 1; index < requests.length; index += 1) {
    assert.deepEqual(
      requests[index]!.messages.slice(0, requests[index - 1]!.messages.length),
      requests[index - 1]!.messages,
      `request ${index + 1} extends request ${index}`
    );
  }
  const final = requests.at(-1)!.messages;
  const toolIndex = final.findIndex((message) => message.role === "tool");
  const imageMessage = final[toolIndex + 1];
  assert.equal(imageMessage?.role, "user");
  assert.deepEqual(imageUrls(imageMessage), [`data:image/png;base64,${ONE_PIXEL_PNG}`]);
});

test("a turn with several tool batches rebuilds each as its own assistant message", async () => {
  const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "prompt-cache");
  const conversation = await agentRuntimeManager.createConversation(workspace, {
    backendId: "cesium-agent",
    modelId: MODEL_ID,
    modelName: "Kimi K3",
  });
  const firstRequest = agentRequests.length;
  scripted.push(
    toolCallTurn("", "call_batch_one", "read_file", { path: "notes.txt" }),
    toolCallTurn("", "call_batch_two", "read_file", { path: "AGENTS.md" }),
    toolCallTurn("Checking once more.", "call_batch_three", "read_file", { path: "notes.txt" }),
    textTurn("Both files read.")
  );
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Read notes.txt, then AGENTS.md.");
  await waitForIdle(workspace.id, conversation.id, 1);
  scripted.push(textTurn("Yes."));
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Done?");
  await waitForIdle(workspace.id, conversation.id, 2);

  const requests = agentRequests.slice(firstRequest);
  assert.equal(requests.length, 5);
  for (let index = 1; index < requests.length; index += 1) {
    assert.deepEqual(
      requests[index]!.messages.slice(0, requests[index - 1]!.messages.length),
      requests[index - 1]!.messages,
      `request ${index + 1} extends request ${index}`
    );
  }
});

test("provider-reported usage lands on the message end and sizes the context", async () => {
  const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "prompt-cache");
  const conversation = await agentRuntimeManager.createConversation(workspace, {
    backendId: "cesium-agent",
    modelId: MODEL_ID,
    modelName: "Kimi K3",
  });
  const firstRequest = agentRequests.length;
  scripted.push(
    toolCallTurn("Reading.", "call_usage_read", "read_file", { path: "notes.txt" }, {
      prompt_tokens: 3_000,
      completion_tokens: 20,
    }),
    textTurn("Alpha and beta.", {
      prompt_tokens: 3_100,
      completion_tokens: 12,
      prompt_tokens_details: { cached_tokens: 2_900 },
    })
  );
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Read notes.txt.");
  const snapshot = await waitForIdle(workspace.id, conversation.id, 1);

  for (const request of agentRequests.slice(firstRequest)) {
    assert.equal(request.stream_options?.include_usage, true, "streams ask for usage");
  }
  const end = snapshot.events.find(
    (event): event is Extract<AgentStoredEvent, { kind: "assistant_message_end" }> =>
      event.kind === "assistant_message_end"
  );
  assert.deepEqual(end?.usage, {
    inputTokens: 3_100,
    outputTokens: 12,
    cachedInputTokens: 2_900,
    modelId: MODEL_ID,
  });
  assert.deepEqual(end?.turnUsage, {
    inputTokens: 6_100,
    outputTokens: 32,
    cachedInputTokens: 2_900,
    responses: 2,
  });

  const usage = await agentRuntimeManager.getConversationContextUsage(workspace, conversation.id);
  assert.equal(usage?.usedTokens, 3_112, "the ring shows the provider's count");
  assert.equal(usage?.approximate, false);
  assert.equal(
    history.reportedContextTokens(history.selectHistoryWindow(snapshot.events).events, MODEL_ID),
    3_112
  );
  assert.equal(
    history.reportedContextTokens(snapshot.events, "cachehost/other-model"),
    null,
    "another model's tokenizer does not carry over"
  );
});

function reminderEvent(
  seq: number,
  targetMessageId: string,
  reason: "context" | "mode" | "linked_conversation",
  text: string,
  raw?: unknown
): AgentStoredEvent {
  return {
    seq,
    eventId: `r${seq}`,
    conversationId: "c1",
    createdAt: seq,
    kind: "system_reminder",
    reminderId: `r${seq}`,
    targetMessageId,
    reason,
    text,
    ...(raw ? { raw } : {}),
  } as AgentStoredEvent;
}

function userEvent(seq: number, messageId: string, content: string): AgentStoredEvent {
  return {
    seq,
    eventId: `u${seq}`,
    conversationId: "c1",
    createdAt: seq,
    kind: "user_message",
    messageId,
    content,
  } as AgentStoredEvent;
}

test("context reminders stay on their turns; legacy mode reminders keep newest-only until superseded", () => {
  const legacyOnly = [
    userEvent(1, "m1", "one"),
    reminderEvent(2, "m1", "mode", "old full"),
    userEvent(3, "m2", "two"),
    reminderEvent(4, "m2", "mode", "new full"),
  ];
  const legacy = history.selectTargetedReminders(legacyOnly);
  assert.equal(legacy.get("m1"), undefined);
  assert.equal(legacy.get("m2")?.[0]?.text, "new full");

  const mixed = [
    ...legacyOnly,
    userEvent(5, "m3", "three"),
    reminderEvent(6, "m3", "context", "full context", { contextReminder: "full" }),
    reminderEvent(7, "m3", "linked_conversation", "side chat tail"),
    userEvent(8, "m4", "four"),
    reminderEvent(9, "m4", "context", "delta", { contextReminder: "delta" }),
  ];
  const selected = history.selectTargetedReminders(mixed);
  assert.equal(selected.get("m2"), undefined, "legacy reminders are superseded");
  assert.deepEqual(selected.get("m3")?.map((event) => event.text), ["full context", "side chat tail"]);
  assert.deepEqual(selected.get("m4")?.map((event) => event.text), ["delta"]);
});

test("a delta baseline needs a full context reminder inside the window", () => {
  const full = reminderEvent(2, "m1", "context", "full", {
    contextReminder: "full",
    contextSectionHashes: { instructions: "a", skills: "b" },
  });
  const delta = reminderEvent(4, "m2", "context", "delta", {
    contextReminder: "delta",
    contextSectionHashes: { instructions: "c", skills: "b" },
  });
  assert.equal(history.latestContextReminderBaseline([]), null);
  assert.equal(history.latestContextReminderBaseline([delta]), null, "deltas alone are no baseline");
  assert.deepEqual(history.latestContextReminderBaseline([full, delta]), { instructions: "c", skills: "b" });

  const summary = {
    seq: 10,
    eventId: "s10",
    conversationId: "c1",
    createdAt: 10,
    kind: "compression_summary",
    messageId: "cmp",
    summary: "earlier work",
    retainedTurnCount: 1,
    compressedTurnCount: 1,
    sourceRange: { fromSeq: 1, toSeq: 3 },
  } as AgentStoredEvent;
  const window = history.selectHistoryWindow([userEvent(1, "m1", "one"), full, userEvent(3, "m2", "two"), delta, summary]);
  assert.equal(window.summary?.seq, 10);
  assert.deepEqual(window.events.map((event) => event.seq), [4]);
  assert.equal(
    history.latestContextReminderBaseline(window.events),
    null,
    "after compaction the full reminder is gone, so the next one is full again"
  );
});

test("only changed context sections are re-sent", () => {
  const input = {
    workspaceRoot: "/ws",
    dateLabel: "today",
    gitSummary: "clean",
    mcpSummaries: [],
    agentsMarkdown: "# Rules",
    skillsList: "- skill-a",
  };
  const sections = reminders.buildCesiumContextSections(input);
  const hashes = reminders.hashCesiumReminderSections(sections);
  assert.equal(reminders.changedCesiumReminderSections(sections, null).length, sections.length);
  assert.deepEqual(reminders.changedCesiumReminderSections(sections, hashes), []);
  const edited = reminders.buildCesiumContextSections({ ...input, agentsMarkdown: "# Rules v2" });
  assert.deepEqual(
    reminders.changedCesiumReminderSections(edited, hashes).map((section) => section.id),
    ["instructions"]
  );
  const delta = reminders.renderCesiumTurnReminder({
    facts: reminders.buildCesiumTurnFacts(input),
    sections: [],
  });
  assert.match(delta, /## Current Environment/);
  assert.doesNotMatch(delta, /## Skills/);
});

async function captureRequest(
  run: (baseUrl: string) => Promise<unknown>,
  reply: unknown
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {};
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      captured = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return captured;
}

async function drain(input: Parameters<typeof streamAdapter>[0]): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of streamAdapter(input)) {
    events.push(event);
  }
  return events;
}

const cacheMessages = [
  { role: "system" as const, content: "system prompt" },
  { role: "user" as const, content: "hello" },
];
const cacheTools = [{ name: "read_file", description: "Read a file.", parameters: { type: "object" } }];

test("prompt_cache_key goes to first-party OpenAI only", async () => {
  const chatReply = { choices: [{ message: { content: "ok" } }] };
  const openai = await captureRequest(
    (baseUrl) =>
      drain({
        apiKind: "openai-chat-completions",
        apiKey: "sk-test",
        baseUrl,
        providerId: "openai",
        modelId: "openai/gpt-5.1",
        messages: cacheMessages,
        tools: cacheTools,
        promptCacheKey: "conv-1",
      }),
    chatReply
  );
  assert.equal(openai.prompt_cache_key, "conv-1");
  const proxy = await captureRequest(
    (baseUrl) =>
      drain({
        apiKind: "openai-compatible",
        apiKey: "sk-test",
        baseUrl,
        providerId: "cachehost",
        modelId: "cachehost/kimi-k3",
        messages: cacheMessages,
        tools: cacheTools,
        promptCacheKey: "conv-1",
      }),
    chatReply
  );
  assert.equal("prompt_cache_key" in proxy, false, "strict compatible hosts never see the field");
});

test("Anthropic requests mark system, last tool, and newest message as cache breakpoints", async () => {
  const body = await captureRequest(
    (baseUrl) =>
      drain({
        apiKind: "anthropic",
        apiKey: "sk-ant-test",
        baseUrl,
        providerId: "anthropic",
        modelId: "anthropic/claude-sonnet-5",
        messages: cacheMessages,
        tools: cacheTools,
        promptCacheKey: "conv-1",
      }),
    { content: [{ type: "text", text: "ok" }] }
  );
  const system = body.system as Array<Record<string, unknown>>;
  assert.deepEqual(system.at(-1)?.cache_control, { type: "ephemeral" });
  const tools = body.tools as Array<Record<string, unknown>>;
  assert.deepEqual(tools.at(-1)?.cache_control, { type: "ephemeral" });
  const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
  assert.deepEqual(messages.at(-1)?.content.at(-1)?.cache_control, { type: "ephemeral" });
});

test("the compaction digest coalesces streamed chunks and skips turn context", () => {
  const chunk = (seq: number, text: string) =>
    ({
      seq,
      eventId: `a${seq}`,
      conversationId: "c1",
      createdAt: seq,
      kind: "assistant_message_chunk",
      messageId: "a1",
      text,
    }) as AgentStoredEvent;
  const digest = history.summarizeForCompression([
    userEvent(1, "m1", "Fix the login bug"),
    reminderEvent(2, "m1", "context", "<system-reminder>## Project Instruction Files ...</system-reminder>", {
      contextReminder: "full",
    }),
    chunk(3, "Looking "),
    chunk(4, "at auth.ts "),
    chunk(5, "now."),
  ]);
  assert.equal(digest, "User: Fix the login bug\nAssistant: Looking at auth.ts now.");
});
