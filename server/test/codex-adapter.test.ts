import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { test } from "node:test";
import path from "node:path";

const [{ parseCodexStdoutLine }, { readAgentBackendConfigCache }] = await Promise.all([
  import("../src/lib/agents/cli-adapter.js"),
  import("../src/lib/agents/provider-cache-store.js"),
]);

function buildCodexCallbacks() {
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

test("parseCodexStdoutLine emits pending and completed command execution items", async () => {
  const ctx = buildCodexCallbacks();
  parseCodexStdoutLine(
    JSON.stringify({
      type: "item.started",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "/bin/bash -lc pwd",
        aggregated_output: "",
        exit_code: null,
        status: "in_progress",
      },
    }),
    ctx.callbacks
  );
  parseCodexStdoutLine(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "/bin/bash -lc pwd",
        aggregated_output: "/tmp\n",
        exit_code: 0,
        status: "completed",
      },
    }),
    ctx.callbacks
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.toolCalls.length, 1);
  assert.equal(ctx.toolUpdates.length, 1);
  assert.equal(ctx.toolCalls[0]?.toolKind, "terminal");
  assert.match(String(ctx.toolCalls[0]?.title), /pwd/);
  assert.equal(ctx.toolUpdates[0]?.status, "completed");
  assert.match(String(ctx.toolUpdates[0]?.detail), /\/tmp/);
});

test("codex adapter cache defaults to mini low with execution mode", async () => {
  const options = await readAgentBackendConfigCache("codex-adapter");
  const model = options.find((option) => option.id === "model");
  const reasoning = options.find((option) => option.id === "model_reasoning_effort");
  const permission = options.find((option) => option.id === "permission");
  const webSearch = options.find((option) => option.id === "web_search");
  assert.equal(model?.currentValue, "gpt-5.4-mini");
  assert.equal(reasoning?.currentValue, "low");
  assert.equal(permission?.currentValue, "workspace-write");
  assert.ok(permission?.options.some((option) => option.value === "bypassPermissions"));
  assert.ok(["disabled", "cached", "live"].includes(String(webSearch?.currentValue)));
  assert.ok(webSearch?.options.some((option) => option.value === "live"));
});

test("parseCodexStdoutLine emits web search items with query-aware titles", async () => {
  const ctx = buildCodexCallbacks();
  parseCodexStdoutLine(
    JSON.stringify({
      type: "item.started",
      item: {
        id: "item_ws",
        type: "web_search",
        query: "",
        action: { type: "other" },
        status: "in_progress",
      },
    }),
    ctx.callbacks
  );
  parseCodexStdoutLine(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_ws",
        type: "web_search",
        query: "Codex app-server protocol OpenAI",
        action: {
          type: "search",
          query: "Codex app-server protocol OpenAI",
          queries: ["Codex app-server protocol OpenAI"],
        },
        status: "completed",
      },
    }),
    ctx.callbacks
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.toolCalls[0]?.toolKind, "search_web");
  assert.equal(ctx.toolUpdates[0]?.toolKind, "search_web");
  assert.match(String(ctx.toolUpdates[0]?.title), /Codex app-server protocol OpenAI/);
});

test("parseCodexStdoutLine emits failed file_change items as edit events", async () => {
  const ctx = buildCodexCallbacks();
  parseCodexStdoutLine(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_fc",
        type: "file_change",
        changes: [{ path: "/tmp/example.txt", kind: "add" }],
        status: "failed",
      },
    }),
    ctx.callbacks
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(ctx.toolUpdates.length, 1);
  assert.equal(ctx.toolUpdates[0]?.toolKind, "edit");
  assert.equal(ctx.toolUpdates[0]?.status, "failed");
  assert.match(String(ctx.toolUpdates[0]?.title), /example\.txt/);
});

test("parseCodexStdoutLine emits task events for collab tool calls", async () => {
  const ctx = buildCodexCallbacks();
  parseCodexStdoutLine(
    JSON.stringify({
      type: "item.started",
      item: {
        id: "item_task",
        type: "collab_tool_call",
        tool: "spawn_agent",
        prompt: "Inspect package.json",
        receiver_thread_ids: [],
        agents_states: {},
        status: "in_progress",
      },
    }),
    ctx.callbacks
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.toolCalls.length, 1);
  assert.equal(ctx.toolCalls[0]?.toolKind, "task");
  assert.equal(ctx.toolCalls[0]?.title, "Task");
  assert.match(String(ctx.toolCalls[0]?.detail), /Inspect package\.json/);
});

test("parseCodexStdoutLine reconstructs file_change diffs from workspace files", async () => {
  const ctx = buildCodexCallbacks();
  const filePath = path.join("/tmp", `codex-diff-${randomUUID()}.txt`);
  await fs.writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
  parseCodexStdoutLine(
    JSON.stringify({
      type: "item.started",
      item: {
        id: "item_fc_started",
        type: "file_change",
        changes: [{ path: filePath, kind: "update" }],
        status: "in_progress",
      },
    }),
    ctx.callbacks
  );
  await fs.writeFile(filePath, "alpha\nbeta-updated\ngamma\n", "utf8");
  parseCodexStdoutLine(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_fc_started",
        type: "file_change",
        changes: [{ path: filePath, kind: "update" }],
        status: "completed",
      },
    }),
    ctx.callbacks
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(ctx.toolUpdates.length, 1);
  const preview = ctx.toolUpdates[0]?.editPreview as
    | { addedLines?: number; removedLines?: number; lines?: Array<{ kind: string; text: string }> }
    | undefined;
  assert.ok(preview);
  assert.equal(preview?.addedLines, 1);
  assert.equal(preview?.removedLines, 1);
  assert.ok(preview?.lines?.some((line) => line.kind === "add" && line.text === "beta-updated"));
  await fs.rm(filePath, { force: true });
});
