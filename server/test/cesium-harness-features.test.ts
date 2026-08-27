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
    DEFAULT_PLUGIN_HOOK_TIMEOUT_MS,
    resolveCesiumHarness,
    resolveWaitAgentTimeoutMs,
    defaultHarnessSettings,
    normalizeHarnessSettings,
    createCesiumFeatureRegistry,
    CesiumHarnessPluginRuntime,
    loadCesiumHarnessPluginModules,
    loadCesiumHarnessPluginModulesFromEnv,
    resetLoadedCesiumHarnessPluginModulesForTests,
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
  resetLoadedCesiumHarnessPluginModulesForTests();
  const fs = await import("node:fs/promises");
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

test("harness defaults to subagents v1 with 30-minute wait_agent max", () => {
  const defaults = defaultHarnessSettings();
  assert.equal(defaults.features.subagents.version, 1);
  assert.equal(
    defaults.limits.pluginHookTimeoutMs,
    DEFAULT_PLUGIN_HOOK_TIMEOUT_MS
  );
  assert.equal(defaults.limits.waitAgentMaxTimeoutMs, DEFAULT_WAIT_AGENT_MAX_TIMEOUT_MS);
  assert.equal(DEFAULT_WAIT_AGENT_MAX_TIMEOUT_MS, 30 * 60 * 1000);
});

