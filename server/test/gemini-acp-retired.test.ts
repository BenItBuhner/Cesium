import assert from "node:assert/strict";
import { test } from "node:test";

test("gemini-acp and google-antigravity-cli are retired and collapse onto the official ACP server", async () => {
  const [{ listAgentBackends, AGENT_BACKENDS }, { LEGACY_AGENT_BACKEND_IDS, isActiveAgentBackendId }] =
    await Promise.all([
      import("../src/lib/agents/providers.js"),
      import("../src/lib/active-agent-backends.js"),
    ]);

  const ids = listAgentBackends().map((backend) => backend.id);
  assert.equal(ids.includes("gemini-acp" as never), false);
  assert.equal(ids.includes("google-antigravity-cli" as never), false);
  assert.ok(ids.includes("google-antigravity-acp"));
  assert.ok(LEGACY_AGENT_BACKEND_IDS.includes("gemini-acp"));
  assert.ok(LEGACY_AGENT_BACKEND_IDS.includes("google-antigravity-cli"));
  assert.equal(isActiveAgentBackendId("gemini-acp"), false);
  assert.equal(isActiveAgentBackendId("google-antigravity-cli"), false);
  assert.equal(AGENT_BACKENDS["google-antigravity-acp"].label, "Google Antigravity");
  assert.match(AGENT_BACKENDS["google-antigravity-acp"].description, /successor to Gemini CLI/i);
  assert.match(AGENT_BACKENDS["google-antigravity-acp"].description, /official Antigravity ACP server/i);
});

for (const legacyId of ["gemini-acp", "google-antigravity-cli"] as const) {
  test(`stored ${legacyId} conversations migrate to google-antigravity-acp with a fresh session`, async () => {
    const { normalizeConversationRecord } = await import(
      "../src/lib/agents/conversation-normalize.js"
    );
    const { AGENT_BACKENDS } = await import("../src/lib/agents/providers.js");

    const now = Date.now();
    const normalized = normalizeConversationRecord({
      schemaVersion: 1,
      id: `c-${legacyId}`,
      workspaceId: "ws-1",
      title: "Old Antigravity chat",
      createdAt: now,
      updatedAt: now,
      lastEventSeq: 1,
      status: "running",
      // The agy bridge stored `agy --conversation` ids here; the ACP server
      // keeps its own session store, so the id must not be reused.
      providerSessionId: "8b6d0f1e-agy-conversation",
      experimental: false,
      capabilities: AGENT_BACKENDS["google-antigravity-acp"].capabilities,
      configOptions: [{ id: "permission", name: "Tool permission", category: "permission", currentValue: "request-review", options: [] }],
      pendingPermission: null,
      config: {
        backendId: legacyId as never,
        mode: "agent",
        modelId: "auto",
        modelName: "Auto",
      },
    } as never);

    assert.equal(normalized.config.backendId, "google-antigravity-acp");
    assert.equal(normalized.providerSessionId, null);
    assert.deepEqual(normalized.configOptions, []);
    assert.equal(normalized.status, "idle");
    assert.equal(normalized.config.mode, "default");
    assert.equal(normalized.config.modelId, "gemini-3.7-flash-high");
  });
}
