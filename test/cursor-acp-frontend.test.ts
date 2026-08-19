import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentBackendId } from "../src/lib/agent-types";
import { HARNESS_LABELS, HARNESS_ORDER } from "../src/components/editor/agent-harness-settings.tsx";
import { AGENT_BACKEND_ICON_FILES } from "../src/lib/agent-backend-icons.ts";
import { getAgentLabel } from "../src/components/chat/HandoffDivider.tsx";
import { ACTIVE_AGENT_BACKEND_IDS, composerVisibleBackends } from "../packages/core/src/active-agent-backends.ts";

test("cursor acp is listed in harness settings with label and icon", () => {
  const id: AgentBackendId = "cursor-acp";
  assert.ok(HARNESS_ORDER.includes(id));
  assert.ok(ACTIVE_AGENT_BACKEND_IDS.includes(id));
  assert.equal(HARNESS_LABELS[id], "Cursor ACP");
  assert.equal(getAgentLabel(id), "Cursor ACP");
  assert.ok(AGENT_BACKEND_ICON_FILES[id]);
  assert.equal(AGENT_BACKEND_ICON_FILES[id]?.light, "Cursor-Light.svg");
});

test("composerVisibleBackends hides disabled harnesses except the current one", () => {
  const backends = [
    { id: "cursor-sdk", enabled: true },
    { id: "cursor-acp", enabled: false },
    { id: "cesium-agent", enabled: true },
  ];
  assert.deepEqual(
    composerVisibleBackends(backends).map((entry) => entry.id),
    ["cursor-sdk", "cesium-agent"]
  );
  assert.deepEqual(
    composerVisibleBackends(backends, "cursor-acp").map((entry) => entry.id),
    ["cursor-sdk", "cursor-acp", "cesium-agent"]
  );
});
