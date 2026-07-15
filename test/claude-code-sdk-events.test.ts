import assert from "node:assert/strict";
import { test } from "node:test";

test("Claude Code SDK grep tool payload renders as a worked-session search row", async () => {
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
        toolCallId: "toolu_1",
        title: "Grep normalize",
        toolKind: "grep",
        status: "in_progress",
        raw: {
          id: "toolu_1",
          name: "Grep",
          input: { pattern: "normalize", path: "src" },
        },
      },
      {
        ...base,
        seq: 3,
        eventId: "t2",
        kind: "tool_call_update",
        toolCallId: "toolu_1",
        title: "Grep normalize",
        toolKind: "grep",
        status: "completed",
        raw: {
          id: "toolu_1",
          name: "Grep",
          input: { pattern: "normalize", path: "src" },
          result: { files: ["src/lib/agent-chat.ts"], count: 1 },
        },
      },
    ],
    { backendId: "claude-code-sdk" }
  );

  const worked = messages.find((message) => message.type === "worked-session");
  const tool = worked?.workedEntries?.find((entry) => entry.kind === "tool");
  assert.ok(tool);
  assert.equal(tool.toolKind, "grep");
  assert.match(tool.title, /normalize/);
});

test("Claude Code SDK terminal and edit tools project into worked-session rows", async () => {
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
        content: "fix the bug",
      },
      {
        ...base,
        seq: 2,
        eventId: "t1",
        kind: "tool_call",
        toolCallId: "toolu_2",
        title: "Run npm test",
        toolKind: "terminal",
        status: "completed",
        raw: {
          id: "toolu_2",
          name: "Bash",
          input: { command: "npm test" },
          result: "ok",
        },
      },
      {
        ...base,
        seq: 3,
        eventId: "t2",
        kind: "tool_call",
        toolCallId: "toolu_3",
        title: "Update src/app.ts",
        toolKind: "edit",
        status: "completed",
        raw: {
          id: "toolu_3",
          name: "Edit",
          input: { file_path: "src/app.ts" },
          result: "updated",
        },
      },
    ],
    { backendId: "claude-code-sdk" }
  );

  const worked = messages.find((message) => message.type === "worked-session");
  assert.ok(worked?.workedEntries?.length);
  const terminal = worked?.workedEntries?.find((entry) => entry.toolKind === "terminal");
  const edit = worked?.workedEntries?.find((entry) => entry.toolKind === "edit");
  assert.ok(terminal);
  assert.ok(edit);
  assert.match(terminal.title, /npm test/);
  assert.match(edit.title, /src\/app.ts/);
});

test("Claude Code SDK web search tool payload renders as a worked-session search row", async () => {
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
        content: "look up docs",
      },
      {
        ...base,
        seq: 2,
        eventId: "t1",
        kind: "tool_call",
        toolCallId: "toolu_4",
        title: "Web · anthropic api",
        toolKind: "search_web",
        status: "completed",
        raw: {
          id: "toolu_4",
          name: "WebSearch",
          input: { query: "anthropic api" },
          result: { links: ["https://docs.anthropic.com"] },
        },
      },
    ],
    { backendId: "claude-code-sdk" }
  );

  const worked = messages.find((message) => message.type === "worked-session");
  const tool = worked?.workedEntries?.find((entry) => entry.kind === "tool");
  assert.ok(tool);
  assert.equal(tool.toolKind, "search_web");
  assert.match(tool.title, /anthropic api/);
});

test("Claude Code SDK permission requests render permission cards", async () => {
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
      title: "Claude Code SDK request",
      detail: "Awaiting SDK request resolution",
      options: [],
      raw: { type: "request", request_id: "req-1" },
    },
  ]);

  const permission = messages.find((message) => message.type === "permission-request");
  assert.ok(permission);
  assert.equal(permission.permissionRequestId, "req-1");
  assert.equal(permission.permissionTitle, "Claude Code SDK request");
});
