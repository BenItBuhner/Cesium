import assert from "node:assert/strict";
import test from "node:test";
import { hasAgentBackendIconAsset } from "../src/lib/agent-backend-icons";
import type { AgentBackendId } from "../src/lib/agent-types";
import { SUBAGENT_TOOL_CALL_CLASSIFIERS } from "../src/lib/agent-subagent-routing";

test("Claude Code SDK frontend id has icon and subagent routing coverage", () => {
  const id: AgentBackendId = "claude-code-sdk";
  assert.equal(hasAgentBackendIconAsset(id), true);
  assert.equal(typeof SUBAGENT_TOOL_CALL_CLASSIFIERS[id], "function");
});
