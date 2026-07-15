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
