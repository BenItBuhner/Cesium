import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-mid-turn-steer-"));
const WORKSPACE_ROOT = path.join(TEST_DATA_DIR, "standalone-chats", "steer-workspace");
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

type ChatMessage = {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
};
type ChatRequest = { messages: ChatMessage[]; tools?: unknown[]; stream?: boolean };
type Responder = (request: ChatRequest, res: ServerResponse) => Promise<void>;

const scripted: Responder[] = [];
const agentRequests: ChatRequest[] = [];

const modelServer = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    void (async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
      if (!Array.isArray(body.tools) || body.tools.length === 0) {
        // Side requests (title generation) never consume scripted agent turns.
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: "Steer Test" } }] }));
        return;
      }
      agentRequests.push(body);
      const responder = scripted.shift();
      if (!responder) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "no scripted response left" } }));
        return;
      }
      await responder(body, res);
    })();
  });
});
await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
const MODEL_PORT = (modelServer.address() as AddressInfo).port;

process.env.CESIUM_BASE_URL = `http://127.0.0.1:${MODEL_PORT}/v1`;
process.env.CESIUM_API_KEY = "sk-test-mid-turn-steer";
process.env.CESIUM_PROVIDER_ID = "steerhost";
process.env.CESIUM_DEFAULT_MODEL = "kimi-k3";
const MODEL_ID = "steerhost/kimi-k3";

const [
  { ensureWorkspaceRegistered },
  { agentRuntimeManager },
  { readConversationSnapshot },
  { startAgentPromptQueueDrainListener },
  { formatMidTurnSteer },
] = await Promise.all([
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/runtime-manager.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/agents/prompt-queue-drain.js"),
  import("../src/lib/agents/cesium-provider.js"),
]);

startAgentPromptQueueDrainListener();

after(async () => {
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

function writeSseHead(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
}

function writeSse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function toolCall(id: string, name: string, args: Record<string, unknown>): Responder {
  return async (_request, res) => {
    writeSseHead(res);
    writeSse(res, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
            ],
          },
        },
      ],
    });
    writeSse(res, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    res.end("data: [DONE]\n\n");
  };
}

function text(parts: string[], options: { delayMs?: number; onFirstChunk?: () => void } = {}): Responder {
  return async (_request, res) => {
    writeSseHead(res);
    for (const [index, part] of parts.entries()) {
      writeSse(res, { choices: [{ index: 0, delta: { content: part } }] });
      if (index === 0) {
        options.onFirstChunk?.();
      }
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
    }
    writeSse(res, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    res.end("data: [DONE]\n\n");
  };
}

function brokenStream(firstPart: string, options: { delayMs: number; onFirstChunk: () => void }): Responder {
  return async (_request, res) => {
    writeSseHead(res);
    writeSse(res, { choices: [{ index: 0, delta: { content: firstPart } }] });
    options.onFirstChunk();
    await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    res.destroy();
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

function messageText(message: ChatMessage | undefined): string {
  if (!message) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : ""
      )
      .join("");
  }
  return "";
}

function eventsOfKind<K extends AgentStoredEvent["kind"]>(
  events: AgentStoredEvent[],
  kind: K
): Array<Extract<AgentStoredEvent, { kind: K }>> {
  return events.filter((event): event is Extract<AgentStoredEvent, { kind: K }> => event.kind === kind);
}

async function newConversation(title: string) {
  const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "steer-workspace");
  const conversation = await agentRuntimeManager.createConversation(workspace, {
    backendId: "cesium-agent",
    mode: "agent",
    modelId: MODEL_ID,
    modelName: title,
  });
  return { workspace, conversationId: conversation.id };
}

function snapshotOf(workspaceId: string, conversationId: string) {
  return () => readConversationSnapshot(workspaceId, conversationId);
}

