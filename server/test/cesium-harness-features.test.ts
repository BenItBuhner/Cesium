import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-harness-features-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GOOGLE_API_KEY;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;

const [
  {
    DEFAULT_WAIT_AGENT_MAX_TIMEOUT_MS,
    resolveCesiumHarness,
    resolveWaitAgentTimeoutMs,
    defaultHarnessSettings,
    normalizeHarnessSettings,
  },
  { resolveCesiumTools, parseWaitToolArgs, buildOpenAiToolDefinitions },
  { patchCesiumAgentSettings, getCesiumAgentSettingsPublic },
  { SubagentsV2Runtime },
] = await Promise.all([
  import("../src/lib/agents/cesium/features/index.js"),
  import("../src/lib/agents/cesium/cesium-tools.js"),
  import("../src/lib/cesium-agent-settings.js"),
  import("../src/lib/agents/cesium/features/subagents/v2-runtime.js"),
]);

after(async () => {
  const fs = await import("node:fs/promises");
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

test("harness defaults to subagents v1 with 30-minute wait_agent max", () => {
  const defaults = defaultHarnessSettings();
  assert.equal(defaults.features.subagents.version, 1);
  assert.equal(defaults.limits.waitAgentMaxTimeoutMs, DEFAULT_WAIT_AGENT_MAX_TIMEOUT_MS);
  assert.equal(DEFAULT_WAIT_AGENT_MAX_TIMEOUT_MS, 30 * 60 * 1000);
});

test("resolveCesiumTools swaps subagent tool families by version", () => {
  const v1 = resolveCesiumTools({
    features: { subagents: { version: 1 } },
    limits: defaultHarnessSettings().limits,
  });
  const v2 = resolveCesiumTools({
    features: { subagents: { version: 2 } },
    limits: defaultHarnessSettings().limits,
  });
  assert.ok(v1.toolNames.has("subagent"));
  assert.ok(v1.toolNames.has("read_subagent_transcript"));
  assert.equal(v1.toolNames.has("spawn_agent"), false);
  assert.ok(v2.toolNames.has("spawn_agent"));
  assert.ok(v2.toolNames.has("wait_agent"));
  assert.ok(v2.toolNames.has("followup_task"));
  assert.ok(v2.toolNames.has("send_message"));
  assert.ok(v2.toolNames.has("interrupt_agent"));
  assert.ok(v2.toolNames.has("list_agents"));
  assert.equal(v2.toolNames.has("subagent"), false);
  assert.ok(v2.toolNames.has("read_subagent_transcript"));
});

test("buildOpenAiToolDefinitions reflects harness version", () => {
  const v1Names = buildOpenAiToolDefinitions(
    resolveCesiumTools({ features: { subagents: { version: 1 } } }).tools
  ).map((tool) => tool.function.name);
  const v2Names = buildOpenAiToolDefinitions(
    resolveCesiumTools({ features: { subagents: { version: 2 } } }).tools
  ).map((tool) => tool.function.name);
  assert.ok(v1Names.includes("subagent"));
  assert.ok(v2Names.includes("spawn_agent"));
  assert.equal(v2Names.includes("subagent"), false);
});

test("wait_agent timeout validation rejects out-of-range values", () => {
  const limits = defaultHarnessSettings().limits;
  assert.equal(resolveWaitAgentTimeoutMs(undefined, limits), limits.waitAgentDefaultTimeoutMs);
  assert.equal(resolveWaitAgentTimeoutMs(45_000, limits), 45_000);
  assert.throws(() => resolveWaitAgentTimeoutMs(limits.waitAgentMinTimeoutMs - 1, limits), /at least/);
  assert.throws(() => resolveWaitAgentTimeoutMs(limits.waitAgentMaxTimeoutMs + 1, limits), /at most/);
});

test("parseWaitToolArgs respects configurable max seconds", () => {
  const capped = parseWaitToolArgs({ seconds: 500 }, 120);
  assert.equal(capped.seconds, 120);
  assert.equal(capped.capped, true);
});

test("normalizeHarnessSettings migrates missing harness from legacy settings blobs", () => {
  const normalized = normalizeHarnessSettings(undefined);
  assert.equal(normalized.features.subagents.version, 1);
  assert.equal(normalized.limits.waitAgentMaxTimeoutMs, DEFAULT_WAIT_AGENT_MAX_TIMEOUT_MS);
});

test("settings API persists harness feature version and limits", async () => {
  const patched = await patchCesiumAgentSettings({
    harness: {
      features: { subagents: { version: 2 } },
      limits: {
        waitAgentDefaultTimeoutMs: 15_000,
        waitAgentMaxTimeoutMs: 600_000,
        maxConcurrentSubagents: 4,
      },
    },
  });
  assert.equal(patched.harness.features.subagents.version, 2);
  assert.equal(patched.harness.limits.waitAgentDefaultTimeoutMs, 15_000);
  assert.equal(patched.harness.limits.waitAgentMaxTimeoutMs, 600_000);
  assert.equal(patched.harness.limits.maxConcurrentSubagents, 4);
  const publicSettings = await getCesiumAgentSettingsPublic();
  assert.equal(publicSettings.harness.features.subagents.version, 2);
});

test("SubagentsV2Runtime spawn/list/wait timeout path works without model calls when interrupted", async () => {
  const events: unknown[] = [];
  const runtime = new SubagentsV2Runtime({
    conversationId: "conv-test",
    limits: defaultHarnessSettings().limits,
    defaultModelId: "openai/gpt-5.1",
    appendEvents: async (batch) => {
      events.push(...batch);
    },
    isCancelled: () => false,
  });

  assert.throws(() => runtime.resolveAgent("/root/missing"), /Unknown agent/);
  assert.deepEqual(runtime.listAgents(), []);

  const wait = JSON.parse(
    await runtime.waitAgent({ timeout_ms: defaultHarnessSettings().limits.waitAgentMinTimeoutMs })
  ) as { timed_out: boolean; message: string };
  assert.equal(wait.timed_out, true);
  assert.match(wait.message, /timed out/i);

  runtime.dispose();
  assert.equal(events.length, 0);
});

test("resolveCesiumHarness composes base + feature tools", () => {
  const base = [{ name: "read_file", description: "x", parameters: { type: "object" } }];
  const resolved = resolveCesiumHarness(base, { features: { subagents: { version: 2 } } });
  assert.ok(resolved.toolNames.has("read_file"));
  assert.ok(resolved.toolNames.has("spawn_agent"));
  assert.equal(resolved.subagentsVersion, 2);
});
