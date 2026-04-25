import assert from "node:assert/strict";
import { test } from "node:test";

test("permission_request between tool calls stays one worked-session dropdown", async () => {
  const { projectAgentEventsToChatMessages } = await import("../src/lib/agent-chat.ts");
  const base = { conversationId: "c1", eventId: "", createdAt: 0 };
  const events = [
    {
      ...base,
      seq: 1,
      eventId: "u1",
      kind: "user_message" as const,
      messageId: "m1",
      content: "run tests",
    },
    {
      ...base,
      seq: 2,
      eventId: "tc1",
      kind: "tool_call" as const,
      toolCallId: "read-1",
      title: "Read file",
      toolKind: "read",
      status: "completed" as const,
    },
    {
      ...base,
      seq: 3,
      eventId: "tc2",
      kind: "tool_call" as const,
      toolCallId: "term-1",
      title: "Ran",
      toolKind: "terminal",
      status: "pending" as const,
    },
    {
      ...base,
      seq: 4,
      eventId: "pr1",
      kind: "permission_request" as const,
      requestId: "req-1",
      title: "Run command?",
      detail: "npx vitest",
      toolCallId: "term-1",
      options: [{ optionId: "once", name: "Allow once", kind: "allow_once" as const }],
    },
    {
      ...base,
      seq: 5,
      eventId: "tc3",
      kind: "tool_call" as const,
      toolCallId: "read-2",
      title: "Read lints",
      toolKind: "read",
      status: "completed" as const,
    },
  ];

  const messages = projectAgentEventsToChatMessages(events, {});
  const worked = messages.filter((m) => m.type === "worked-session");
  const perms = messages.filter((m) => m.type === "permission-request");

  assert.equal(worked.length, 1, "expected a single worked-session for one tool burst");
  assert.equal(perms.length, 1);
  assert.equal(worked[0]?.workedEntries?.filter((e) => e.kind === "tool").length, 3);
});

test("permission for tool in the second pre-merge worked block still merges to one dropdown", async () => {
  const { projectAgentEventsToChatMessages } = await import("../src/lib/agent-chat.ts");
  const base = { conversationId: "c1", eventId: "", createdAt: 0 };
  const events = [
    {
      ...base,
      seq: 1,
      eventId: "u1",
      kind: "user_message" as const,
      messageId: "m1",
      content: "search",
    },
    {
      ...base,
      seq: 2,
      eventId: "tc1",
      kind: "tool_call" as const,
      toolCallId: "search-ws-1",
      title: "Find in workspace",
      toolKind: "search",
      status: "completed" as const,
    },
    {
      ...base,
      seq: 3,
      eventId: "tc2",
      kind: "tool_call" as const,
      toolCallId: "search-ws-2",
      title: "Find in workspace",
      toolKind: "search",
      status: "completed" as const,
    },
    {
      ...base,
      seq: 4,
      eventId: "tc3",
      kind: "tool_call" as const,
      toolCallId: "search-ws-3",
      title: "Find in workspace",
      toolKind: "search",
      status: "completed" as const,
    },
    {
      ...base,
      seq: 5,
      eventId: "pr1",
      kind: "permission_request" as const,
      requestId: "req-web-1",
      title: "Web search",
      detail: "query",
      toolCallId: "search-web-1",
      options: [{ optionId: "once", name: "Allow once", kind: "allow_once" as const }],
    },
    {
      ...base,
      seq: 6,
      eventId: "tc4",
      kind: "tool_call" as const,
      toolCallId: "search-web-1",
      title: "Web search",
      toolKind: "search_web",
      status: "completed" as const,
    },
  ];

  const messages = projectAgentEventsToChatMessages(events, {});
  const worked = messages.filter((m) => m.type === "worked-session");
  const perms = messages.filter((m) => m.type === "permission-request");

  assert.equal(worked.length, 1, "expected a single worked-session when perm targets post-flush tool");
  assert.equal(perms.length, 1);
  assert.equal(worked[0]?.workedEntries?.filter((e) => e.kind === "tool").length, 4);
});
