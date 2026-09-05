import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SIDE_CHAT_DELTA_MAX_CHARS,
  PRIMARY_CHAT_CONTEXT_TAG,
  SIDE_CHAT_REMINDER_REASON,
  buildSideChatReminderRaw,
  collectPrimaryChatDeltaLines,
  formatPrimaryChatDelta,
  formatPrimaryChatSeed,
  formatPrimaryChatUnavailable,
  readSideChatReminderRaw,
  sideChatDeliveryStateFromEvents,
} from "../src/lib/agents/side-chat/side-chat-context.js";
import { SideChatTail } from "../src/lib/agents/side-chat/side-chat-tail.js";
import { publish } from "../src/cache/pubsub.js";
import type { AgentManagerEvent, AgentStoredEvent } from "../src/lib/agents/types.js";

type EventInput = Omit<AgentStoredEvent, "eventId" | "conversationId" | "createdAt"> & {
  createdAt?: number;
};

const PARENT_ID = "primary-conv";

function ev(input: EventInput): AgentStoredEvent {
  return {
    eventId: `evt-${input.seq}`,
    conversationId: PARENT_ID,
    createdAt: input.createdAt ?? 1_000 + input.seq,
    ...input,
  } as AgentStoredEvent;
}

const primary = { conversationId: PARENT_ID, title: "Codex-Poly-Bot Scaling", status: "running" as const };

function sampleParentEvents(): AgentStoredEvent[] {
  return [
    ev({ seq: 1, kind: "user_message", messageId: "u1", content: "Please dig deep into the transcript." }),
    ev({
      seq: 2,
      kind: "system_reminder",
      reminderId: "mode-u1",
      targetMessageId: "u1",
      reason: "mode",
      text: "<system-reminder>huge mode reminder that must never leak</system-reminder>",
    }),
    ev({ seq: 3, kind: "reasoning", messageId: "a1", text: "secret thoughts" }),
    ev({ seq: 4, kind: "assistant_message_chunk", messageId: "a1", text: "The FADE-v3 pass " }),
    ev({ seq: 5, kind: "assistant_message_chunk", messageId: "a1", text: "finished (646 s)." }),
    ev({
      seq: 6,
      kind: "tool_call",
      toolCallId: "t1",
      title: "Read scratchpad.md",
      toolKind: "read",
      status: "in_progress",
    }),
    ev({
      seq: 7,
      kind: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      detail: "2,100 coherence-admitted reads",
    }),
    ev({ seq: 8, kind: "assistant_message_chunk", messageId: "a1", text: " Reading the results." }),
    ev({ seq: 9, kind: "assistant_message_end", messageId: "a1", stopReason: "end_turn" }),
    ev({ seq: 10, kind: "status", status: "running", detail: "Cesium is continuing after 8 tool calls…" }),
    ev({ seq: 11, kind: "status", status: "idle" }),
    ev({ seq: 12, kind: "user_message", messageId: "hidden", content: "auto-continue", hidden: true }),
  ];
}

test("delta lines drop reminders, reasoning, hidden prompts, and chatter statuses", () => {
  const lines = collectPrimaryChatDeltaLines(sampleParentEvents()).map((line) => line.text);
  assert.deepEqual(lines, [
    "User: Please dig deep into the transcript.",
    "Assistant: The FADE-v3 pass finished (646 s). [streaming, continues]",
    "Tool Read scratchpad.md: completed — 2,100 coherence-admitted reads",
    "Assistant: Reading the results.",
    "Primary finished its turn and is idle.",
  ]);
  assert.ok(!lines.join("\n").includes("huge mode reminder"));
  assert.ok(!lines.join("\n").includes("secret thoughts"));
  assert.ok(!lines.join("\n").includes("auto-continue"));
  assert.ok(!lines.join("\n").includes("continuing after 8 tool calls"));
});

test("a tool whose start and completion span two batches yields start then completion", () => {
  const events = sampleParentEvents();
  const first = collectPrimaryChatDeltaLines(events.filter((event) => event.seq <= 6));
  const second = collectPrimaryChatDeltaLines(events.filter((event) => event.seq === 7));
  assert.equal(first.at(-1)?.text, "Tool Read scratchpad.md: started");
  assert.equal(second[0]?.text, "Tool tool: completed — 2,100 coherence-admitted reads");
});

