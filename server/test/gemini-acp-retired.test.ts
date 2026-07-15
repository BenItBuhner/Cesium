import assert from "node:assert/strict";
import { test } from "node:test";

test("gemini-acp is retired from the active harness menu and remapped to Antigravity", async () => {
  const [{ listAgentBackends, AGENT_BACKENDS }, { LEGACY_AGENT_BACKEND_IDS, isActiveAgentBackendId }] =
    await Promise.all([
      import("../src/lib/agents/providers.js"),
      import("../src/lib/active-agent-backends.js"),
    ]);

  const ids = listAgentBackends().map((backend) => backend.id);
  assert.equal(ids.includes("gemini-acp"), false);
  assert.ok(ids.includes("google-antigravity-cli"));
  assert.ok(LEGACY_AGENT_BACKEND_IDS.includes("gemini-acp"));
  assert.equal(isActiveAgentBackendId("gemini-acp"), false);
  assert.equal(AGENT_BACKENDS["google-antigravity-cli"].label, "Google Antigravity CLI");
  assert.match(AGENT_BACKENDS["google-antigravity-cli"].description, /successor to Gemini CLI/i);
});

test("stored gemini-acp conversations migrate to google-antigravity-cli", async () => {
  const { normalizeConversationRecord } = await import(
    "../src/lib/agents/conversation-normalize.js"
  );
  const { AGENT_BACKENDS } = await import("../src/lib/agents/providers.js");

  const now = Date.now();
  const normalized = normalizeConversationRecord({
    schemaVersion: 1,
    id: "c-gemini",
    workspaceId: "ws-1",
    title: "Old Gemini chat",
    createdAt: now,
    updatedAt: now,
    lastEventSeq: 1,
    status: "running",
    providerSessionId: "stale-gemini-session",
    experimental: false,
    capabilities: AGENT_BACKENDS["google-antigravity-cli"].capabilities,
    configOptions: [],
    pendingPermission: null,
    config: {
      backendId: "gemini-acp" as never,
      mode: "agent",
      modelId: "auto",
      modelName: "Auto",
    },
  } as never);

  assert.equal(normalized.config.backendId, "google-antigravity-cli");
  assert.equal(normalized.providerSessionId, null);
  assert.equal(normalized.status, "idle");
});
