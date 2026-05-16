import assert from "node:assert/strict";
import { test } from "node:test";

const {
  cursorSdkStatusToAgentStatus,
  cursorSdkToolEventToAgentEvent,
  planEntriesFromCursorSdkToolPayload,
  textFromCursorSdkAssistantMessage,
} = await import("../src/lib/agents/cursor-sdk-normalize.js");

test("Cursor SDK assistant text blocks concatenate into visible assistant text", () => {
  const text = textFromCursorSdkAssistantMessage({
    type: "assistant",
    agent_id: "agent-1",
    run_id: "run-1",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "tool_use", id: "tool-1", name: "read", input: { path: "a.ts" } },
        { type: "text", text: " world" },
      ],
    },
  });
  assert.equal(text, "Hello world");
});

test("Cursor SDK tool events normalize into Cesium tool call rows", () => {
  const event = cursorSdkToolEventToAgentEvent({
    conversationId: "c1",
    eventId: "e1",
    event: {
      type: "tool_call",
      agent_id: "agent-1",
      run_id: "run-1",
      call_id: "call-1",
      name: "grep",
      status: "running",
      args: { query: "needle", path: "src" },
    },
  });
  assert.equal(event.kind, "tool_call");
  assert.equal(event.toolCallId, "call-1");
  assert.equal(event.toolKind, "grep");
  assert.equal(event.status, "in_progress");
  assert.match(event.title, /needle/);
});

test("Cursor SDK completed edit updates retain paths and raw payload", () => {
  const event = cursorSdkToolEventToAgentEvent({
    conversationId: "c1",
    eventId: "e1",
    event: {
      type: "tool_call",
      agent_id: "agent-1",
      run_id: "run-1",
      call_id: "call-2",
      name: "edit",
      status: "completed",
      args: { path: "src/example.ts" },
      result: { message: "updated file" },
    },
  });
  assert.equal(event.kind, "tool_call_update");
  assert.equal(event.toolKind, "edit");
  assert.equal(event.status, "completed");
  assert.deepEqual(event.locations, [{ path: "src/example.ts" }]);
  assert.ok(event.raw);
});

test("Cursor SDK nested glob results expose matched files and concise detail", () => {
  const event = cursorSdkToolEventToAgentEvent({
    conversationId: "c1",
    eventId: "e1",
    event: {
      type: "tool_call",
      agent_id: "agent-1",
      run_id: "run-1",
      call_id: "call-3",
      name: "glob",
      status: "completed",
      args: { globPattern: "**/*.ts", targetDirectory: "src" },
      result: {
        status: "success",
        value: {
          files: ["src/a.ts", "src/b.ts"],
          totalFiles: 2,
        },
      },
    },
  });
  assert.equal(event.kind, "tool_call_update");
  assert.equal(event.toolKind, "search");
  assert.match(event.title, /\*\*\/\*\.ts/);
  assert.equal(event.detail, "2 files matched");
  assert.deepEqual(event.locations, [{ path: "src/a.ts" }, { path: "src/b.ts" }]);
});

test("Cursor SDK todo payloads become plan entries", () => {
  const entries = planEntriesFromCursorSdkToolPayload({
    todos: [
      { id: "a", content: "Create file", status: "completed" },
      { id: "b", text: "Run tests", status: "in_progress" },
    ],
  });
  assert.deepEqual(entries, [
    { id: "a", content: "Create file", status: "completed" },
    { id: "b", content: "Run tests", status: "in_progress" },
  ]);
});

test("Cursor SDK lifecycle status maps to Cesium conversation status", () => {
  assert.equal(
    cursorSdkStatusToAgentStatus({
      type: "status",
      agent_id: "agent-1",
      run_id: "run-1",
      status: "RUNNING",
    }),
    "running"
  );
  assert.equal(
    cursorSdkStatusToAgentStatus({
      type: "status",
      agent_id: "agent-1",
      run_id: "run-1",
      status: "FINISHED",
    }),
    "idle"
  );
});
