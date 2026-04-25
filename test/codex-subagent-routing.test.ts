import assert from "node:assert/strict";
import { test } from "node:test";

test("Codex collab tool raw is exposed through getToolRawUpdate", async () => {
  const { classifyToolCallAsSubagentCard, getToolRawUpdate } = await import(
    "../src/lib/agent-subagent-routing.ts"
  );
  const event = {
    kind: "tool_call",
    toolCallId: "codex-task-1",
    title: "Task",
    toolKind: "task",
    status: "in_progress",
    raw: {
      id: "item_1",
      type: "collab_tool_call",
      tool: "spawn_agent",
      prompt: "Inspect package.json",
      receiver_thread_ids: [],
      agents_states: {},
      status: "in_progress",
    },
  } as const;

  const raw = getToolRawUpdate(event);
  assert.ok(raw);
  assert.equal(raw?.type, "collab_tool_call");
  assert.equal(classifyToolCallAsSubagentCard("codex-adapter", event), true);
});

test("Codex collab tool events project to subagent chat messages", async () => {
  const { projectAgentEventsToChatMessages } = await import("../src/lib/agent-chat.ts");
  const events = [
    {
      seq: 1,
      eventId: "evt-1",
      conversationId: "conv-1",
      createdAt: 1,
      kind: "tool_call",
      toolCallId: "codex-task-1",
      title: "Task",
      toolKind: "task",
      status: "in_progress",
      raw: {
        id: "item_1",
        type: "collab_tool_call",
        tool: "spawn_agent",
        prompt: "Inspect package.json",
        receiver_thread_ids: [],
        agents_states: {},
        status: "in_progress",
      },
    },
    {
      seq: 2,
      eventId: "evt-2",
      conversationId: "conv-1",
      createdAt: 2,
      kind: "tool_call_update",
      toolCallId: "codex-task-1",
      title: "Task",
      toolKind: "task",
      status: "completed",
      raw: {
        id: "item_1",
        type: "collab_tool_call",
        tool: "spawn_agent",
        prompt: "Inspect package.json",
        receiver_thread_ids: ["019d-subagent"],
        agents_states: {
          "019d-subagent": {
            status: "pending_init",
            message: null,
          },
        },
        status: "completed",
      },
    },
  ] as const;

  const messages = projectAgentEventsToChatMessages(events as never, {
    backendId: "codex-adapter",
    workspaceRoot: "/home/bennett/projects/OpenCursor",
  });
  const subagent = messages.find((message) => message.type === "subagent");
  assert.ok(subagent, "expected a subagent card message");
  assert.equal(subagent?.subagentTitle, "Inspect package.json");
  assert.equal(subagent?.subagentStatus, "running");
});

test("Codex wait updates merge into the existing subagent card instead of creating a generic task row", async () => {
  const { projectAgentEventsToChatMessages } = await import("../src/lib/agent-chat.ts");
  const events = [
    {
      seq: 1,
      eventId: "evt-1",
      conversationId: "conv-1",
      createdAt: 1,
      kind: "tool_call",
      toolCallId: "spawn-1",
      title: "Task",
      toolKind: "task",
      status: "in_progress",
      raw: {
        id: "spawn-1",
        type: "collab_tool_call",
        tool: "spawn_agent",
        prompt: "Inspect README.md",
        receiver_thread_ids: [],
        agents_states: {},
        status: "in_progress",
      },
    },
    {
      seq: 2,
      eventId: "evt-2",
      conversationId: "conv-1",
      createdAt: 2,
      kind: "tool_call_update",
      toolCallId: "spawn-1",
      title: "Task",
      toolKind: "task",
      status: "completed",
      raw: {
        id: "spawn-1",
        type: "collab_tool_call",
        tool: "spawn_agent",
        prompt: "Inspect README.md",
        receiver_thread_ids: ["ses_codex_1"],
        agents_states: {
          ses_codex_1: { status: "pending_init", message: null },
        },
        status: "completed",
      },
    },
    {
      seq: 3,
      eventId: "evt-3",
      conversationId: "conv-1",
      createdAt: 3,
      kind: "tool_call",
      toolCallId: "wait-1",
      title: "Task",
      toolKind: "task",
      status: "in_progress",
      raw: {
        id: "wait-1",
        type: "collab_tool_call",
        tool: "wait",
        receiver_thread_ids: ["ses_codex_1"],
        agents_states: {},
        status: "in_progress",
      },
    },
    {
      seq: 4,
      eventId: "evt-4",
      conversationId: "conv-1",
      createdAt: 4,
      kind: "tool_call_update",
      toolCallId: "wait-1",
      title: "Task",
      toolKind: "task",
      status: "completed",
      raw: {
        id: "wait-1",
        type: "collab_tool_call",
        tool: "wait",
        receiver_thread_ids: ["ses_codex_1"],
        agents_states: {
          ses_codex_1: {
            status: "completed",
            message: "README inspected successfully.",
          },
        },
        status: "completed",
      },
    },
  ] as const;

  const messages = projectAgentEventsToChatMessages(events as never, {
    backendId: "codex-adapter",
    workspaceRoot: "/home/bennett/projects/OpenCursor",
  });
  const subagents = messages.filter((message) => message.type === "subagent");
  assert.equal(subagents.length, 1);
  assert.equal(subagents[0]?.subagentTitle, "Inspect README.md");
  assert.equal(subagents[0]?.subagentStatus, "completed");
  assert.match(String(subagents[0]?.recentActivity), /README inspected successfully/);
});