test("a mid-turn steer lands after the running tool result and before the next model call", async () => {
  const { workspace, conversationId } = await newConversation("Mid-turn steer");
  const startRequests = agentRequests.length;
  scripted.push(
    toolCall("call_wait_steer", "wait", { seconds: 1, reason: "hold the turn open" }),
    text(["Done: covered the edge case too."])
  );
  await agentRuntimeManager.promptConversation(workspace, conversationId, "Start the long task.");
  await waitFor(
    "wait tool to start",
    snapshotOf(workspace.id, conversationId),
    (snapshot) => eventsOfKind(snapshot.events, "tool_call").some((event) => event.toolCallId === "call_wait_steer")
  );

  const delivered = await agentRuntimeManager.deliverPrompt(
    workspace,
    conversationId,
    "Also cover the edge case.",
    { delivery: "steer", midTurnSteer: true }
  );
  assert.equal(delivered.outcome, "mid_turn");

  const snapshot = await waitFor(
    "steered turn to finish",
    snapshotOf(workspace.id, conversationId),
    (value) =>
      value.conversation.status === "idle" &&
      eventsOfKind(value.events, "assistant_message_end").some((event) => event.stopReason !== "steered")
  );
  assert.equal(agentRequests.length - startRequests, 2, "the steer rides the existing turn: no extra model call");
  assert.deepEqual(snapshot.conversation.queuedPrompts, [], "nothing was queued");

  const secondCall = agentRequests[startRequests + 1]!.messages;
  const steerText = formatMidTurnSteer("Also cover the edge case.");
  const toolIndex = secondCall.findIndex((message) => message.role === "tool" && message.tool_call_id === "call_wait_steer");
  const steerIndex = secondCall.findIndex((message) => message.role === "user" && messageText(message) === steerText);
  assert.ok(toolIndex >= 0, "tool result is in the second model call");
  assert.equal(steerIndex, secondCall.length - 1, "the steer is the newest message the model sees");
  assert.ok(steerIndex > toolIndex, "the steer comes after the tool result it interrupted");

  const steerEvent = eventsOfKind(snapshot.events, "user_message").find(
    (event) => event.displayContent === "Steer: Also cover the edge case."
  );
  assert.ok(steerEvent, "a visible steer user_message was persisted");
  assert.equal(steerEvent.content, steerText);
  const toolDone = eventsOfKind(snapshot.events, "tool_call_update").find(
    (event) => event.toolCallId === "call_wait_steer" && event.status === "completed"
  );
  assert.ok(toolDone && toolDone.seq < steerEvent.seq, "the tool completes before the steer is recorded");
  const steeredEnd = eventsOfKind(snapshot.events, "assistant_message_end").find(
    (event) => event.stopReason === "steered"
  );
  assert.ok(steeredEnd && steeredEnd.seq < steerEvent.seq, "pre-steer assistant output is closed first");
  const finalChunk = eventsOfKind(snapshot.events, "assistant_message_chunk").find((event) =>
    event.text.includes("covered the edge case")
  );
  assert.ok(finalChunk && finalChunk.seq > steerEvent.seq, "post-steer output streams after the steer");
  assert.notEqual(finalChunk.messageId, steeredEnd.messageId, "post-steer output uses a fresh message id");

  scripted.push(text(["Second turn reply."]));
  await agentRuntimeManager.promptConversation(workspace, conversationId, "Next thing please.");
  await waitFor(
    "follow-up turn to finish",
    snapshotOf(workspace.id, conversationId),
    (value) =>
      value.conversation.status === "idle" &&
      eventsOfKind(value.events, "assistant_message_chunk").some((event) => event.text.includes("Second turn reply"))
  );
  const rebuilt = agentRequests[startRequests + 2]!.messages;
  const rebuiltTool = rebuilt.findIndex((message) => message.role === "tool" && message.tool_call_id === "call_wait_steer");
  const rebuiltSteer = rebuilt.findIndex((message) => message.role === "user" && messageText(message).includes(steerText));
  const rebuiltFinal = rebuilt.findIndex(
    (message) => message.role === "assistant" && messageText(message).includes("covered the edge case")
  );
  const rebuiltNext = rebuilt.findIndex(
    (message) => message.role === "user" && messageText(message).includes("Next thing please.")
  );
  assert.ok(rebuiltTool >= 0 && rebuiltSteer >= 0 && rebuiltFinal >= 0 && rebuiltNext >= 0, "rebuilt history has every piece");
  assert.ok(
    rebuiltTool < rebuiltSteer && rebuiltSteer < rebuiltFinal && rebuiltFinal < rebuiltNext,
    "rebuilt history replays the steer exactly where the model saw it"
  );
});

test("a steer that arrives while the final answer streams keeps the turn going", async () => {
  const { workspace, conversationId } = await newConversation("Final answer race");
  const startRequests = agentRequests.length;
  const firstChunk = deferred();
  scripted.push(
    text(["Here is ", "the first ", "answer."], { delayMs: 250, onFirstChunk: firstChunk.resolve }),
    text(["Revised: using metric units."])
  );
  await agentRuntimeManager.promptConversation(workspace, conversationId, "Answer the question.");
  await firstChunk.promise;

  const delivered = await agentRuntimeManager.deliverPrompt(
    workspace,
    conversationId,
    "Use metric units.",
    { delivery: "steer", midTurnSteer: true }
  );
  assert.equal(delivered.outcome, "mid_turn");

  const snapshot = await waitFor(
    "race turn to finish",
    snapshotOf(workspace.id, conversationId),
    (value) =>
      value.conversation.status === "idle" &&
      eventsOfKind(value.events, "assistant_message_chunk").some((event) => event.text.includes("metric units"))
  );
  assert.equal(agentRequests.length - startRequests, 2);
  const secondCall = agentRequests[startRequests + 1]!.messages;
  assert.equal(messageText(secondCall.at(-1)), formatMidTurnSteer("Use metric units."));
  assert.equal(secondCall.at(-2)?.role, "assistant");
  assert.equal(messageText(secondCall.at(-2)), "Here is the first answer.");
  assert.deepEqual(snapshot.conversation.queuedPrompts, []);
  const steerEvent = eventsOfKind(snapshot.events, "user_message").find(
    (event) => event.displayContent === "Steer: Use metric units."
  );
  const steeredEnd = eventsOfKind(snapshot.events, "assistant_message_end").find(
    (event) => event.stopReason === "steered"
  );
  assert.ok(steerEvent && steeredEnd && steeredEnd.seq < steerEvent.seq);
});

