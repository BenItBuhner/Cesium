import assert from "node:assert/strict";
import { test } from "node:test";

const [{ parseClaudeStdoutLine }, { readAgentBackendConfigCache }] = await Promise.all([
  import("../src/lib/agents/cli-adapter.js"),
  import("../src/lib/agents/provider-cache-store.js"),
]);

function buildClaudeCallbacks() {
  const toolCalls: Array<Record<string, unknown>> = [];
  const toolUpdates: Array<Record<string, unknown>> = [];
  const assistantTexts: string[] = [];
  const reasoningTexts: string[] = [];
  const stopReasons: Array<string | undefined> = [];
  return {
    toolCalls,
    toolUpdates,
    assistantTexts,
    reasoningTexts,
    stopReasons,
    callbacks: {
      appendAssistantText: async (text: string) => {
        assistantTexts.push(text);
      },
      appendReasoningText: async (text: string) => {
        reasoningTexts.push(text);
      },
      setStopReason: (stopReason: string | undefined) => {
        stopReasons.push(stopReason);
      },
      appendToolCall: async (payload: Record<string, unknown>) => {
        toolCalls.push(payload);
      },
      appendToolCallUpdate: async (payload: Record<string, unknown>) => {
        toolUpdates.push(payload);
      },
    },
  };
}

test("claude adapter cache exposes glm-5.1 and permission options", async () => {
  const options = await readAgentBackendConfigCache("claude-adapter");
  const model = options.find((option) => option.id === "model");
  const permission = options.find((option) => option.id === "permission");
  assert.ok(model, "expected Claude model option");
  assert.ok(model?.options.some((option) => option.value === "glm-5.1"));
  assert.ok(model?.options.some((option) => option.value === "turbo"));
  assert.ok(permission, "expected Claude permission option");
  assert.ok(permission?.options.some((option) => option.value === "acceptEdits"));
  assert.ok(permission?.options.some((option) => option.value === "bypassPermissions"));
});

test("parseClaudeStdoutLine emits read tool calls with file_path titles", async () => {
  const ctx = buildClaudeCallbacks();
  parseClaudeStdoutLine(
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "read-1",
            name: "Read",
            input: { file_path: "/tmp/providers.ts" },
          },
        ],
      },
    }),
    ctx.callbacks
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.toolCalls.length, 1);
  assert.equal(ctx.toolCalls[0]?.toolCallId, "read-1");
  assert.equal(ctx.toolCalls[0]?.toolKind, "read");
  assert.equal(ctx.toolCalls[0]?.title, "Read providers.ts");
});

test("parseClaudeStdoutLine emits grep completion details from tool_result", async () => {
  const ctx = buildClaudeCallbacks();
  parseClaudeStdoutLine(
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "grep-1",
            name: "Grep",
            input: { pattern: "summarizeAcpToolCallTitle" },
          },
        ],
      },
    }),
    ctx.callbacks
  );
  parseClaudeStdoutLine(
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "grep-1",
            content:
              "Found 2 files\nserver/src/lib/agents/providers.ts\nserver/test/claude-adapter.test.ts",
          },
        ],
      },
    }),
    ctx.callbacks
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.toolUpdates.length, 1);
  assert.equal(ctx.toolUpdates[0]?.toolCallId, "grep-1");
  assert.equal(ctx.toolUpdates[0]?.title, 'Grep "summarizeAcpToolCallTitle"');
  assert.equal(ctx.toolUpdates[0]?.status, "completed");
  assert.equal(ctx.toolUpdates[0]?.detail, "2 files matched");
});

test("parseClaudeStdoutLine emits failed write tool results with error detail", async () => {
  const ctx = buildClaudeCallbacks();
  parseClaudeStdoutLine(
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "write-1",
            name: "Write",
            input: {},
          },
        ],
      },
    }),
    ctx.callbacks
  );
  parseClaudeStdoutLine(
    JSON.stringify({
      type: "user",
      tool_use_result:
        "InputValidationError: Write failed because file_path and content are missing",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "write-1",
            is_error: true,
            content:
              "<tool_use_error>InputValidationError: Write failed because file_path and content are missing</tool_use_error>",
          },
        ],
      },
    }),
    ctx.callbacks
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.toolUpdates.length, 1);
  assert.equal(ctx.toolUpdates[0]?.toolCallId, "write-1");
  assert.equal(ctx.toolUpdates[0]?.toolKind, "edit");
  assert.equal(ctx.toolUpdates[0]?.status, "failed");
  assert.match(String(ctx.toolUpdates[0]?.detail), /InputValidationError/);
});
