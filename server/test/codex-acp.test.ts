import assert from "node:assert/strict";
import { test } from "node:test";

test("codex acp backend is registered in the harness menu", async () => {
  const [{ AGENT_BACKENDS, listAgentBackends }, { AGENT_CAPABILITIES }] = await Promise.all([
    import("../src/lib/agents/providers.js"),
    import("../src/lib/agents/agent-contract.js"),
  ]);

  const backends = listAgentBackends();
  const index = backends.findIndex((backend) => backend.id === "codex-acp");
  assert.ok(index >= 0, "codex-acp should appear in listAgentBackends()");
  assert.equal(AGENT_BACKENDS["codex-acp"].label, "Codex");
  assert.equal(AGENT_BACKENDS["codex-app-server"].label, "Codex");
  assert.equal(AGENT_BACKENDS["codex-acp"].capabilities.supportsLoadSession, true);
  assert.equal(AGENT_BACKENDS["codex-acp"].capabilities.supportsPermissions, true);
  assert.equal(AGENT_CAPABILITIES["codex-acp"].supportsToolCalls, true);
  assert.match(AGENT_BACKENDS["codex-acp"].description, /codex acp/i);
});
