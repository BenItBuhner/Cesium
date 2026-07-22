import assert from "node:assert/strict";
import { test } from "node:test";
import { projectAgentEventsToChatMessages } from "../src/lib/agent-chat.ts";
import type { AgentStoredEvent } from "../src/lib/agent-types.ts";
import type { WorkedSessionEntry, WorkflowRunSnapshot } from "../src/lib/types.ts";

test("workflow tool projection retains latest snapshot through generic final update", () => {
  const snapshot: WorkflowRunSnapshot = {
    runId: "run-1",
    name: "snapshot-demo",
    description: "Project workflow snapshots",
    status: "running",
    currentPhase: "Collect",
    tokenBudget: 100,
    tokensUsed: 12,
    maxAgents: 4,
    agentsUsed: 1,
    maxConcurrent: 2,
    createdAt: 1000,
    updatedAt: 1500,
    completedAt: null,
    scriptPath: ".cesium/workflows/run-1.js",
    recentLogs: [{ at: 1400, message: "collecting", phase: "Collect" }],
    returnPreview: null,
    errorPreview: null,
    phases: [{ title: "Collect", detail: "Gather context" }],
    agents: [
      {
        id: "agent-1",
        label: "collector",
        phase: "Collect",
        status: "running",
        tokensUsed: 12,
        startedAt: 1200,
        completedAt: null,
        promptPreview: "Collect context",
      },
    ],
  };
  const events: AgentStoredEvent[] = [
    {
      seq: 1,
      eventId: "tool-start",
      conversationId: "conversation-1",
      createdAt: 1000,
      kind: "tool_call",
      toolCallId: "workflow-tool",
      title: "Run workflow",
      toolKind: "workflow",
      status: "in_progress",
      raw: {
        id: "workflow-tool",
        name: "workflow_run",
        arguments: { wait: false },
      },
    },
    {
      seq: 2,
      eventId: "workflow-update",
      conversationId: "conversation-1",
      createdAt: 1500,
      kind: "tool_call_update",
      toolCallId: "workflow-tool",
      title: "Workflow snapshot-demo",
      toolKind: "workflow",
      status: "in_progress",
      detail: "snapshot-demo: running - Collect - 1/4 agents - 12/100 tokens",
      raw: { workflowRun: snapshot },
    },
    {
      seq: 3,
      eventId: "workflow-wrapper",
      conversationId: "conversation-1",
      createdAt: 1600,
      kind: "tool_call_update",
      toolCallId: "workflow-tool",
      title: "Run workflow",
      toolKind: "workflow",
      status: "completed",
      detail: "{\"status\":\"async_launched\",\"runId\":\"run-1\"}",
      raw: {
        request: { name: "workflow_run", arguments: { wait: false } },
        result: "{\"status\":\"async_launched\",\"runId\":\"run-1\"}",
      },
    },
  ];

  const messages = projectAgentEventsToChatMessages(events, { backendId: "cesium-agent" });
  const worked = messages.find((message) => message.type === "worked-session");
  const tool = worked?.workedEntries?.find(
    (entry): entry is Extract<WorkedSessionEntry, { kind: "tool" }> =>
      entry.kind === "tool" && entry.toolKind === "workflow"
  );

  assert.ok(tool);
  assert.equal(tool.status, "running");
  assert.equal(tool.title, "Workflow snapshot-demo");
  assert.equal(tool.workflowRun?.runId, "run-1");
  assert.equal(tool.workflowRun?.currentPhase, "Collect");
  assert.equal(tool.workflowRun?.agents[0]?.tokensUsed, 12);
  assert.equal(tool.detail, "running - Collect - 1/4 agents - 12/100 tokens");
});
