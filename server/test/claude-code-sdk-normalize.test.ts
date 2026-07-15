import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeToolUseToAgentEvent,
  planEntriesFromClaudeToolPayload,
  textDeltaFromClaudeStreamEvent,
  textFromClaudeAssistantMessage,
  thinkingTextFromClaudeAssistantMessage,
  toolResultFromClaudeUserMessage,
  toolUsesFromClaudeAssistantMessage,
} from "../src/lib/agents/claude-code-sdk-normalize.js";

test("Claude assistant text, thinking, and tool_use blocks normalize", () => {
  const message = {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Hello " },
        { type: "thinking", thinking: "Reasoning" },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Read",
          input: { path: "src/app.ts" },
        },
      ],
    },
  };
  assert.equal(textFromClaudeAssistantMessage(message), "Hello ");
  assert.equal(thinkingTextFromClaudeAssistantMessage(message), "Reasoning");
  assert.deepEqual(toolUsesFromClaudeAssistantMessage(message), [
    { id: "toolu_1", name: "Read", input: { path: "src/app.ts" } },
  ]);
});

test("Claude stream text deltas normalize", () => {
  assert.equal(
    textDeltaFromClaudeStreamEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "chunk" },
      },
    }),
    "chunk"
  );
});

test("Claude tool_use and tool_result map to OpenCursor tool events", () => {
  const call = claudeToolUseToAgentEvent({
    conversationId: "c1",
    eventId: "e1",
    status: "in_progress",
    tool: { id: "toolu_1", name: "Bash", input: { command: "npm test" } },
  });
  assert.equal(call.kind, "tool_call");
  assert.equal(call.toolKind, "terminal");
  assert.equal(call.title, "Ran npm test");

  const readCall = claudeToolUseToAgentEvent({
    conversationId: "c1",
    eventId: "e2",
    status: "in_progress",
    tool: { id: "toolu_2", name: "Read", input: { file_path: "server/package.json" } },
  });
  assert.equal(readCall.toolKind, "read");
  assert.equal(readCall.title, "Read package.json");

  const results = toolResultFromClaudeUserMessage({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "ok",
          is_error: false,
        },
      ],
    },
  });
  assert.deepEqual(results, [{ id: "toolu_1", result: "ok", isError: false }]);
});

test("Claude TodoWrite payloads mirror into plan entries", () => {
  const entries = planEntriesFromClaudeToolPayload({
    todos: [
      { id: "a", content: "Read files", status: "completed" },
      { id: "b", content: "Patch bug", status: "in_progress", priority: "high" },
      { id: "c", content: "Wait on credentials", status: "blocked" },
    ],
  });
  assert.deepEqual(entries, [
    { id: "a", content: "Read files", status: "completed", priority: undefined },
    { id: "b", content: "Patch bug", status: "in_progress", priority: "high" },
    { id: "c", content: "Wait on credentials", status: "blocked", priority: undefined },
  ]);
});

test("Claude Grep, WebSearch, and Edit tools normalize to OpenCursor tool kinds", () => {
  const grepCall = claudeToolUseToAgentEvent({
    conversationId: "c1",
    eventId: "e3",
    status: "in_progress",
    tool: { id: "toolu_3", name: "Grep", input: { pattern: "normalize", path: "src" } },
  });
  assert.equal(grepCall.toolKind, "grep");
  assert.equal(grepCall.title, 'Grep "normalize"');

  const webCall = claudeToolUseToAgentEvent({
    conversationId: "c1",
    eventId: "e4",
    status: "in_progress",
    tool: { id: "toolu_4", name: "WebSearch", input: { query: "anthropic api" } },
  });
  assert.equal(webCall.toolKind, "search_web");
  assert.equal(webCall.title, "Web · anthropic api");

  const editCall = claudeToolUseToAgentEvent({
    conversationId: "c1",
    eventId: "e5",
    status: "in_progress",
    tool: { id: "toolu_5", name: "Edit", input: { file_path: "src/app.ts" } },
  });
  assert.equal(editCall.toolKind, "edit");
  assert.equal(editCall.title, "Update app.ts");
});
