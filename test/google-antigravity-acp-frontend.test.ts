import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentBackendId } from "../src/lib/agent-types";
import { hasAgentBackendIconAsset } from "../src/lib/agent-backend-icons";
import { SUBAGENT_TOOL_CALL_CLASSIFIERS } from "../src/lib/agent-subagent-routing";
import {
  applyHarnessFamilyTransport,
  composerVisibleHarnesses,
  harnessFamilyForBackend,
  normalizeHarnessTransports,
  resolvePreferredHarnessBackendId,
} from "../packages/core/src/harness-families.ts";
import { ACTIVE_AGENT_BACKEND_IDS } from "../packages/core/src/active-agent-backends.ts";
import { harnessAuthSyncIdForBackend } from "../packages/core/src/harness-auth-sync.ts";
import {
  flattenSlashMenuSections,
  getSlashMenuSections,
} from "../packages/core/src/composer-suggestions.ts";

test("google-antigravity-acp is the only Antigravity transport; the agy CLI id is retired", () => {
  const id: AgentBackendId = "google-antigravity-acp";
  assert.ok((ACTIVE_AGENT_BACKEND_IDS as readonly string[]).includes(id));
  assert.ok(!(ACTIVE_AGENT_BACKEND_IDS as readonly string[]).includes("google-antigravity-cli"));
  const family = harnessFamilyForBackend(id);
  assert.equal(family?.id, "antigravity");
  assert.equal(family?.settingsId, "google-antigravity-acp");
  assert.equal(family?.defaultTransportId, "acp");
  assert.deepEqual(
    family?.transports.map((transport) => [transport.id, transport.backendId, transport.label]),
    [["acp", "google-antigravity-acp", "ACP"]]
  );
  assert.equal(harnessFamilyForBackend("google-antigravity-cli"), null);
  assert.equal(resolvePreferredHarnessBackendId(family!), "google-antigravity-acp");

  // A stale `antigravity` transport preference from the two-transport era is dropped.
  assert.deepEqual(normalizeHarnessTransports({ antigravity: "cli", cursor: "acp", bogus: 1 }), {
    cursor: "acp",
  });
  const switched = applyHarnessFamilyTransport({}, family!, "acp");
  assert.deepEqual(switched.harnessTransports, {});
  assert.equal(resolvePreferredHarnessBackendId(family!, switched), "google-antigravity-acp");

  const backends = [
    { id: "google-antigravity-acp", label: "Google Antigravity", enabled: true },
  ];
  assert.deepEqual(
    composerVisibleHarnesses(backends).map((entry) => [entry.id, entry.label]),
    [["google-antigravity-acp", "Google Antigravity"]]
  );
});

test("google-antigravity-acp frontend wiring: icon, subagent classifier, auth sync unit", () => {
  const id: AgentBackendId = "google-antigravity-acp";
  assert.equal(hasAgentBackendIconAsset(id), true);
  assert.equal(typeof SUBAGENT_TOOL_CALL_CLASSIFIERS[id], "function");
  assert.equal(harnessAuthSyncIdForBackend(id), "google-antigravity-acp");
  assert.equal(harnessAuthSyncIdForBackend("google-antigravity-cli"), null);
});

test("agent-advertised slash commands appear in the composer Commands section as inserts", () => {
  const sections = getSlashMenuSections({
    activeBackend: {
      id: "google-antigravity-acp",
      label: "Google Antigravity",
      description: "",
      experimental: true,
      available: true,
      capabilities: {
        supportsLoadSession: true,
        supportsModeSelection: true,
        supportsModelSelection: true,
        supportsSlashCommands: true,
        supportsPermissions: true,
        supportsToolCalls: true,
        supportsStructuredPlans: true,
        supportsTodos: true,
        supportsSessionResume: true,
        supportsPromptImages: true,
        supportsInlineReasoning: true,
        supportsCompletionRetry: false,
        supportsCloudExecution: false,
      },
      defaultMode: "default",
      defaultModelId: "gemini-3.7-flash-high",
      defaultModelName: "Gemini 3.7 Flash (High)",
    },
    agentCommands: [
      {
        name: "plan",
        description:
          "Plan carefully before executing a task (generates an implementation plan artifact and awaits user approval).",
      },
      { name: "/logout", description: "Log out and clear stored credentials." },
      { name: "  ", description: "ignored" },
    ],
  });
  const commands = sections.find((section) => section.id === "commands");
  assert.ok(commands);
  const items = flattenSlashMenuSections([commands!]);
  assert.deepEqual(
    items.map((item) => [item.id, item.label, item.action]),
    [
      ["agent-command:plan", "/plan", { kind: "insert", insert: "/plan " }],
      ["agent-command:logout", "/logout", { kind: "insert", insert: "/logout " }],
    ]
  );
  assert.match(items[0]!.description ?? "", /implementation plan artifact/);
  // No agent commands and nothing else -> no Commands section at all.
  assert.equal(
    getSlashMenuSections({ agentCommands: [] }).some((section) => section.id === "commands"),
    false
  );
});
