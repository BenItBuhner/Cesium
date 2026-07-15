import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentBackendId } from "../src/lib/agent-types";
import { HARNESS_LABELS, HARNESS_ORDER } from "../src/components/editor/agent-harness-settings.tsx";
import { AGENT_BACKEND_ICON_FILES } from "../src/lib/agent-backend-icons.ts";
import { getAgentLabel } from "../src/components/chat/HandoffDivider.tsx";

test("devin acp is listed in harness settings with label and icon", () => {
  const id: AgentBackendId = "devin-acp";
  assert.ok(HARNESS_ORDER.includes(id));
  assert.equal(HARNESS_LABELS[id], "Devin");
  assert.equal(getAgentLabel(id), "Devin");
  assert.ok(AGENT_BACKEND_ICON_FILES[id]);
  assert.equal(AGENT_BACKEND_ICON_FILES[id]?.light, "Devin-Light.svg");
  assert.equal(AGENT_BACKEND_ICON_FILES[id]?.dark, "Devin-Dark.svg");
});
