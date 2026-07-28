import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import type { AgentBackendId } from "../src/lib/agent-types";
import {
  HARNESS_LABELS,
  HARNESS_ORDER,
} from "../src/components/editor/agent-harness-settings.tsx";
import { getAgentLabel } from "../src/components/chat/HandoffDivider.tsx";
import { AGENT_BACKEND_ICON_FILES } from "../src/lib/agent-backend-icons.ts";
import { SUBAGENT_TOOL_CALL_CLASSIFIERS } from "../packages/core/src/agent-subagent-routing.ts";

test("Grok Build is exposed with branding and ACP subagent routing", () => {
  const id: AgentBackendId = "grok-build";
  assert.ok(HARNESS_ORDER.includes(id));
  assert.equal(HARNESS_LABELS[id], "Grok Build");
  assert.equal(getAgentLabel(id), "Grok Build");
  assert.equal(typeof SUBAGENT_TOOL_CALL_CLASSIFIERS[id], "function");

  const icons = AGENT_BACKEND_ICON_FILES[id];
  assert.deepEqual(icons, {
    light: "Grok-Light.svg",
    dark: "Grok-Dark.svg",
  });
  assert.ok(
    existsSync(path.join(process.cwd(), "public", "agent-backend-icons", icons!.light))
  );
  assert.ok(
    existsSync(path.join(process.cwd(), "public", "agent-backend-icons", icons!.dark))
  );
});
