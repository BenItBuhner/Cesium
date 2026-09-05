import assert from "node:assert/strict";
import test from "node:test";

process.env.OPENCURSOR_DATA_DIR ||= `${process.cwd()}/tmp/test-claude-code-sdk-options`;
process.env.WORKSPACE_ALLOWED_ROOTS ||= process.cwd();
process.env.OPENCURSOR_CLAUDE_CODE_SDK_BASE_URL ||= "https://infer.techlitnow.com/v1";
process.env.OPENCURSOR_CLAUDE_CODE_SDK_API_KEY ||= "test-key";
process.env.OPENCURSOR_CLAUDE_CODE_SDK_MODEL ||= "glm-5.1-precision";
// Unit tests must not spawn the real CLI for model discovery.
process.env.OPENCURSOR_CLAUDE_CODE_SDK_SKIP_PROBE = "1";

const { AGENT_BACKENDS, listAgentBackends } = await import(
  "../src/lib/agents/providers.js"
);
const { createClaudeCodeSdkConfigOptions } = await import(
  "../src/lib/agents/provider-cache-store.js"
);
const {
  claudeCodeSdkModelAliasEnv,
  getClaudeCodeSdkProxyBaseUrl,
  hasClaudeCodeSdkUsableAuth,
  isThirdPartyClaudeCodeSdkProxy,
  normalizeClaudeCodeSdkBaseUrl,
} = await import("../src/lib/claude-code-sdk-credentials.js");

test("Claude Code SDK backend is registered in the harness menu", () => {
  const backends = listAgentBackends();
  const ids = backends.map((backend) => backend.id);
  assert.ok(ids.includes("claude-code-sdk"));
  assert.equal(AGENT_BACKENDS["claude-code-sdk"].label, "Claude Code SDK");
  assert.equal(AGENT_BACKENDS["claude-code-sdk"].capabilities.supportsPermissions, true);
  assert.equal(AGENT_BACKENDS["claude-code-sdk"].capabilities.supportsStructuredPlans, true);
  assert.equal(AGENT_BACKENDS["claude-code-sdk"].capabilities.supportsPromptImages, true);
  assert.equal(AGENT_BACKENDS["claude-code-sdk"].available, true);
  assert.equal(AGENT_BACKENDS["claude-code-sdk"].defaultModelId, "glm-5.1-precision");
  assert.equal(ids.includes("claude-adapter"), false);
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
  // Through a third-party proxy every Claude alias is remapped to the proxied
  // model, so without discovery the catalog is just that model (no duplicate
  // opus/sonnet/haiku rows that would all route to the same place).
  assert.deepEqual(
    byId.get("model")?.options.map((option) => option.value),
    ["glm-5.1-precision"]
  );
  assert.ok(byId.get("permission_mode")?.options.some((option) => option.value === "plan"));
  assert.ok(byId.get("effort")?.options.some((option) => option.value === "xhigh"));
  assert.ok(byId.get("thinking")?.options.some((option) => option.value === "adaptive"));
  assert.ok(byId.get("thinking")?.options.some((option) => option.value === "16000"));
  assert.ok(byId.get("tool_profile")?.options.some((option) => option.value === "safe-readonly"));
  assert.deepEqual(
    byId.get("setting_sources")?.options.map((option) => option.value),
    ["all", "project", "none"]
  );
  assert.equal(byId.get("max_turns")?.currentValue, "unlimited");
  assert.equal(byId.get("max_budget_usd")?.currentValue, "unlimited");
  assert.equal(byId.get("session_persistence")?.currentValue, "enabled");
});

test("proxy base URLs drop a trailing /v1 because the CLI appends /v1/messages itself", () => {
  assert.equal(normalizeClaudeCodeSdkBaseUrl("https://infer.techlitnow.com/v1"), "https://infer.techlitnow.com");
  assert.equal(normalizeClaudeCodeSdkBaseUrl("https://infer.techlitnow.com/v1/"), "https://infer.techlitnow.com");
  assert.equal(normalizeClaudeCodeSdkBaseUrl("https://api.anthropic.com/"), "https://api.anthropic.com");
  assert.equal(normalizeClaudeCodeSdkBaseUrl("  "), "");
  assert.equal(getClaudeCodeSdkProxyBaseUrl(), "https://infer.techlitnow.com");
});

test("third-party proxies remap every Claude model alias to the proxied model for subagents", () => {
  assert.equal(isThirdPartyClaudeCodeSdkProxy(), true);
  assert.equal(hasClaudeCodeSdkUsableAuth(), true);
  const env = claudeCodeSdkModelAliasEnv("kimi-k3");
  assert.deepEqual(env, {
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k3",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k3",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k3",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "kimi-k3",
    ANTHROPIC_SMALL_FAST_MODEL: "kimi-k3",
  });
  assert.deepEqual(claudeCodeSdkModelAliasEnv(undefined), {});
  const previous = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "my-haiku";
  try {
    assert.equal(claudeCodeSdkModelAliasEnv("kimi-k3").ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined, "explicit user aliases win");
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    else process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = previous;
  }
});
