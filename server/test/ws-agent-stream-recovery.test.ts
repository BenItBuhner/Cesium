import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-ws-agent-recovery-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

const [
  { ensureWorkspaceRegistered },
  { appendConversationEvents, saveConversationRecord },
  { attachAgentSocket },
  { BufferedRuntimeSocket },
] = await Promise.all([
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/ws/agent.js"),
  import("../src/ws/runtime-socket.js"),
]);

import type {
  AgentConversationRecord,
  AgentSocketServerMessage,
} from "../src/lib/agents/types.js";

function makeConversationRecord(
  workspaceId: string
): AgentConversationRecord {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id: randomUUID(),
    workspaceId,
    title: "recovery test",
    createdAt: now,
    updatedAt: now,
    lastEventSeq: 0,
    status: "idle",
    config: { backendId: "cesium-agent", mode: "agent" },
    providerSessionId: null,
    configOptions: [],
    capabilities: {
      supportsLoadSession: false,
      supportsModeSelection: false,
      supportsModelSelection: false,
      supportsSlashCommands: false,
      supportsPermissions: false,
      supportsToolCalls: false,
      supportsStructuredPlans: false,
      supportsTodos: false,
      supportsSessionResume: false,
      supportsPromptImages: false,
      supportsInlineReasoning: false,
      supportsCompletionRetry: false,
    },
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: false,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
  };
}

type TestClient = {
  socket: InstanceType<typeof BufferedRuntimeSocket>;
  frames: AgentSocketServerMessage[];
  setBufferedAmount: (bytes: number) => void;
  sendClientMessage: (message: unknown) => void;
};

function connectTestClient(workspaceId: string): TestClient {
  const frames: AgentSocketServerMessage[] = [];
  let bufferedAmount = 0;
  const socket = new BufferedRuntimeSocket(
    (data) => {
      frames.push(JSON.parse(String(data)) as AgentSocketServerMessage);
    },
    () => {},
    () => bufferedAmount
  );
  attachAgentSocket(socket, workspaceId);
  return {
    socket,
    frames,
    setBufferedAmount: (bytes) => {
      bufferedAmount = bytes;
    },
    sendClientMessage: (message) => {
      socket.dispatchMessage(JSON.stringify(message), false);
    },
  };
}

async function waitFor<T>(
  probe: () => T | undefined,
  label: string,
  timeoutMs = 5_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await delay(25);
  }
}

function chunkInput(text: string, messageId: string) {
  return {
    kind: "assistant_message_chunk" as const,
    eventId: randomUUID(),
    createdAt: Date.now(),
    messageId,
    text,
  };
}

const BACKPRESSURED_BYTES = 4 * 1024 * 1024;

test("subscribe cursor replays chunked non-droppable batches and acks with events_delta_done", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const conversation = makeConversationRecord(workspace.id);
  await saveConversationRecord(conversation);
  await appendConversationEvents(workspace.id, conversation.id, [
    chunkInput("alpha ", "m1"),
    chunkInput("beta ", "m1"),
    chunkInput("gamma", "m1"),
  ]);

  const client = connectTestClient(workspace.id);
  // A backpressured socket must still receive the resume replay - the
  // subscribe cursor IS the reconnect heal path.
  client.setBufferedAmount(BACKPRESSURED_BYTES);
  client.sendClientMessage({
    type: "subscribe",
    conversationIds: [conversation.id],
    sinceByConversationId: { [conversation.id]: 1 },
  });

  const done = await waitFor(
    () =>
      client.frames.find(
        (frame): frame is AgentSocketServerMessage & { type: "events_delta_done" } =>
          frame.type === "events_delta_done" &&
          frame.conversationId === conversation.id
      ),
    "subscribe events_delta_done"
  );
  assert.equal(done.sinceSeq, 1);
  assert.equal(done.throughSeq, 3);

  const replayed = client.frames
    .filter(
      (frame): frame is AgentSocketServerMessage & { type: "event_batch" } =>
        frame.type === "event_batch" && frame.conversationId === conversation.id
    )
    .flatMap((frame) => frame.events.map((event) => event.seq));
  assert.deepEqual(replayed, [2, 3]);

  client.socket.dispatchClose();
});

