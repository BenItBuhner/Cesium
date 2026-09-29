import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { projectAgentEventsToChatMessages } from "../src/lib/agent-chat.ts";
import type { AgentStoredEvent } from "../src/lib/agent-types.ts";
import type { ChatMessage } from "../src/lib/types.ts";

type EventBody = AgentStoredEvent extends infer T
  ? T extends AgentStoredEvent
    ? Omit<T, "seq" | "eventId" | "conversationId" | "createdAt">
    : never
  : never;

function buildEvents(
  conversationId: string,
  bodies: Array<EventBody & { createdAt?: number }>
): AgentStoredEvent[] {
  return bodies.map((body, index) => ({
    seq: index + 1,
    eventId: `${conversationId}-e${index + 1}`,
    conversationId,
    createdAt: body.createdAt ?? 1_000 + index * 1_000,
    ...body,
  })) as AgentStoredEvent[];
}

function liveRow(messages: ChatMessage[]): ChatMessage {
  const row = messages.find(
    (message) => message.type === "worked-session" && message.loading === true
  );
  assert.ok(row, "expected a live working row");
  return row;
}

const userMessage = (createdAt = 1_000): EventBody & { createdAt: number } => ({
  kind: "user_message",
  messageId: "m-user",
  content: "Do the thing",
  createdAt,
});

describe("live working row", () => {
  test("surfaces the latest running status detail and the turn start", () => {
    const messages = projectAgentEventsToChatMessages(
      buildEvents("live-detail", [
        userMessage(5_000),
        { kind: "status", status: "running", detail: "Cesium is starting…" },
        { kind: "status", status: "running", detail: "Cesium is connecting to openai…" },
      ]),
      { backendId: "cesium-agent" }
    );
    const row = liveRow(messages);
    assert.equal(row.workedLabel, "Working");
    assert.equal(row.liveStatusDetail, "Cesium is connecting to openai…");
    assert.equal(row.liveStartedAt, 5_000);
    assert.equal(row.liveStatusPhase, undefined);
  });

  test("drops a status detail once newer agent activity supersedes it", () => {
    const messages = projectAgentEventsToChatMessages(
      buildEvents("live-stale", [
        userMessage(),
        { kind: "status", status: "running", detail: "Cesium is connecting to openai…" },
        { kind: "assistant_message_chunk", messageId: "a1", text: "Looking into it." },
      ]),
      { backendId: "cesium-agent" }
    );
    const row = liveRow(messages);
    assert.equal(row.liveStatusDetail, undefined);
    assert.equal(row.liveStatusPhase, "Writing");
  });

  test("keeps a wait countdown detail while its tool is still running", () => {
    const messages = projectAgentEventsToChatMessages(
      buildEvents("live-wait", [
        userMessage(),
        {
          kind: "tool_call",
          toolCallId: "t-wait",
          title: "Wait for agent",
          toolKind: "wait",
          status: "in_progress",
        },
        {
          kind: "status",
          status: "running",
          detail: "Waiting for agent reviewer (12s / 120s): review the diff",
        },
        { kind: "tool_call_update", toolCallId: "t-wait", status: "in_progress" },
      ]),
      { backendId: "cesium-agent" }
    );
    const row = liveRow(messages);
    assert.equal(row.liveStatusDetail, "Waiting for agent reviewer (12s / 120s): review the diff");
    assert.equal(row.liveStatusPhase, "Waiting");
  });

  test("strips the retry label prefix from the detail line", () => {
    const messages = projectAgentEventsToChatMessages(
      buildEvents("live-retry", [
        userMessage(),
        {
          kind: "status",
          status: "running",
          detail: "Taking longer - retrying provider request (1/3)…",
        },
      ]),
      { backendId: "cesium-agent" }
    );
    const row = liveRow(messages);
    assert.equal(row.workedLabel, "Taking longer");
    assert.equal(row.liveStatusDetail, "Retrying provider request (1/3)…");
    assert.equal(row.liveStatusPhase, undefined);
  });

  test("shows no detail line for a bare compression status", () => {
    const messages = projectAgentEventsToChatMessages(
      buildEvents("live-compress", [
        userMessage(),
        { kind: "status", status: "running", detail: "Compressing context…" },
      ]),
      { backendId: "cesium-agent" }
    );
    const row = liveRow(messages);
    assert.equal(row.workedLabel, "Compressing context");
    assert.equal(row.liveStatusDetail, undefined);
  });

  test("promotes the run phase and diffstat of the current turn", () => {
    const editPreview = (path: string, addedLines: number, removedLines: number) => ({
      path,
      source: "patch" as const,
      addedLines,
      removedLines,
      lines: [],
    });
    const messages = projectAgentEventsToChatMessages(
      buildEvents("live-summary", [
        {
          kind: "user_message",
          messageId: "m-old",
          content: "Earlier turn",
        },
        {
          kind: "tool_call",
          toolCallId: "t-old",
          title: "Edit old.ts",
          toolKind: "edit",
          status: "completed",
          editPreview: editPreview("/w/old.ts", 50, 50),
        },
        { kind: "status", status: "idle" },
        userMessage(10_000),
        {
          kind: "tool_call",
          toolCallId: "t-a",
          title: "Edit a.ts",
          toolKind: "edit",
          status: "completed",
          editPreview: editPreview("/w/a.ts", 100, 4),
        },
        {
          kind: "tool_call",
          toolCallId: "t-b",
          title: "Edit b.ts",
          toolKind: "edit",
          status: "in_progress",
          editPreview: editPreview("/w/b.ts", 20, 4),
        },
      ]),
      { backendId: "cesium-agent" }
    );
    const row = liveRow(messages);
    assert.equal(row.workedLabel, "Working");
    assert.equal(row.liveStatusPhase, "Editing");
    assert.deepEqual(row.liveEditStats, { files: 2, additions: 120, deletions: 8 });
    assert.equal(row.liveStartedAt, 10_000);
  });

  test("never promotes the phase onto a settled turn", () => {
    const messages = projectAgentEventsToChatMessages(
      buildEvents("live-settled", [
        userMessage(),
        { kind: "status", status: "running", detail: "Cesium is connecting to openai…" },
        { kind: "assistant_message_chunk", messageId: "a1", text: "Done." },
        { kind: "status", status: "idle" },
      ]),
      { backendId: "cesium-agent" }
    );
    assert.equal(
      messages.some((message) => message.type === "worked-session" && message.loading),
      false
    );
  });
});

