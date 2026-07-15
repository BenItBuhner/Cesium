import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildHarnessProbeChecklist,
  HARNESS_PROBE_BACKENDS,
  HARNESS_PROBE_SCENARIOS,
} from "../src/lib/agents/harness-probe-scenarios.js";

test("harness probe checklist covers every backend and required scenario", () => {
  const required = [
    "read",
    "grep",
    "web_fetch",
    "edit",
    "terminal",
    "mcp",
    "plugin_mcp",
    "plugin_skill",
    "subagent_task",
    "ask_question",
    "plan_mode",
    "permission_prompt",
    "attachments",
    "cancel",
    "resume",
    "auth_failure",
  ];
  assert.deepEqual(
    HARNESS_PROBE_SCENARIOS.map((scenario) => scenario.id),
    required
  );
  const checklist = buildHarnessProbeChecklist();
  assert.equal(checklist.length, HARNESS_PROBE_BACKENDS.length * HARNESS_PROBE_SCENARIOS.length);
  for (const backendId of HARNESS_PROBE_BACKENDS) {
    assert.equal(
      checklist.filter((item) => item.backendId === backendId).length,
      HARNESS_PROBE_SCENARIOS.length
    );
  }
});