test("dropped live frames surface a coalesced events_dropped marker and recover via non-droppable delta", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const conversation = makeConversationRecord(workspace.id);
  await saveConversationRecord(conversation);
  await appendConversationEvents(workspace.id, conversation.id, [
    chunkInput("hello ", "m1"),
  ]);

  const client = connectTestClient(workspace.id);
  client.sendClientMessage({
    type: "subscribe",
    conversationIds: [conversation.id],
    sinceByConversationId: { [conversation.id]: 1 },
  });
  await waitFor(
    () =>
      client.frames.find((frame) => frame.type === "events_delta_done") !== undefined
        ? true
        : undefined,
    "initial subscribe ack"
  );
  const framesBeforeDrop = client.frames.length;

  // Congest the socket, then stream two live events: both batches must be
  // dropped and replaced by one tiny events_dropped marker.
  client.setBufferedAmount(BACKPRESSURED_BYTES);
  await appendConversationEvents(workspace.id, conversation.id, [
    chunkInput("lost-one ", "m1"),
  ]);
  await appendConversationEvents(workspace.id, conversation.id, [
    chunkInput("lost-two", "m1"),
  ]);

  const marker = await waitFor(
    () =>
      client.frames.find(
        (frame): frame is AgentSocketServerMessage & { type: "events_dropped" } =>
          frame.type === "events_dropped" &&
          frame.conversationId === conversation.id
      ),
    "events_dropped marker"
  );
  assert.equal(marker.throughSeq, 3);
  const liveBatches = client.frames
    .slice(framesBeforeDrop)
    .filter((frame) => frame.type === "event_batch");
  assert.equal(
    liveBatches.length,
    0,
    "live batches should have been dropped under backpressure"
  );

  // Recovery must go through even while the socket is still backpressured.
  const framesBeforeRecovery = client.frames.length;
  client.sendClientMessage({
    type: "request_events_since",
    conversationId: conversation.id,
    sinceSeq: 1,
  });
  const done = await waitFor(
    () =>
      client.frames
        .slice(framesBeforeRecovery)
        .find(
          (frame): frame is AgentSocketServerMessage & { type: "events_delta_done" } =>
            frame.type === "events_delta_done" && frame.sinceSeq === 1
        ),
    "recovery events_delta_done"
  );
  assert.equal(done.throughSeq, 3);
  const recovered = client.frames
    .filter(
      (frame): frame is AgentSocketServerMessage & { type: "event_batch" } =>
        frame.type === "event_batch" && frame.conversationId === conversation.id
    )
    .flatMap((frame) => frame.events)
    .filter((event) => event.seq > 1)
    .map((event) => (event.kind === "assistant_message_chunk" ? event.text : ""));
  assert.deepEqual(recovered, ["lost-one ", "lost-two"]);

  client.socket.dispatchClose();
});

test("pong reports the latest seq for subscribed conversations", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const conversation = makeConversationRecord(workspace.id);
  await saveConversationRecord(conversation);
  await appendConversationEvents(workspace.id, conversation.id, [
    chunkInput("one ", "m1"),
    chunkInput("two", "m1"),
  ]);

  const client = connectTestClient(workspace.id);
  client.sendClientMessage({
    type: "subscribe",
    conversationIds: [conversation.id],
    sinceByConversationId: { [conversation.id]: 2 },
  });
  await waitFor(
    () =>
      client.frames.some((frame) => frame.type === "events_delta_done")
        ? true
        : undefined,
    "subscribe ack before ping"
  );

  client.sendClientMessage({ type: "ping" });
  const pong = await waitFor(
    () =>
      client.frames.find(
        (frame): frame is AgentSocketServerMessage & { type: "pong" } =>
          frame.type === "pong"
      ),
    "pong"
  );
  assert.equal(pong.latestSeqByConversationId?.[conversation.id], 2);

  client.socket.dispatchClose();
});
