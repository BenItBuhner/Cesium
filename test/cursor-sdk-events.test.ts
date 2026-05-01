import assert from "node:assert/strict";
import { test } from "node:test";

test("Cursor SDK raw grep tool payload renders as a worked-session search row", async () => {
  const { projectAgentEventsToChatMessages } = await import("../src/lib/agent-chat.ts");
  const base = { conversationId: "c1", eventId: "", createdAt: 0 };
  const messages = projectAgentEventsToChatMessages(
    [
      {
        ...base,
        seq: 1,
        eventId: "u1",
        kind: "user_message",
        messageId: "m1",
        content: "search for normalize",
      },
      {
        ...base,
        seq: 2,
        eventId: "t1",
        kind: "tool_call",
        toolCallId: "call-1",
        title: "Grep normalize",
        toolKind: "grep",
        status: "in_progress",
        raw: {
          type: "tool_call",
          name: "grep",
          args: { query: "normalize", path: "src" },
        },
      },
      {
        ...base,
        seq: 3,
        eventId: "t2",
        kind: "tool_call_update",
        toolCallId: "call-1",
        title: "Grep normalize",
        toolKind: "grep",
        status: "completed",
        raw: {
          type: "tool_call",
          name: "grep",
          args: { query: "normalize", path: "src" },
          result: { files: ["src/lib/agent-chat.ts"], count: 1 },
        },
      },
    ],
    { backendId: "cursor-sdk" }
  );

  const worked = messages.find((message) => message.type === "worked-session");
  const tool = worked?.workedEntries?.find((entry) => entry.kind === "tool");
  assert.ok(tool);
  assert.equal(tool.toolKind, "grep");
  assert.match(tool.title, /normalize/);
});

test("Cursor SDK request events projected through permission_request render permission cards", async () => {
  const { projectAgentEventsToChatMessages } = await import("../src/lib/agent-chat.ts");
  const base = { conversationId: "c1", eventId: "", createdAt: 0 };
  const messages = projectAgentEventsToChatMessages([
    {
      ...base,
      seq: 1,
      eventId: "u1",
      kind: "user_message",
      messageId: "m1",
      content: "do risky thing",
    },
    {
      ...base,
      seq: 2,
      eventId: "p1",
      kind: "permission_request",
      requestId: "req-1",
      title: "Cursor SDK request",
      detail: "Awaiting SDK request resolution",
      options: [],
      raw: { type: "request", request_id: "req-1" },
    },
  ]);

  const permission = messages.find((message) => message.type === "permission-request");
  assert.ok(permission);
  assert.equal(permission.permissionRequestId, "req-1");
  assert.equal(permission.permissionTitle, "Cursor SDK request");
});
