import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentBackendId } from "../src/lib/agent-types";
import { HARNESS_LABELS, HARNESS_ORDER, harnessDisplayName } from "../src/components/editor/agent-harness-settings.tsx";
import { AGENT_BACKEND_ICON_FILES } from "../src/lib/agent-backend-icons.ts";
import { getAgentLabel } from "../src/components/chat/HandoffDivider.tsx";
import { ACTIVE_AGENT_BACKEND_IDS, composerVisibleBackends } from "../packages/core/src/active-agent-backends.ts";
import { composerVisibleHarnesses, harnessFamilyForBackend } from "../packages/core/src/harness-families.ts";

test("cursor acp is a Cursor family transport, not a separate settings row", () => {
  const id: AgentBackendId = "cursor-acp";
  assert.equal(HARNESS_ORDER.includes(id), false);
  assert.ok(ACTIVE_AGENT_BACKEND_IDS.includes(id));
  assert.equal(harnessFamilyForBackend(id)?.id, "cursor");
  assert.equal(harnessDisplayName(id), "Cursor");
  assert.equal(HARNESS_LABELS[id], "Cursor (ACP)");
  assert.equal(getAgentLabel(id), "Cursor (ACP)");
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

test("composerVisibleHarnesses collapses Cursor SDK and ACP into one picker row", () => {
  const backends = [
    { id: "cursor-sdk", label: "Cursor SDK", enabled: true },
    { id: "cursor-acp", label: "Cursor ACP", enabled: true },
    { id: "cesium-agent", label: "Cesium Agent (Beta)", enabled: true },
  ];
  assert.deepEqual(
    composerVisibleHarnesses(backends).map((entry) => ({ id: entry.id, label: entry.label })),
    [
      { id: "cesium-agent", label: "Cesium Agent (Beta)" },
      { id: "cursor-sdk", label: "Cursor" },
    ]
  );
  assert.deepEqual(
    composerVisibleHarnesses(backends, {
      currentBackendId: "cursor-acp",
      harnessTransports: { cursor: "sdk" },
    }).map((entry) => ({ id: entry.id, label: entry.label })),
    [
      { id: "cesium-agent", label: "Cesium Agent (Beta)" },
      { id: "cursor-acp", label: "Cursor" },
    ]
  );
});
