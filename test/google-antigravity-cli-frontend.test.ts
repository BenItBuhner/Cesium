import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentBackendId } from "../src/lib/agent-types";
import { hasAgentBackendIconAsset } from "../src/lib/agent-backend-icons";
import { SUBAGENT_TOOL_CALL_CLASSIFIERS } from "../src/lib/agent-subagent-routing";

test("google antigravity frontend wiring uses fallback icon and classifier", () => {
  const id: AgentBackendId = "google-antigravity-cli";
  assert.equal(hasAgentBackendIconAsset(id), false);
  assert.equal(typeof SUBAGENT_TOOL_CALL_CLASSIFIERS[id], "function");
  assert.equal(
    SUBAGENT_TOOL_CALL_CLASSIFIERS[id]({
      kind: "tool_call",
      toolCallId: "task_1",
      title: "Invoke subagent",
      toolKind: "task",
      status: "in_progress",
      raw: {
        type: "tool.proposed",
        toolName: "invoke_subagent",
        args: { description: "Inspect the codebase" },
      },
    }),
    true
  );
});
