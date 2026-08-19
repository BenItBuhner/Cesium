import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentStoredEvent } from "../src/lib/agent-types.ts";

test("extractLiveSubagentTranscriptFromMessages prefers latest matching subagent card", async () => {
  const { extractLiveSubagentTranscriptFromMessages } = await import("../src/lib/agent-chat.ts");
  const projected = [
    { id: "u1", type: "user", content: "hi" },
    {
      id: "s1",
      type: "subagent",
      subagentId: "child-a",
      subagentTitle: "Task A",
      subagentStatus: "running",
      subagentTranscript: [{ id: "t1", type: "assistant", content: "old" }],
    },
    {
      id: "s2",
      type: "subagent",
      subagentId: "child-a",
      subagentTitle: "Task A",
      subagentStatus: "completed",
      subagentTranscript: [{ id: "t2", type: "assistant", content: "new" }],
    },
  ] as const;
  const r = extractLiveSubagentTranscriptFromMessages(projected as never, "child-a");
  assert.ok(r);
  assert.equal(r?.subagentRunning, false);
  assert.equal(r?.transcript.length, 2);
  assert.equal(r?.transcript[0]?.content, "old");
  assert.equal(r?.transcript[1]?.content, "new");
});

function subagentTranscriptRows(input: {
  toolStatuses: Array<"in_progress" | "completed" | "failed">;
  finalText?: string;
}): AgentStoredEvent[] {
  const rows: AgentStoredEvent[] = [
    {
      seq: 1,
      eventId: "sub-user-event",
      conversationId: "c1",
      createdAt: 1,
      kind: "user_message",
      messageId: "sub-user-message",
      content: "child task",
    },
  ];
  input.toolStatuses.forEach((status, index) => {
    rows.push({
      seq: rows.length + 1,
      eventId: `sub-tool-event-${index + 1}`,
      conversationId: "c1",
      createdAt: 2 + index,
      kind: "tool_call",
      toolCallId: `sub-tool-${index + 1}`,
      title: `tool_${index + 1}`,
      toolKind: "mcp",
      status,
      detail: status === "in_progress" ? "" : `result ${index + 1}`,
    });
  });
  if (input.finalText) {
    rows.push({
      seq: rows.length + 1,
      eventId: "sub-final-event",
      conversationId: "c1",
      createdAt: 99,
      kind: "assistant_message_chunk",
      messageId: "sub-final-message",
      text: input.finalText,
    });
  }
  return rows;
}

function liveProgressEvents(): AgentStoredEvent[] {
  return [
    {
      seq: 1,
      eventId: "u1",
      conversationId: "c1",
      createdAt: 1,
      kind: "user_message",
      messageId: "m1",
      content: "Delegate",
    },
    // Spawn card: transcript holds just the child task.
    {
      seq: 2,
      eventId: "s1",
      conversationId: "c1",
      createdAt: 2,
      kind: "subagent",
      subagentId: "child-live",
      title: "Live child",
      status: "running",
      transcript: subagentTranscriptRows({ toolStatuses: [] }),
    },
    // Progress: first tool in flight.
    {
      seq: 3,
      eventId: "s2",
      conversationId: "c1",
      createdAt: 3,
      kind: "subagent",
      subagentId: "child-live",
      title: "Live child",
      status: "running",
      transcript: subagentTranscriptRows({ toolStatuses: ["in_progress"] }),
    },
    // Progress: first tool settled, second in flight.
    {
      seq: 4,
      eventId: "s3",
      conversationId: "c1",
      createdAt: 4,
      kind: "subagent",
      subagentId: "child-live",
      title: "Live child",
      status: "running",
      transcript: subagentTranscriptRows({ toolStatuses: ["completed", "in_progress"] }),
    },
  ];
}

test("live running subagent cards grow the merged transcript instead of freezing on the first snapshot", async () => {
  const { projectAgentEventsToChatMessages } = await import("../src/lib/agent-chat.ts");
  const projected = projectAgentEventsToChatMessages(liveProgressEvents(), {
    backendId: "cesium-agent",
  });
  const cards = projected.filter((message) => message.type === "subagent");
  assert.equal(cards.length, 1);
  const card = cards[0]!;
  assert.equal(card.subagentStatus, "running");
  const worked = (card.subagentTranscript ?? []).filter(
    (row) => row.type === "worked-session" && !row.loading
  );
  const entries = worked.flatMap((row) => row.workedEntries ?? []);
  const toolEntries = entries.filter((entry) => entry.kind === "tool");
  assert.equal(
    toolEntries.length,
    2,
    "merged card must show every tool from the newest running snapshot"
  );
  assert.deepEqual(
    toolEntries.map((entry) => (entry.kind === "tool" ? entry.status : "?")),
    ["completed", "running"]
  );
});

