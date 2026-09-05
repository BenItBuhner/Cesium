import assert from "node:assert/strict";
import test from "node:test";
import { hasAgentBackendIconAsset } from "../src/lib/agent-backend-icons";
import type { AgentBackendId, AgentStoredEvent } from "../src/lib/agent-types";
import {
  SUBAGENT_TOOL_CALL_CLASSIFIERS,
  classifyToolCallAsSubagentCard,
} from "../src/lib/agent-subagent-routing";

test("Claude Code SDK frontend id has icon and subagent routing coverage", () => {
  const id: AgentBackendId = "claude-code-sdk";
  assert.equal(hasAgentBackendIconAsset(id), true);
  assert.equal(typeof SUBAGENT_TOOL_CALL_CLASSIFIERS[id], "function");
});

function toolCall(raw: Record<string, unknown>, overrides: Partial<Extract<AgentStoredEvent, { kind: "tool_call" }>> = {}) {
  return {
    seq: 1,
    eventId: "e1",
    conversationId: "c1",
    createdAt: 0,
    kind: "tool_call",
    toolCallId: "toolu_1",
    title: "Tool",
    toolKind: "tool",
    status: "completed",
    raw,
    ...overrides,
  } satisfies Extract<AgentStoredEvent, { kind: "tool_call" }>;
}

test("Claude Agent tool calls classify as subagent cards even without subagent_type", () => {
  const withoutType = toolCall(
    { id: "toolu_1", name: "Agent", input: { description: "Find configs", prompt: "List config files." } },
    { title: "Subagent · Find configs", toolKind: "task" }
  );
  assert.equal(classifyToolCallAsSubagentCard("claude-code-sdk", withoutType), true);
  const legacyTask = toolCall({ id: "toolu_2", name: "Task", input: { description: "x", prompt: "y" } });
  assert.equal(classifyToolCallAsSubagentCard("claude-code-sdk", legacyTask), true);
});

test("Claude file, shell, and task-list tools never become subagent cards", () => {
  const bash = toolCall(
    { id: "toolu_3", name: "Bash", input: { command: "ls", description: "List files" } },
    { title: "Ran ls", toolKind: "terminal" }
  );
  assert.equal(classifyToolCallAsSubagentCard("claude-code-sdk", bash), false);
  const taskCreate = toolCall(
    { id: "toolu_4", name: "TaskCreate", input: { subject: "Write tests", description: "Cover the parser" } },
    { title: "Add task · Write tests", toolKind: "todo" }
  );
  assert.equal(classifyToolCallAsSubagentCard("claude-code-sdk", taskCreate), false);
  const read = toolCall(
    { id: "toolu_5", name: "Read", input: { file_path: "/tmp/a.ts" } },
    { title: "Read a.ts", toolKind: "read" }
  );
  assert.equal(classifyToolCallAsSubagentCard("claude-code-sdk", read), false);
});
