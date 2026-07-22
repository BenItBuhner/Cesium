import assert from "node:assert/strict";
import { test } from "node:test";
import { projectAgentEventsToChatMessages } from "../src/lib/agent-chat.ts";
import type { AgentStoredEvent } from "../src/lib/agent-types.ts";

test("Goal tools project to clean worked-session summaries", () => {
  const events: AgentStoredEvent[] = [
    {
      seq: 1,
      eventId: "user-1",
      conversationId: "conversation-1",
      createdAt: 1,
      kind: "user_message",
      messageId: "user-message-1",
      content: "Run goal mode",
    },
    {
      seq: 2,
      eventId: "tool-1",
      conversationId: "conversation-1",
      createdAt: 2,
      kind: "tool_call_update",
      toolCallId: "burn-progress-1",
      title: "Edit file",
      toolKind: "edit",
      status: "completed",
      raw: {
        request: {
          name: "goal_set",
          arguments: {
            planSummary: "Inspect workspace and record progress.",
            milestones: [
              { title: "Inspect workspace", status: "completed" },
              { title: "Record snapshot", status: "pending" },
            ],
            todos: [
              { title: "Run ls", status: "completed" },
              { title: "Summarize", status: "completed" },
            ],
            verificationEvidence: ["ls completed"],
          },
        },
      },
    },
    {
      seq: 3,
      eventId: "tool-2",
      conversationId: "conversation-1",
      createdAt: 3,
      kind: "tool_call_update",
      toolCallId: "burn-summary-1",
      title: "Tool call",
      toolKind: "tool",
      status: "completed",
      raw: {
        request: {
          name: "goal_summarize",
          arguments: {
            progressPercent: 66,
            headline: "Workspace inspected",
            summary: "## Progress\n- Done",
          },
        },
      },
    },
  ];

  const messages = projectAgentEventsToChatMessages(events);
  const worked = messages.find((message) => message.type === "worked-session");
  assert.ok(worked);
  assert.equal(worked.workedLabel, "Updated Goal 2 times");
  const tools = worked.workedEntries?.filter((entry) => entry.kind === "tool") ?? [];
  assert.equal(tools[0]?.toolKind, "goal");
  assert.equal(tools[0]?.title, "Set Goal");
  assert.equal(tools[0]?.detail, "Inspect workspace and record progress.");
  assert.equal(tools[0]?.editPreview, undefined);
  assert.equal(tools[1]?.toolKind, "goal");
  assert.equal(tools[1]?.title, "Summarize Goal");
  assert.equal(tools[1]?.detail, "66% · Workspace inspected");
});
