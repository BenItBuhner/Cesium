import assert from "node:assert/strict";
import test from "node:test";

process.env.OPENCURSOR_DATA_DIR ||= `${process.cwd()}/tmp/test-claude-code-sdk-options`;
process.env.WORKSPACE_ALLOWED_ROOTS ||= process.cwd();
process.env.OPENCURSOR_CLAUDE_CODE_SDK_BASE_URL ||= "https://infer.techlitnow.com";
process.env.OPENCURSOR_CLAUDE_CODE_SDK_API_KEY ||= "test-key";
process.env.OPENCURSOR_CLAUDE_CODE_SDK_MODEL ||= "glm-5.1-precision";

const { AGENT_BACKENDS, listAgentBackends } = await import(
  "../src/lib/agents/providers.js"
);
const { createClaudeCodeSdkConfigOptions } = await import(
  "../src/lib/agents/provider-cache-store.js"
);

test("Claude Code SDK backend is registered directly after Claude Code", () => {
  const backends = listAgentBackends();
  const ids = backends.map((backend) => backend.id);
  assert.equal(
    ids[ids.indexOf("claude-adapter") + 1],
    "claude-code-sdk"
  );
  assert.equal(AGENT_BACKENDS["claude-code-sdk"].label, "Claude Code SDK");
  assert.equal(AGENT_BACKENDS["claude-code-sdk"].capabilities.supportsPermissions, true);
  assert.equal(AGENT_BACKENDS["claude-code-sdk"].capabilities.supportsStructuredPlans, true);
});

test("Claude Code SDK config exposes native modes, model, permissions, effort, tools", async () => {
  const options = await createClaudeCodeSdkConfigOptions();
  const byId = new Map(options.map((option) => [option.id, option]));
  assert.deepEqual(
    byId.get("mode")?.options.map((option) => option.value),
    ["agent", "plan", "ask", "debug"]
  );
  assert.equal(byId.get("model")?.currentValue, "glm-5.1-precision");
  assert.ok(byId.get("model")?.options.some((option) => option.value === "glm-5.1-precision"));
  assert.ok(byId.get("model")?.options.some((option) => option.value === "claude-sonnet-4-5"));
  assert.ok(byId.get("permission_mode")?.options.some((option) => option.value === "plan"));
  assert.ok(byId.get("effort")?.options.some((option) => option.value === "xhigh"));
  assert.ok(byId.get("thinking")?.options.some((option) => option.value === "adaptive"));
  assert.ok(byId.get("tool_profile")?.options.some((option) => option.value === "safe-readonly"));
});
