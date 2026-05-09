import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentBackendId, AgentStoredEvent } from "../src/lib/agent-types";
import { hasAgentBackendIconAsset } from "../src/lib/agent-backend-icons";
import { SUBAGENT_TOOL_CALL_CLASSIFIERS } from "../src/lib/agent-subagent-routing";

test("opencode server frontend wiring uses opencode icon and classifier", () => {
  const id: AgentBackendId = "opencode-server";
  assert.equal(hasAgentBackendIconAsset(id), true);
  assert.equal(typeof SUBAGENT_TOOL_CALL_CLASSIFIERS[id], "function");
  assert.equal(
    SUBAGENT_TOOL_CALL_CLASSIFIERS[id]({
      kind: "tool_call",
      toolCallId: "task_1",
      title: "Task",
      toolKind: "task",
      status: "in_progress",
      raw: {
        tool: "task",
        rawInput: { description: "Inspect files", prompt: "go", subagent_type: "general" },
      },
    }),
    true
  );
});

test("assistant chunks after message end are ignored", async () => {
  const { projectAgentEventsToChatMessages } = await import("../src/lib/agent-chat.ts");
  const base = { conversationId: "c1", createdAt: 0 };
  const events: AgentStoredEvent[] = [
    {
      ...base,
      seq: 1,
      eventId: "u1",
      kind: "user_message",
      messageId: "u1",
      content: "Run diagnostics",
    },
    {
      ...base,
      seq: 2,
      eventId: "a1",
      kind: "assistant_message_chunk",
      messageId: "a1",
      text: "Initial answer.",
    },
    {
      ...base,
      seq: 3,
      eventId: "e1",
      kind: "assistant_message_end",
      messageId: "a1",
      stopReason: "completed",
    },
    {
      ...base,
      seq: 4,
      eventId: "late",
      kind: "assistant_message_chunk",
      messageId: "a1",
      text: " Late duplicate.",
    },
  ];
  const messages = projectAgentEventsToChatMessages(events);

  const assistant = messages.find((message) => message.type === "assistant");
  assert.equal(assistant?.content, "Initial answer.");
});