test("extract keeps live rows while running and drops Working placeholders once settled", async () => {
  const { extractLiveSubagentTranscriptFromMessages, projectAgentEventsToChatMessages } =
    await import("../src/lib/agent-chat.ts");

  const runningProjected = projectAgentEventsToChatMessages(liveProgressEvents(), {
    backendId: "cesium-agent",
  });
  const running = extractLiveSubagentTranscriptFromMessages(runningProjected, "child-live");
  assert.ok(running);
  assert.equal(running?.subagentRunning, true);
  const runningTools = (running?.transcript ?? [])
    .filter((row) => row.type === "worked-session")
    .flatMap((row) => row.workedEntries ?? [])
    .filter((entry) => entry.kind === "tool");
  assert.equal(runningTools.length, 2);

  const settledEvents: AgentStoredEvent[] = [
    ...liveProgressEvents(),
    {
      seq: 5,
      eventId: "s4",
      conversationId: "c1",
      createdAt: 5,
      kind: "subagent",
      subagentId: "child-live",
      title: "Live child",
      status: "completed",
      transcript: subagentTranscriptRows({
        toolStatuses: ["completed", "completed"],
        finalText: "All done.",
      }),
    },
  ];
  const settledProjected = projectAgentEventsToChatMessages(settledEvents, {
    backendId: "cesium-agent",
  });
  const settled = extractLiveSubagentTranscriptFromMessages(settledProjected, "child-live");
  assert.ok(settled);
  assert.equal(settled?.subagentRunning, false);
  assert.ok(
    settled?.transcript.every((row) => !(row.type === "worked-session" && row.loading)),
    "settled transcript must not keep live Working placeholder rows"
  );
  const settledTools = (settled?.transcript ?? [])
    .filter((row) => row.type === "worked-session")
    .flatMap((row) => row.workedEntries ?? [])
    .filter((entry) => entry.kind === "tool");
  assert.deepEqual(
    settledTools.map((entry) => (entry.kind === "tool" ? entry.status : "?")),
    ["completed", "completed"]
  );
  assert.ok(
    settled?.transcript.some(
      (row) => row.type === "assistant" && row.content?.includes("All done.")
    ),
    "final summary text must appear in the settled transcript"
  );
});

test("projectAgentEventsToChatMessages merges duplicate subagent cards by id", async () => {
  const { projectAgentEventsToChatMessages } = await import("../src/lib/agent-chat.ts");
  const events: AgentStoredEvent[] = [
    {
      seq: 1,
      eventId: "u1",
      conversationId: "c1",
      createdAt: 1,
      kind: "user_message",
      messageId: "m1",
      content: "Delegate",
    },
    {
      seq: 2,
      eventId: "s1",
      conversationId: "c1",
      createdAt: 2,
      kind: "subagent",
      subagentId: "child-a",
      title: "Subagent",
      status: "running",
      transcript: [
        {
          seq: 1,
          eventId: "a1",
          conversationId: "child-a",
          createdAt: 1,
          kind: "assistant_message_chunk",
          messageId: "am1",
          text: "first",
        },
      ],
    },
    {
      seq: 3,
      eventId: "s2",
      conversationId: "c1",
      createdAt: 3,
      kind: "subagent",
      subagentId: "child-a",
      title: "Specific child task",
      status: "completed",
      transcript: [
        {
          seq: 1,
          eventId: "a2",
          conversationId: "child-a",
          createdAt: 1,
          kind: "assistant_message_chunk",
          messageId: "am2",
          text: "second",
        },
      ],
    },
  ];

  const projected = projectAgentEventsToChatMessages(events, { backendId: "cesium-agent" });
  const subagents = projected.filter((message) => message.type === "subagent");
  assert.equal(subagents.length, 1);
  assert.equal(subagents[0]?.subagentTitle, "Specific child task");
  assert.equal(subagents[0]?.subagentStatus, "completed");
  assert.equal(subagents[0]?.subagentTranscript?.length, 2);
});