describe("system event levels", () => {
  test("carries the system level onto the projected row", () => {
    const messages = projectAgentEventsToChatMessages(
      buildEvents("system-levels", [
        userMessage(),
        { kind: "system", level: "warning", text: "Model does not support images; dropped 1 image." },
        { kind: "system", level: "error", text: "MCP server github failed to start." },
        { kind: "system", level: "info", text: "Switched to plan mode." },
      ]),
      { backendId: "cesium-agent" }
    );
    const byContent = new Map(
      messages
        .filter((message) => message.type === "assistant")
        .map((message) => [message.content, message.systemLevel])
    );
    assert.equal(byContent.get("Model does not support images; dropped 1 image."), "warning");
    assert.equal(byContent.get("MCP server github failed to start."), "error");
    assert.equal(byContent.get("Switched to plan mode."), "info");
  });

  test("leaves real assistant replies without a system level", () => {
    const messages = projectAgentEventsToChatMessages(
      buildEvents("system-none", [
        userMessage(),
        { kind: "assistant_message_chunk", messageId: "a1", text: "Here is the answer." },
      ]),
      { backendId: "cesium-agent" }
    );
    const reply = messages.find((message) => message.type === "assistant");
    assert.ok(reply);
    assert.equal(reply.systemLevel, undefined);
  });
});

function toolEntries(messages: ChatMessage[]) {
  return messages
    .filter((message) => message.type === "worked-session")
    .flatMap((message) => message.workedEntries ?? [])
    .filter((entry) => entry.kind === "tool");
}

describe("tool row timing", () => {
  test("spans the tool call to its completing update", () => {
    const messages = projectAgentEventsToChatMessages(
      buildEvents("tool-timing", [
        userMessage(),
        {
          kind: "tool_call",
          toolCallId: "t-run",
          title: "Run npm test",
          toolKind: "execute",
          status: "in_progress",
          createdAt: 2_000,
        },
        { kind: "tool_call_update", toolCallId: "t-run", status: "in_progress", createdAt: 4_000 },
        { kind: "tool_call_update", toolCallId: "t-run", status: "completed", createdAt: 9_500 },
        { kind: "tool_call_update", toolCallId: "t-run", status: "completed", createdAt: 9_900 },
      ]),
      { backendId: "cesium-agent" }
    );
    const [tool] = toolEntries(messages);
    assert.ok(tool);
    assert.equal(tool.startedAt, 2_000);
    assert.equal(tool.completedAt, 9_500);
  });

  test("leaves a running tool open-ended for the live timer", () => {
    const messages = projectAgentEventsToChatMessages(
      buildEvents("tool-running", [
        userMessage(),
        {
          kind: "tool_call",
          toolCallId: "t-read",
          title: "Read a.ts",
          toolKind: "read",
          status: "in_progress",
          createdAt: 3_000,
        },
      ]),
      { backendId: "cesium-agent" }
    );
    const [tool] = toolEntries(messages);
    assert.ok(tool);
    assert.equal(tool.status, "running");
    assert.equal(tool.startedAt, 3_000);
    assert.equal(tool.completedAt, undefined);
  });

  test("does not invent an end time when a turn boundary closes the tool", () => {
    const messages = projectAgentEventsToChatMessages(
      buildEvents("tool-implicit", [
        userMessage(),
        {
          kind: "tool_call",
          toolCallId: "t-grep",
          title: "Search",
          toolKind: "search",
          status: "in_progress",
          createdAt: 2_000,
        },
        { kind: "assistant_message_chunk", messageId: "a1", text: "Found it." },
        { kind: "status", status: "idle", createdAt: 60_000 },
      ]),
      { backendId: "cesium-agent" }
    );
    const [tool] = toolEntries(messages);
    assert.ok(tool);
    assert.equal(tool.status, "completed");
    assert.equal(tool.startedAt, 2_000);
    assert.equal(tool.completedAt, undefined);
  });

  test("stamps completion on the original row across a mid-turn user message", () => {
    const messages = projectAgentEventsToChatMessages(
      buildEvents("tool-cross-turn", [
        userMessage(),
        {
          kind: "tool_call",
          toolCallId: "t-build",
          title: "Run build",
          toolKind: "execute",
          status: "in_progress",
          createdAt: 2_000,
        },
        { kind: "user_message", messageId: "m-steer", content: "also run lint", createdAt: 5_000 },
        { kind: "tool_call_update", toolCallId: "t-build", status: "failed", createdAt: 12_000 },
      ]),
      { backendId: "cesium-agent" }
    );
    const tools = toolEntries(messages);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.status, "failed");
    assert.equal(tools[0]!.startedAt, 2_000);
    assert.equal(tools[0]!.completedAt, 12_000);
  });
});
