import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentBackendId } from "../src/lib/agent-types";
import { HARNESS_LABELS, HARNESS_ORDER, harnessDisplayName } from "../src/components/editor/agent-harness-settings.tsx";
import { AGENT_BACKEND_ICON_FILES } from "../src/lib/agent-backend-icons.ts";
import { getAgentLabel } from "../src/components/chat/HandoffDivider.tsx";
import { ACTIVE_AGENT_BACKEND_IDS } from "../packages/core/src/active-agent-backends.ts";
import { harnessFamilyForBackend } from "../packages/core/src/harness-families.ts";
import { SUBAGENT_TOOL_CALL_CLASSIFIERS } from "../src/lib/agent-subagent-routing";

test("codex acp is a Codex family transport, not a separate settings row", () => {
  const id: AgentBackendId = "codex-acp";
  assert.equal(HARNESS_ORDER.includes(id), false);
  assert.ok(ACTIVE_AGENT_BACKEND_IDS.includes(id));
  assert.equal(harnessFamilyForBackend(id)?.id, "codex");
  assert.equal(harnessFamilyForBackend("codex-app-server")?.defaultTransportId, "server");
  assert.equal(harnessDisplayName(id), "Codex");
  assert.equal(HARNESS_LABELS[id], "Codex (ACP)");
  assert.equal(getAgentLabel(id), "Codex (ACP)");
  assert.ok(AGENT_BACKEND_ICON_FILES[id]);
  assert.equal(AGENT_BACKEND_ICON_FILES[id]?.light, "Codex-Light.svg");
  assert.equal(typeof SUBAGENT_TOOL_CALL_CLASSIFIERS[id], "function");
});