test("partial plugin settings patches preserve version and replace config", async () => {
  await patchCesiumAgentSettings({
    harness: {
      features: {
        subagents: {
          version: 2,
          enabled: true,
          config: { first: 1, retained: true },
        },
      },
      limits: { pluginHookTimeoutMs: 2_500 },
    },
  });
  const patched = await patchCesiumAgentSettings({
    harness: {
      features: {
        subagents: {
          enabled: false,
          config: { first: 2 },
        },
      },
    },
  });
  assert.equal(patched.harness.features.subagents.version, 2);
  assert.equal(patched.harness.features.subagents.enabled, false);
  assert.deepEqual(patched.harness.features.subagents.config, {
    first: 2,
  });
  assert.equal(patched.harness.limits.pluginHookTimeoutMs, 2_500);
  await patchCesiumAgentSettings({
    harness: {
      features: {
        subagents: { version: 1, enabled: true, config: {} },
      },
      limits: { pluginHookTimeoutMs: DEFAULT_PLUGIN_HOOK_TIMEOUT_MS },
    },
  });
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

test("wait_agent timeout validation clamps low values and rejects high values (Codex parity)", () => {
  const limits = defaultHarnessSettings().limits;
  assert.equal(resolveWaitAgentTimeoutMs(undefined, limits), limits.waitAgentDefaultTimeoutMs);
  assert.equal(resolveWaitAgentTimeoutMs(45_000, limits), 45_000);
  // Codex MultiAgentV2 clamps requests below the minimum up to the minimum.
  assert.equal(
    resolveWaitAgentTimeoutMs(limits.waitAgentMinTimeoutMs - 1, limits),
    limits.waitAgentMinTimeoutMs
  );
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

test("feature registry resolves and executes custom modules without central resolver edits", async () => {
  const registry = createCesiumFeatureRegistry([
    {
      id: "custom-memory",
      label: "Custom memory",
      description: "Test plugin layer",
      defaultVersion: 1,
      versions: [
        {
          version: 1,
          label: "V1",
          description: "Baseline",
          resolve: () => ({
            id: "custom-memory",
            version: 1,
            label: "Custom memory V1",
            description: "Baseline",
            tools: [
              {
                name: "memory_lookup_v1",
                description: "Lookup memory",
                parameters: { type: "object" },
              },
            ],
            toolNames: ["memory_lookup_v1"],
          }),
        },
        {
          version: 2,
          label: "V2",
          description: "Experimental",
          resolve: () => ({
            id: "custom-memory",
            version: 2,
            label: "Custom memory V2",
            description: "Experimental",
            tools: [
              {
                name: "memory_lookup_v2",
                description: "Lookup memory with citations",
                parameters: { type: "object" },
              },
            ],
            toolNames: ["memory_lookup_v2"],
            executeTool: (name, args) =>
              JSON.stringify({
                name,
                query: args.query,
                source: "custom-memory-v2",
              }),
          }),
        },
      ],
    },
  ]);
  const resolved = resolveCesiumHarness(
    [],
    {
      features: {
        subagents: { version: 1 },
        "custom-memory": { version: 2 },
      },
    },
    registry
  );
  assert.deepEqual(resolved.modules.map((module) => `${module.id}@${module.version}`), [
    "custom-memory@2",
  ]);
  assert.equal(resolved.toolNames.has("memory_lookup_v2"), true);
  assert.equal(resolved.toolNames.has("memory_lookup_v1"), false);
  assert.equal(
    await resolved.modules[0]?.executeTool?.("memory_lookup_v2", {
      query: "plugin registry",
    }),
    JSON.stringify({
      name: "memory_lookup_v2",
      query: "plugin registry",
      source: "custom-memory-v2",
    })
  );
});

test("harness plugin registry resolves dependencies deterministically with config", () => {
  const resolvedOrder: string[] = [];
  const createDefinition = (
    id: string,
    options: {
      priority?: number;
      dependencies?: string[];
      optionalDependencies?: string[];
      enabledByDefault?: boolean;
    } = {}
  ) => ({
    apiVersion: 1 as const,
    id,
    label: id,
    description: id,
    defaultVersion: 1,
    ...options,
    versions: [
      {
        version: 1,
        label: "V1",
        description: "test",
        resolve: (context: {
          config: Readonly<Record<string, unknown>>;
        }) => {
          resolvedOrder.push(`${id}:${String(context.config.marker ?? "")}`);
          return {
            id,
            version: 1,
            label: id,
            description: id,
            tools: [],
            toolNames: [],
          };
        },
      },
    ],
  });
  const registry = createCesiumFeatureRegistry([
    createDefinition("consumer", {
      priority: -100,
      dependencies: ["foundation"],
      optionalDependencies: ["optional"],
    }),
    createDefinition("optional", { priority: 20, enabledByDefault: false }),
    createDefinition("foundation", { priority: 10 }),
  ]);
  const settings = normalizeHarnessSettings({
    features: {
      subagents: { version: 1, enabled: false },
      foundation: { version: 1, config: { marker: "configured" } },
      consumer: { version: 1 },
      optional: { version: 1, enabled: true },
    },
  });
  const modules = registry.resolve(settings, settings.limits);
  assert.deepEqual(modules.map((module) => module.id), [
    "foundation",
    "optional",
    "consumer",
  ]);
  assert.deepEqual(resolvedOrder, [
    "foundation:configured",
    "optional:",
    "consumer:",
  ]);
  assert.equal(modules[0]?.config?.marker, "configured");
  assert.equal(registry.catalog()[0]?.failureMode, "isolate");
  assert.ok(registry.revision() >= 3);
});

test("harness plugin registry rejects missing, disabled, and cyclic dependencies", () => {
  const plugin = (id: string, dependencies: string[] = []) => ({
    id,
    label: id,
    description: id,
    defaultVersion: 1,
    dependencies,
    versions: [
      {
        version: 1,
        label: "V1",
        description: "test",
        resolve: () => ({
          id,
          version: 1,
          label: id,
          description: id,
          tools: [],
          toolNames: [],
        }),
      },
    ],
  });
  const missing = createCesiumFeatureRegistry([plugin("consumer", ["missing"])]);
  assert.throws(
    () => missing.resolve(defaultHarnessSettings(), defaultHarnessSettings().limits),
    /requires missing plugin/
  );

  const disabled = createCesiumFeatureRegistry([
    plugin("foundation"),
    plugin("consumer", ["foundation"]),
  ]);
  const disabledSettings = normalizeHarnessSettings({
    features: {
      subagents: { version: 1 },
      foundation: { version: 1, enabled: false },
      consumer: { version: 1 },
    },
  });
  assert.throws(
    () => disabled.resolve(disabledSettings, disabledSettings.limits),
    /requires disabled plugin/
  );

  const cyclic = createCesiumFeatureRegistry([
    plugin("left", ["right"]),
    plugin("right", ["left"]),
  ]);
  assert.throws(
    () => cyclic.resolve(defaultHarnessSettings(), defaultHarnessSettings().limits),
    /dependency cycle/
  );
  assert.throws(
    () =>
      createCesiumFeatureRegistry().register({
        apiVersion: 2 as never,
        id: "future-api",
        label: "Future API",
        description: "Unsupported",
        defaultVersion: 1,
        versions: [],
      }),
    /unsupported plugin API version/
  );
});

test("resolved harness rejects plugin tool collisions with core tools", () => {
  const registry = createCesiumFeatureRegistry([
    {
      id: "colliding-plugin",
      label: "Colliding plugin",
      description: "Collision test",
      defaultVersion: 1,
      toolNames: ["read_file"],
      versions: [
        {
          version: 1,
          label: "V1",
          description: "Collision",
          resolve: () => ({
            id: "colliding-plugin",
            version: 1,
            label: "Colliding plugin",
            description: "Collision",
            tools: [
              {
                name: "read_file",
                description: "Conflicts with the core tool",
                parameters: { type: "object" },
              },
            ],
            toolNames: ["read_file"],
          }),
        },
      ],
    },
  ]);
  assert.throws(
    () =>
      resolveCesiumHarness(
        [
          {
            name: "read_file",
            description: "Core read",
            parameters: { type: "object" },
          },
        ],
        {
          features: {
            subagents: { version: 1 },
            "colliding-plugin": { version: 1 },
          },
        },
        registry
      ),
    /tool collision: read_file/
  );
});

test("per-session harness plugin runtime composes hooks and isolates failures", async () => {
  const calls: string[] = [];
  const diagnostics: Array<{ pluginId: string; hook: string }> = [];
  const runtime = new CesiumHarnessPluginRuntime({
    modules: [
      {
        id: "first",
        version: 1,
        label: "First",
        description: "First",
        tools: [],
        toolNames: [],
        config: { suffix: "-one" },
        hooks: {
          onSessionStart: () => calls.push("first:start"),
          onSessionDispose: () => calls.push("first:dispose"),
          onTurnStart: (_context, input) => ({ ...input, text: `${input.text}-one` }),
          transformSystemPrompt: (_context, prompt) => `${prompt}\nfirst`,
          transformMessages: (_context, messages) => [
            ...messages,
            { role: "user", content: "from-first" },
          ],
          beforeTool: (_context, request) => ({
            ...request,
            arguments: { ...request.arguments, first: true },
          }),
          afterTool: (_context, _request, result) => `${result}-first`,
          onTurnEnd: () => calls.push("first:end"),
        },
      },
      {
        id: "broken",
        version: 1,
        label: "Broken",
        description: "Broken",
        tools: [],
        toolNames: [],
        failureMode: "isolate",
        hooks: {
          transformSystemPrompt: () => {
            throw new Error("expected isolated failure");
          },
          afterTool: () => 42 as never,
          onSessionDispose: () => calls.push("broken:dispose"),
        },
      },
      {
        id: "last",
        version: 1,
        label: "Last",
        description: "Last",
        tools: [],
        toolNames: [],
        hooks: {
          transformSystemPrompt: (_context, prompt) => `${prompt}\nlast`,
          afterTool: (_context, _request, result) => `${result}-last`,
          onSessionDispose: () => calls.push("last:dispose"),
        },
      },
    ],
    context: () => ({
      sessionId: "session",
      conversationId: "conversation",
      workspaceId: "workspace",
      workspaceRoot: TEST_DATA_DIR,
      mode: "agent",
      modelId: "test/model",
    }),
    onDiagnostic: (diagnostic) => {
      diagnostics.push({ pluginId: diagnostic.pluginId, hook: diagnostic.hook });
    },
  });
  await runtime.start();
  const turn = await runtime.turnStart({ text: "hello", userMessageId: "user" });
  assert.equal(turn.text, "hello-one");
  assert.equal(await runtime.transformSystemPrompt("base"), "base\nfirst\nlast");
  const messages = await runtime.transformMessages([{ role: "system", content: "base" }]);
  assert.equal(messages.at(-1)?.content, "from-first");
  const request = await runtime.beforeTool({ id: "tool", name: "demo", arguments: {} });
  assert.equal(request.arguments.first, true);
  assert.equal(await runtime.afterTool(request, "result"), "result-first-last");
  await runtime.turnEnd({ status: "completed" });
  await runtime.dispose();
  assert.deepEqual(calls, [
    "first:start",
    "first:end",
    "last:dispose",
    "broken:dispose",
    "first:dispose",
  ]);
  assert.deepEqual(diagnostics, [
    { pluginId: "broken", hook: "transformSystemPrompt" },
    { pluginId: "broken", hook: "afterTool" },
  ]);
});

test("fatal harness plugin hooks fail closed", async () => {
  const runtime = new CesiumHarnessPluginRuntime({
    modules: [
      {
        id: "policy",
        version: 1,
        label: "Policy",
        description: "Policy",
        failureMode: "fatal",
        tools: [],
        toolNames: [],
        hooks: {
          beforeTool: () => {
            throw new Error("blocked by policy plugin");
          },
        },
      },
    ],
    context: () => ({
      sessionId: "session",
      conversationId: "conversation",
      workspaceId: "workspace",
      workspaceRoot: TEST_DATA_DIR,
      mode: "agent",
      modelId: "test/model",
    }),
  });
  await assert.rejects(
    () => runtime.beforeTool({ id: "tool", name: "demo", arguments: {} }),
    /policy.*beforeTool.*blocked by policy plugin/
  );
});

test("isolated plugin hook timeouts preserve the previous pipeline value", async () => {
  const diagnostics: Array<{ pluginId: string; hook: string; message: string }> = [];
  const runtime = new CesiumHarnessPluginRuntime({
    hookTimeoutMs: 5,
    modules: [
      {
        id: "slow-plugin",
        version: 1,
        label: "Slow plugin",
        description: "Times out",
        tools: [],
        toolNames: [],
        hooks: {
          transformSystemPrompt: async (_context, prompt) => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return `${prompt}\ntoo late`;
          },
        },
      },
    ],
    context: () => ({
      sessionId: "session",
      conversationId: "conversation",
      workspaceId: "workspace",
      workspaceRoot: TEST_DATA_DIR,
      mode: "agent",
      modelId: "test/model",
    }),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  assert.equal(await runtime.transformSystemPrompt("original"), "original");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.pluginId, "slow-plugin");
  assert.equal(diagnostics[0]?.hook, "transformSystemPrompt");
  assert.match(diagnostics[0]?.message ?? "", /timed out after 5ms/);
  await runtime.dispose();
});

test("executable harness plugin modules load once and can unload", async () => {
  const fs = await import("node:fs/promises");
  const modulePath = path.join(TEST_DATA_DIR, "external-plugin.mjs");
  await fs.mkdir(TEST_DATA_DIR, { recursive: true });
  await fs.writeFile(
    modulePath,
    [
      "export default {",
      "  apiVersion: 1,",
      "  id: 'external-test',",
      "  label: 'External test',",
      "  description: 'Loaded from a local module',",
      "  defaultVersion: 1,",
      "  versions: [{",
      "    version: 1, label: 'V1', description: 'test',",
      "    resolve: () => ({ id: 'external-test', version: 1, label: 'External test', description: 'test', tools: [], toolNames: [] })",
      "  }]",
      "};",
    ].join("\n"),
    "utf8"
  );
  const registry = createCesiumFeatureRegistry();
  const first = await loadCesiumHarnessPluginModules(
    [modulePath],
    registry,
    TEST_DATA_DIR
  );
  const second = await loadCesiumHarnessPluginModules(
    [modulePath],
    registry,
    TEST_DATA_DIR
  );
  assert.equal(first[0], second[0]);
  assert.deepEqual(registry.catalog().map((entry) => entry.id), ["external-test"]);
  first[0]?.unload();
  assert.deepEqual(registry.catalog(), []);
});

test("environment plugin loader rejects malformed module lists without registrations", async () => {
  const previous = process.env.CESIUM_HARNESS_PLUGIN_MODULES;
  const registry = createCesiumFeatureRegistry();
  process.env.CESIUM_HARNESS_PLUGIN_MODULES = '{"not":"an array"}';
  try {
    await assert.rejects(
      () => loadCesiumHarnessPluginModulesFromEnv(registry, TEST_DATA_DIR),
      /JSON must be an array of strings/
    );
    assert.deepEqual(registry.catalog(), []);
  } finally {
    if (previous == null) {
      delete process.env.CESIUM_HARNESS_PLUGIN_MODULES;
    } else {
      process.env.CESIUM_HARNESS_PLUGIN_MODULES = previous;
    }
  }
});

test("followup_task queued during a running turn is drained after the turn ends", async () => {
  const events: unknown[] = [];
  let turnCount = 0;
  const runtime = new SubagentsV2Runtime({
    conversationId: "conv-followup",
    limits: defaultHarnessSettings().limits,
    defaultModelId: "openai/gpt-5.1",
    appendEvents: async (batch) => {
      events.push(...batch);
    },
  });

  // Inject a fake long-running turn by spawning then immediately queueing follow-up
  // without a live model: use interrupt + manual mailbox drain path via public API.
  // Simulate orphaned follow-up: push a trigger message while status is running.
  const agentPath = "/root/drain_test";
  // Access via spawn would call the model; instead exercise drain via list/wait after
  // constructing through spawn with a failing auth path is hard. Use interrupt/list only.
  // Direct unit: enqueue via followup after forcing a completed agent then start another.
  // Prefer: spawn fails without key - skip live model by stubbing through interrupt path.
  runtime.dispose();

  // Dedicated lightweight drain check using wait timeout + pending followup semantics:
  const runtime2 = new SubagentsV2Runtime({
    conversationId: "conv-followup-2",
    limits: {
      ...defaultHarnessSettings().limits,
      waitAgentMinTimeoutMs: 50,
      waitAgentDefaultTimeoutMs: 50,
      waitAgentMaxTimeoutMs: 5_000,
    },
    defaultModelId: "openai/missing-model-for-unit-test",
    appendEvents: async (batch) => {
      events.push(...batch);
      turnCount += 1;
    },
  });

  // Without a valid provider this will error the child turn - still drains follow-ups.
  const spawnResult = JSON.parse(
    await runtime2.spawnAgent({
      task_name: "drain_test",
      message: "first",
    })
  );
  assert.equal(spawnResult.path, agentPath);

  // Queue follow-up while first turn is (or was) in flight.
  await runtime2.followupTask({
    target: agentPath,
    message: "second followup that must not be orphaned",
  });

  // Wait long enough for error turn(s) + drain.
  await runtime2.waitAgent({ timeout_ms: 2_000 }).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const listed = runtime2.listAgents();
  assert.equal(listed.length, 1);
  // Follow-up must have been consumed (not left pending forever).
  const transcript = await runtime2.readTranscript({ subagentId: agentPath });
  assert.match(transcript, /second followup that must not be orphaned/);
  runtime2.dispose();
  assert.ok(turnCount >= 1);
});

test("wait_agent still wakes when subagent card persistence fails", async () => {
  const runtime = new SubagentsV2Runtime({
    conversationId: "conv-card-fail",
    limits: {
      ...defaultHarnessSettings().limits,
      waitAgentMinTimeoutMs: 50,
      waitAgentDefaultTimeoutMs: 50,
      waitAgentMaxTimeoutMs: 5_000,
    },
    defaultModelId: "openai/missing-model-for-unit-test",
    appendEvents: async () => {
      throw new Error("card persistence failed");
    },
  });

  await runtime.spawnAgent({
    task_name: "card_fail",
    message: "do work",
  });

  const wait = JSON.parse(await runtime.waitAgent({ timeout_ms: 3_000 })) as {
    timed_out: boolean;
    agents_with_updates?: string[];
  };
  assert.equal(wait.timed_out, false);
  assert.ok(wait.agents_with_updates?.includes("/root/card_fail"));
  runtime.dispose();
});

test("empty tools array means omit tools, not fall back to defaults", async () => {
  const { openAiTools, responseTools, anthropicTools } = await import(
    "../src/lib/agents/cesium/cesium-tools.js"
  );
  assert.deepEqual(openAiTools([]), []);
  assert.deepEqual(responseTools([]), []);
  assert.deepEqual(anthropicTools([]), []);
  assert.ok(openAiTools().length > 0);
});
