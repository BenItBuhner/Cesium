import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentBackendId } from "../src/lib/agent-types";
import { hasAgentBackendIconAsset } from "../src/lib/agent-backend-icons";
import { SUBAGENT_TOOL_CALL_CLASSIFIERS } from "../src/lib/agent-subagent-routing";

test("codex app server frontend wiring uses codex icon and classifier", () => {
  const id: AgentBackendId = "codex-app-server";
  assert.equal(hasAgentBackendIconAsset(id), true);
  assert.equal(typeof SUBAGENT_TOOL_CALL_CLASSIFIERS[id], "function");
  assert.equal(
    SUBAGENT_TOOL_CALL_CLASSIFIERS[id]({
      kind: "tool_call",
      toolCallId: "task_1",
      title: "Task",
      toolKind: "task",
      status: "in_progress",
      raw: { type: "collabToolCall", tool: "spawn_agent" },
    }),
    true
  );
});
