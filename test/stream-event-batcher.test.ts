import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentStoredEvent } from "../src/lib/agent-types.ts";
import {
  KeyedEventBatcher,
  STREAM_EVENT_BATCH_WINDOW_MS,
  type EventBatchMap,
} from "../src/lib/stream-event-batcher.ts";
import {
  compactAdjacentAgentMessageChunks,
  mergeAgentConversationEventMap,
  shouldFlushAgentEventRenderBatch,
} from "../src/components/chat/AgentConversationsContext.tsx";

type ScheduledTask = {
  id: number;
  callback: () => void;
  delayMs: number;
};

function createFakeScheduler() {
  let nextId = 1;
  const tasks = new Map<number, ScheduledTask>();
  return {
    schedule(callback: () => void, delayMs: number) {
      const task = { id: nextId++, callback, delayMs };
      tasks.set(task.id, task);
      return task.id as unknown as ReturnType<typeof globalThis.setTimeout>;
    },
    cancel(handle: ReturnType<typeof globalThis.setTimeout>) {
      tasks.delete(handle as unknown as number);
    },
    runNext() {
      const task = tasks.values().next().value as ScheduledTask | undefined;
      assert.ok(task, "expected a scheduled flush");
      tasks.delete(task.id);
      task.callback();
      return task.delayMs;
    },
    count() {
      return tasks.size;
    },
  };
}

function chunkEvent(conversationId: string, seq: number): AgentStoredEvent {
  return {
    seq,
    eventId: `${conversationId}-${seq}`,
    conversationId,
    createdAt: seq,
    kind: "assistant_message_chunk",
    messageId: `message-${conversationId}`,
    text: "x",
  };
}

test("batches 2,000 events/sec across eight concurrent conversations into 20 updates", () => {
  const scheduler = createFakeScheduler();
  let state: Record<string, AgentStoredEvent[]> = {};
  let flushes = 0;
  let committedEvents = 0;
  const batcher = new KeyedEventBatcher<AgentStoredEvent>({
    enabled: true,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    onFlush: (batches) => {
      flushes += 1;
      for (const events of batches.values()) {
        committedEvents += events.length;
      }
      state = mergeAgentConversationEventMap(state, batches);
    },
  });

  const conversations = 8;
  const eventsPerConversation = 2_000;
  const eventsPerWindow =
    conversations * eventsPerConversation * (STREAM_EVENT_BATCH_WINDOW_MS / 1_000);
  let queuedInWindow = 0;

  for (let seq = 1; seq <= eventsPerConversation; seq += 1) {
    for (let index = 0; index < conversations; index += 1) {
      const conversationId = `conversation-${index}`;
      batcher.enqueue(conversationId, [chunkEvent(conversationId, seq)]);
      queuedInWindow += 1;
      assert.equal(scheduler.count(), 1, "all sessions must share one flush timer");
      if (queuedInWindow === eventsPerWindow) {
        assert.equal(scheduler.runNext(), STREAM_EVENT_BATCH_WINDOW_MS);
        queuedInWindow = 0;
      }
    }
  }

  assert.equal(flushes, 20);
  assert.equal(committedEvents, conversations * eventsPerConversation);
  assert.equal(batcher.pendingEventCount(), 0);
  for (let index = 0; index < conversations; index += 1) {
    const stored = state[`conversation-${index}`];
    assert.equal(stored?.length, 1);
    assert.equal(
      stored?.[0]?.kind === "assistant_message_chunk"
        ? stored[0].text.length
        : 0,
      eventsPerConversation
    );
    assert.equal(stored?.[0]?.seq, eventsPerConversation);
  }
});

test("disabled batching preserves immediate per-event updates", () => {
  const flushed: EventBatchMap<number>[] = [];
  const batcher = new KeyedEventBatcher<number>({
    enabled: false,
    onFlush: (batches) => flushed.push(batches),
  });

  batcher.enqueue("foreground", [1]);
  batcher.enqueue("background", [2]);

  assert.equal(flushed.length, 2);
  assert.deepEqual([...flushed[0]!.entries()], [["foreground", [1]]]);
  assert.deepEqual([...flushed[1]!.entries()], [["background", [2]]]);
});

test("disabling batching flushes queued events before switching modes", () => {
  const flushed: Array<Array<[string, number[]]>> = [];
  const batcher = new KeyedEventBatcher<number>({
    enabled: true,
    onFlush: (batches) => flushed.push([...batches.entries()]),
  });

  batcher.enqueue("conversation", [1, 2]);
  batcher.setEnabled(false);
  batcher.enqueue("conversation", [3]);

  assert.deepEqual(flushed, [
    [["conversation", [1, 2]]],
    [["conversation", [3]]],
  ]);
});

test("control and lifecycle events flush queued stream payload immediately", () => {
  assert.equal(
    shouldFlushAgentEventRenderBatch([chunkEvent("conversation", 1)]),
    false
  );
  assert.equal(
    shouldFlushAgentEventRenderBatch([
      {
        seq: 2,
        eventId: "end",
        conversationId: "conversation",
        createdAt: 2,
        kind: "assistant_message_end",
        messageId: "message-conversation",
      },
    ]),
    true
  );
  assert.equal(
    shouldFlushAgentEventRenderBatch([
      {
        seq: 3,
        eventId: "permission",
        conversationId: "conversation",
        createdAt: 3,
        kind: "permission_request",
        requestId: "request",
        options: [],
      },
    ]),
    true
  );
  assert.equal(
    shouldFlushAgentEventRenderBatch([
      {
        seq: 4,
        eventId: "tool-running",
        conversationId: "conversation",
        createdAt: 4,
        kind: "tool_call_update",
        toolCallId: "tool",
        status: "in_progress",
      },
    ]),
    false
  );
  assert.equal(
    shouldFlushAgentEventRenderBatch([
      {
        seq: 5,
        eventId: "tool-complete",
        conversationId: "conversation",
        createdAt: 5,
        kind: "tool_call_update",
        toolCallId: "tool",
        status: "completed",
      },
    ]),
    true
  );
});

test("compacts only adjacent chunks from the same assistant message", () => {
  const events: AgentStoredEvent[] = [
    chunkEvent("conversation", 1),
    { ...chunkEvent("conversation", 2), text: "y" },
    {
      seq: 3,
      eventId: "tool",
      conversationId: "conversation",
      createdAt: 3,
      kind: "tool_call_update",
      toolCallId: "tool",
      status: "running",
    },
    { ...chunkEvent("conversation", 4), text: "z" },
  ];

  const compacted = compactAdjacentAgentMessageChunks(events);

  assert.equal(compacted.length, 3);
  assert.deepEqual(compacted[0], {
    ...events[1],
    text: "xy",
  });
  assert.equal(compacted[1], events[2]);
  assert.equal(compacted[2], events[3]);
});

test("live map merging compacts chunks across consecutive render windows", () => {
  const first = mergeAgentConversationEventMap(
    {},
    new Map([
      ["conversation", [chunkEvent("conversation", 1)]],
    ])
  );
  const second = mergeAgentConversationEventMap(
    first,
    new Map([
      [
        "conversation",
        [
          { ...chunkEvent("conversation", 2), text: "y" },
          { ...chunkEvent("conversation", 3), text: "z" },
        ],
      ],
    ])
  );

  assert.equal(second.conversation?.length, 1);
  assert.deepEqual(second.conversation?.[0], {
    ...chunkEvent("conversation", 3),
    text: "xyz",
  });
});