test("formatPrimaryChatDelta covers exactly the events after fromSeq and is deterministic", () => {
  const events = sampleParentEvents();
  const first = formatPrimaryChatDelta({ primary, events, fromSeq: 0 });
  const again = formatPrimaryChatDelta({ primary, events, fromSeq: 0 });
  assert.ok(first);
  assert.equal(first!.text, again!.text, "same inputs must produce byte-identical blocks");
  assert.equal(first!.fromSeq, 0);
  assert.equal(first!.throughSeq, 12);
  assert.match(first!.text, new RegExp(`^<${PRIMARY_CHAT_CONTEXT_TAG} kind="delta" `));
  assert.match(first!.text, /seq-range="1-12"/);
  assert.match(first!.text, /primary-status="running"/);
  assert.match(first!.text, /conversation-id="primary-conv"/);
  assert.ok(first!.text.trimEnd().endsWith(`</${PRIMARY_CHAT_CONTEXT_TAG}>`));

  const resumed = formatPrimaryChatDelta({ primary, events, fromSeq: 9 });
  assert.ok(resumed);
  assert.match(resumed!.text, /seq-range="10-12"/);
  assert.equal(resumed!.throughSeq, 12);
  assert.ok(resumed!.text.includes("Primary finished its turn and is idle."));
  assert.ok(!resumed!.text.includes("FADE-v3"));
});

test("formatPrimaryChatDelta returns null when the slice has nothing worth telling", () => {
  const events = sampleParentEvents().filter((event) => event.seq === 2 || event.seq === 3);
  assert.equal(formatPrimaryChatDelta({ primary, events, fromSeq: 0 }), null);
  assert.equal(formatPrimaryChatDelta({ primary, events: [], fromSeq: 0 }), null);
});

test("formatPrimaryChatDelta keeps the newest lines under budget and notes the elision", () => {
  const events: AgentStoredEvent[] = [];
  for (let index = 1; index <= 40; index += 1) {
    events.push(
      ev({
        seq: index,
        kind: "user_message",
        messageId: `u${index}`,
        content: `message ${index} ${"x".repeat(120)}`,
      })
    );
  }
  const result = formatPrimaryChatDelta({ primary, events, fromSeq: 0, maxChars: 1_600 });
  assert.ok(result);
  assert.ok(result!.text.length <= 1_600 + 200, `block too large: ${result!.text.length}`);
  assert.ok(result!.omittedLineCount > 0);
  assert.ok(result!.text.includes("message 40"), "newest line survives");
  assert.ok(!result!.text.includes("message 1 "), "oldest line is dropped");
  assert.match(result!.text, /earlier update\(s\) omitted for space/);
  assert.match(result!.text, /read_conversation "primary-conv"/);
  assert.equal(result!.throughSeq, 40);
});

test("default delta budget is respected for large tool output", () => {
  const events: AgentStoredEvent[] = [];
  for (let index = 1; index <= 200; index += 1) {
    events.push(
      ev({
        seq: index,
        kind: "tool_call_update",
        toolCallId: `t${index}`,
        title: `Shell ${index}`,
        status: "completed",
        detail: "y".repeat(2_000),
      })
    );
  }
  const result = formatPrimaryChatDelta({ primary, events, fromSeq: 0 });
  assert.ok(result);
  assert.ok(result!.text.length <= DEFAULT_SIDE_CHAT_DELTA_MAX_CHARS + 200);
  assert.ok(result!.text.includes("Shell 200"));
});

test("formatPrimaryChatSeed tail-truncates the transcript and labels the through-seq", () => {
  const transcript = `${"User: old stuff\n".repeat(500)}Assistant: newest line`;
  const seed = formatPrimaryChatSeed({ primary, transcript, throughSeq: 812, maxChars: 2_000 });
  assert.match(seed, new RegExp(`^<${PRIMARY_CHAT_CONTEXT_TAG} kind="seed" `));
  assert.match(seed, /through-seq="812"/);
  assert.match(seed, /Transcript truncated to the most recent 2000 characters/);
  assert.ok(seed.includes("Assistant: newest line"));
  assert.ok(seed.trimEnd().endsWith(`</${PRIMARY_CHAT_CONTEXT_TAG}>`));
  assert.equal(
    seed,
    formatPrimaryChatSeed({ primary, transcript, throughSeq: 812, maxChars: 2_000 }),
    "seed formatting is deterministic"
  );
});

test("attribute values are escaped", () => {
  const seed = formatPrimaryChatSeed({
    primary: { conversationId: "c", title: 'Say "hi" <now> & go', status: "idle" },
    transcript: "User: hello",
    throughSeq: 1,
  });
  assert.match(seed, /title="Say &quot;hi&quot; &lt;now&gt; &amp; go"/);
});

