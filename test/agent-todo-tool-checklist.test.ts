import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isAgentTodoJsonDetailString,
  projectAgentEventsToChatMessages,
} from "../src/lib/agent-chat.ts";
import type { AgentStoredEvent } from "../src/lib/agent-types.ts";

const base = { conversationId: "c1", createdAt: 0, eventId: "" };

function findTodoToolEntry(messages: ReturnType<typeof projectAgentEventsToChatMessages>) {
  for (const message of messages) {
    for (const entry of message.workedEntries ?? []) {
      if (entry.kind === "tool" && entry.toolKind === "todo") {
        return entry;
      }
    }
  }
  return undefined;
}

describe("todo tool checklist projection", () => {
  test("Cesium `{action, items}` args project into a structured checklist, not raw JSON", () => {
    const args = {
      action: "replace",
      items: [
        { content: "Explore workspace", status: "completed" },
        { content: "Fix the projection", status: "in_progress" },
        { content: "Run the tests", status: "pending" },
      ],
    };
    const events: AgentStoredEvent[] = [
      {
        ...base,
        seq: 1,
        eventId: "u1",
        kind: "user_message",
        messageId: "m1",
        content: "clean things up",
      },
      {
        ...base,
        seq: 2,
        eventId: "t1",
        kind: "tool_call",
        toolCallId: "todo-1",
        title: "Update todos",
        toolKind: "todo",
        status: "completed",
        detail: JSON.stringify(args),
        raw: { id: "todo-1", name: "todo", arguments: args },
      },
      { ...base, seq: 3, eventId: "idle", kind: "status", status: "idle" },
    ];

    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });
    const tool = findTodoToolEntry(messages);
    assert.ok(tool, "todo tool entry should exist");
    assert.equal(tool.title, "Update todos");
    assert.equal(tool.todos?.length, 3);
    assert.deepEqual(
      tool.todos?.map((todo) => todo.status),
      ["completed", "in_progress", "pending"]
    );
    assert.equal(tool.todos?.[0]?.text, "Explore workspace");
    // The parsed checklist replaces the raw JSON dump.
    assert.equal(tool.rawDetail, undefined);
    assert.equal(tool.detail, undefined);
  });

  test("Claude/Cursor `{todos}` input shape also parses into a checklist", () => {
    const events: AgentStoredEvent[] = [
      {
        ...base,
        seq: 1,
        eventId: "u1",
        kind: "user_message",
        messageId: "m1",
        content: "do the thing",
      },
      {
        ...base,
        seq: 2,
        eventId: "t1",
        kind: "tool_call",
        toolCallId: "toolu_1",
        title: "Update todos",
        toolKind: "todo",
        status: "completed",
        raw: {
          id: "toolu_1",
          name: "TodoWrite",
          input: {
            todos: [
              { content: "One", status: "completed", activeForm: "Doing one" },
              { content: "Two", status: "in_progress", activeForm: "Doing two" },
            ],
          },
        },
      },
    ];

    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "claude-code-sdk",
    });
    const tool = findTodoToolEntry(messages);
    assert.ok(tool);
    assert.equal(tool.todos?.length, 2);
    assert.equal(tool.todos?.[1]?.status, "in_progress");
  });

  test("todo tool title is not swallowed by the edit heuristic when items are absent", () => {
    const events: AgentStoredEvent[] = [
      {
        ...base,
        seq: 1,
        eventId: "u1",
        kind: "user_message",
        messageId: "m1",
        content: "list todos",
      },
      {
        ...base,
        seq: 2,
        eventId: "t1",
        kind: "tool_call",
        toolCallId: "todo-2",
        title: "Update todos",
        toolKind: "todo",
        status: "completed",
        detail: JSON.stringify({ action: "list" }),
        raw: { id: "todo-2", name: "todo", arguments: { action: "list" } },
      },
    ];

    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });
    const tool = findTodoToolEntry(messages);
    assert.ok(tool);
    assert.equal(tool.title, "Read todos");
    assert.equal(tool.toolKind, "todo");
  });

  test("editing a file literally named todos.md still routes as an edit", () => {
    const events: AgentStoredEvent[] = [
      {
        ...base,
        seq: 1,
        eventId: "u1",
        kind: "user_message",
        messageId: "m1",
        content: "edit todos.md",
      },
      {
        ...base,
        seq: 2,
        eventId: "t1",
        kind: "tool_call",
        toolCallId: "edit-1",
        title: "Update todos.md",
        toolKind: "edit",
        status: "completed",
        locations: [{ path: "todos.md" }],
        raw: { id: "edit-1", name: "Edit", input: { file_path: "todos.md" } },
      },
    ];

    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "claude-code-sdk",
    });
    const tool = messages
      .flatMap((message) => message.workedEntries ?? [])
      .find((entry) => entry.kind === "tool");
    assert.ok(tool);
    assert.notEqual(tool.toolKind, "todo");
    assert.match(tool.title, /todos\.md/);
  });

  test("isAgentTodoJsonDetailString recognizes Cesium `{action, items}` payloads", () => {
    assert.equal(
      isAgentTodoJsonDetailString(
        JSON.stringify({
          action: "replace",
          items: [{ content: "A", status: "pending" }],
        })
      ),
      true
    );
    assert.equal(
      isAgentTodoJsonDetailString(JSON.stringify({ action: "list" })),
      false
    );
    assert.equal(
      isAgentTodoJsonDetailString(JSON.stringify({ path: "src/app.ts" })),
      false
    );
  });
});