test("deliverPrompt reports started, queued_steer, and queued, and the queue drains in order", async () => {
  const { workspace, conversationId } = await newConversation("Delivery outcomes");
  const startRequests = agentRequests.length;

  scripted.push(text(["Idle steer handled."]));
  const idle = await agentRuntimeManager.deliverPrompt(workspace, conversationId, "Prefer small commits.", {
    delivery: "steer",
    midTurnSteer: true,
  });
  assert.equal(idle.outcome, "started", "an idle conversation starts a turn instead of injecting");
  assert.ok(idle.head, "a started turn returns the snapshot head");
  const idleSnapshot = await waitFor(
    "idle steer turn",
    snapshotOf(workspace.id, conversationId),
    (value) => value.conversation.status === "idle" && agentRequests.length - startRequests === 1
  );
  const idleSteer = eventsOfKind(idleSnapshot.events, "user_message").find(
    (event) => event.displayContent === "Steer: Prefer small commits."
  );
  assert.ok(idleSteer, "idle steer keeps the Steer: label");

  scripted.push(
    toolCall("call_wait_busy", "wait", { seconds: 1, reason: "stay busy" }),
    text(["First turn done."]),
    text(["Queued steer done."]),
    text(["Queued follow-up done."])
  );
  await agentRuntimeManager.promptConversation(workspace, conversationId, "Busy work.");
  await waitFor(
    "busy wait tool",
    snapshotOf(workspace.id, conversationId),
    (value) => eventsOfKind(value.events, "tool_call").some((event) => event.toolCallId === "call_wait_busy")
  );
  const queuedSteer = await agentRuntimeManager.deliverPrompt(workspace, conversationId, "Rename the helper.", {
    delivery: "steer",
  });
  assert.equal(queuedSteer.outcome, "queued_steer", "without midTurnSteer a busy steer waits for the next turn");
  const queued = await agentRuntimeManager.deliverPrompt(workspace, conversationId, "Then write docs.", {
    delivery: "queue",
  });
  assert.equal(queued.outcome, "queued");
  const withQueue = await readConversationSnapshot(workspace.id, conversationId);
  assert.deepEqual(
    withQueue?.conversation.queuedPrompts.map((entry) => [entry.text, entry.delivery ?? "normal"]),
    [
      ["Rename the helper.", "steer"],
      ["Then write docs.", "normal"],
    ]
  );

  const drained = await waitFor(
    "queue to drain",
    snapshotOf(workspace.id, conversationId),
    (value) =>
      value.conversation.status === "idle" &&
      value.conversation.queuedPrompts.length === 0 &&
      eventsOfKind(value.events, "assistant_message_chunk").some((event) => event.text.includes("Queued follow-up done"))
  );
  assert.equal(agentRequests.length - startRequests, 5);
  const steerTurn = agentRequests[startRequests + 3]!.messages;
  assert.match(messageText(steerTurn.at(-1)), /Steering message from the user\.[\s\S]*Rename the helper\./);
  const queueTurn = agentRequests[startRequests + 4]!.messages;
  assert.match(messageText(queueTurn.at(-1)), /Then write docs\./);
  const labels = eventsOfKind(drained.events, "user_message").map((event) => event.displayContent ?? event.content);
  assert.deepEqual(labels.slice(-3), ["Busy work.", "Steer: Rename the helper.", "Then write docs."]);
});

test("a steer accepted before the turn fails goes back on the queue instead of vanishing", async () => {
  const { workspace, conversationId } = await newConversation("Failed turn requeue");
  const firstChunk = deferred();
  scripted.push(brokenStream("Partial ", { delayMs: 300, onFirstChunk: firstChunk.resolve }));
  await agentRuntimeManager.promptConversation(workspace, conversationId, "This turn will break.");
  await firstChunk.promise;
  const delivered = await agentRuntimeManager.deliverPrompt(workspace, conversationId, "Keep this steer.", {
    delivery: "steer",
    midTurnSteer: true,
  });
  assert.equal(delivered.outcome, "mid_turn");
  const failed = await waitFor(
    "turn to fail",
    snapshotOf(workspace.id, conversationId),
    (value) => value.conversation.status === "failed" && value.conversation.queuedPrompts.length > 0
  );
  assert.deepEqual(
    failed.conversation.queuedPrompts.map((entry) => [entry.text, entry.delivery]),
    [["Keep this steer.", "steer"]]
  );
  assert.equal(
    eventsOfKind(failed.events, "user_message").some((event) => event.displayContent === "Steer: Keep this steer."),
    false,
    "the model never saw it, so no steer message is recorded in the transcript"
  );
});