test("delivery state derives from persisted reminders", () => {
  const sideEvents: AgentStoredEvent[] = [
    {
      seq: 1,
      eventId: "s1",
      conversationId: "side",
      createdAt: 1,
      kind: "system_reminder",
      reminderId: "seed",
      reason: SIDE_CHAT_REMINDER_REASON,
      placement: "inline",
      text: "seed",
      raw: buildSideChatReminderRaw({
        kind: "seed",
        parentConversationId: PARENT_ID,
        fromSeq: 0,
        throughSeq: 40,
      }),
    },
    { seq: 2, eventId: "s2", conversationId: "side", createdAt: 2, kind: "user_message", messageId: "m", content: "hi" },
    {
      seq: 3,
      eventId: "s3",
      conversationId: "side",
      createdAt: 3,
      kind: "system_reminder",
      reminderId: "mode-m",
      targetMessageId: "m",
      reason: "mode",
      text: "mode",
      raw: { sideChat: { kind: "delta", parentConversationId: PARENT_ID, fromSeq: 0, throughSeq: 999 } },
    },
    {
      seq: 4,
      eventId: "s4",
      conversationId: "side",
      createdAt: 4,
      kind: "system_reminder",
      reminderId: "delta-1",
      targetMessageId: "m",
      reason: SIDE_CHAT_REMINDER_REASON,
      text: "delta",
      raw: buildSideChatReminderRaw({
        kind: "delta",
        parentConversationId: PARENT_ID,
        fromSeq: 40,
        throughSeq: 57,
      }),
    },
  ];
  const state = sideChatDeliveryStateFromEvents(sideEvents);
  assert.equal(state.cursor, 57, "mode reminders never count, even with side-chat-shaped raw");
  assert.equal(state.seeded, true);
  assert.equal(state.parentUnavailableNoticed, false);
  assert.deepEqual(sideChatDeliveryStateFromEvents([]), {
    cursor: 0,
    parentUnavailableNoticed: false,
    seeded: false,
  });
  assert.equal(readSideChatReminderRaw({ sideChat: { kind: "nope" } }), null);
  assert.equal(readSideChatReminderRaw(null), null);
});

const STORE_CHANNEL = "opencursor:agent:store-events";

async function publishParentEvent(event: AgentStoredEvent, workspaceId = "ws"): Promise<void> {
  const payload: AgentManagerEvent = {
    type: "event",
    workspaceId,
    conversationId: event.conversationId,
    event,
  };
  await publish(STORE_CHANNEL, payload);
}

test("SideChatTail buffers only newer parent events, dedupes, and honors discardThrough", async () => {
  const tail = new SideChatTail({ workspaceId: "ws", parentConversationId: PARENT_ID, sinceSeq: 5 });
  tail.attach();
  try {
    await publishParentEvent(ev({ seq: 4, kind: "status", status: "idle" }));
    await publishParentEvent(ev({ seq: 6, kind: "user_message", messageId: "u6", content: "six" }));
    await publishParentEvent(ev({ seq: 6, kind: "user_message", messageId: "u6", content: "six" }));
    await publishParentEvent(ev({ seq: 8, kind: "status", status: "idle" }));
    await publishParentEvent(ev({ seq: 7, kind: "assistant_message_chunk", messageId: "a", text: "seven" }));
    // Other conversations and other workspaces are ignored.
    await publishParentEvent(
      { ...ev({ seq: 9, kind: "status", status: "idle" }), conversationId: "someone-else" },
      "ws"
    );
    await publishParentEvent(ev({ seq: 10, kind: "status", status: "idle" }), "other-workspace");
    assert.equal(tail.hasPending(), true);

    tail.discardThrough(6);
    const drained = tail.drain();
    assert.deepEqual(
      drained.map((event) => event.seq),
      [7, 8],
      "seq 4 predates the cursor, 6 was discarded, 7/8 are delivered in order"
    );
    assert.equal(tail.throughSeq, 8);
    assert.equal(tail.hasPending(), false);
    assert.deepEqual(tail.drain(), []);

    await publish(STORE_CHANNEL, {
      type: "conversation_deleted",
      workspaceId: "ws",
      conversationId: PARENT_ID,
    } satisfies AgentManagerEvent);
    assert.equal(tail.parentDeleted, true);
  } finally {
    tail.detach();
  }
  await publishParentEvent(ev({ seq: 11, kind: "status", status: "idle" }));
  assert.equal(tail.hasPending(), false, "detached tails stop buffering");
});

test("unavailable notice is a one-shot block", () => {
  const text = formatPrimaryChatUnavailable(primary);
  assert.match(text, /kind="unavailable"/);
  assert.match(text, /no longer available/);
  const state = sideChatDeliveryStateFromEvents([
    {
      seq: 1,
      eventId: "s1",
      conversationId: "side",
      createdAt: 1,
      kind: "system_reminder",
      reminderId: "unavailable",
      reason: SIDE_CHAT_REMINDER_REASON,
      placement: "inline",
      text,
      raw: buildSideChatReminderRaw({
        kind: "unavailable",
        parentConversationId: PARENT_ID,
        fromSeq: 57,
        throughSeq: 57,
      }),
    },
  ]);
  assert.equal(state.parentUnavailableNoticed, true);
  assert.equal(state.cursor, 57);
});
