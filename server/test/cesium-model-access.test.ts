import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = await mkdtemp(
  path.join(os.tmpdir(), "cesium-model-access-data-")
);
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;

const {
  CESIUM_MODEL_DESCRIPTION_MAX_LENGTH,
  createCesiumAgentConfigOptions,
  formatCesiumModelRoster,
  isCesiumModelEnabled,
  listCesiumAgentModelRoster,
  listCredentialedCesiumProviderIds,
  mergeCesiumModelAccess,
  normalizeCesiumModelAccess,
  patchCesiumAgentSettings,
  resolveCesiumSpawnModelId,
  upsertCesiumProviderKey,
} = await import("../src/lib/cesium-agent-settings.js");

// Seed a fresh models.dev cache so catalog lookups never hit the network.
const seededEntries = [
  {
    providerId: "techlit",
    providerName: "TechLit",
    modelId: "techlit/unit-kimi-x9",
    modelName: "TechLit · Unit Kimi X9",
    apiKind: "openai-chat-completions",
    supportsTools: true,
    supportsReasoning: false,
    supportsStructuredOutput: false,
    supportsImages: true,
    contextWindow: 1_000_000,
  },
  {
    providerId: "openai",
    providerName: "OpenAI",
    modelId: "openai/gpt-5.1",
    modelName: "OpenAI · GPT-5.1",
    apiKind: "openai-responses",
    supportsTools: true,
    supportsReasoning: true,
    supportsStructuredOutput: true,
    supportsImages: true,
    contextWindow: 400_000,
  },
  {
    providerId: "openai",
    providerName: "OpenAI",
    modelId: "openai/shared-model",
    modelName: "OpenAI · Shared Model",
    apiKind: "openai-responses",
    supportsTools: true,
    supportsReasoning: false,
    supportsStructuredOutput: false,
    supportsImages: false,
    contextWindow: 100_000,
  },
  {
    providerId: "acme",
    providerName: "Acme",
    modelId: "acme/shared-model",
    modelName: "Acme · Shared Model",
    apiKind: "openai-compatible",
    supportsTools: true,
    supportsReasoning: false,
    supportsStructuredOutput: false,
    supportsImages: false,
    contextWindow: 100_000,
  },
  {
    providerId: "acme",
    providerName: "Acme",
    modelId: "acme/no-tools",
    modelName: "Acme · No Tools",
    apiKind: "openai-compatible",
    supportsTools: false,
    supportsReasoning: false,
    supportsStructuredOutput: false,
    supportsImages: false,
    contextWindow: 8_000,
  },
];
await mkdir(path.join(TEST_DATA_DIR, "profile"), { recursive: true });
await writeFile(
  path.join(TEST_DATA_DIR, "profile", "cesium-agent-models-dev-cache.json"),
  JSON.stringify({ schemaVersion: 1, updatedAt: Date.now(), entries: seededEntries })
);

test("normalizeCesiumModelAccess drops implicit rows and caps descriptions", () => {
  const normalized = normalizeCesiumModelAccess({
    entries: {
      "openai/gpt-5.1": { enabled: true },
      "techlit/unit-kimi-x9": { enabled: true, description: "  fast multimodal default  " },
      "acme/shared-model": { enabled: false },
      "": { enabled: false },
      "openai/overlong": { enabled: true, description: "x".repeat(400) },
    },
  });
  // enabled + no description is the implicit default → dropped.
  assert.equal(normalized.entries["openai/gpt-5.1"], undefined);
  assert.deepEqual(normalized.entries["techlit/unit-kimi-x9"], {
    enabled: true,
    description: "fast multimodal default",
  });
  assert.deepEqual(normalized.entries["acme/shared-model"], { enabled: false });
  // Corrupt on-disk data is truncated rather than rejected.
  assert.equal(
    normalized.entries["openai/overlong"]?.description?.length,
    CESIUM_MODEL_DESCRIPTION_MAX_LENGTH
  );
  assert.equal(isCesiumModelEnabled("openai/gpt-5.1", normalized), true);
  assert.equal(isCesiumModelEnabled("acme/shared-model", normalized), false);
});

test("mergeCesiumModelAccess merges per entry, deletes on null, rejects long notes", () => {
  const current = normalizeCesiumModelAccess({
    entries: {
      "acme/shared-model": { enabled: false },
      "techlit/unit-kimi-x9": { enabled: true, description: "keep me" },
    },
  });
  const merged = mergeCesiumModelAccess(current, {
    entries: {
      "acme/shared-model": { enabled: true },
      "openai/gpt-5.1": { description: "strong reasoning; use for hard planning" },
      "techlit/unit-kimi-x9": null,
    },
  });
  // Re-enabled with no note → implicit default, so the row disappears.
  assert.equal(merged.entries["acme/shared-model"], undefined);
  assert.deepEqual(merged.entries["openai/gpt-5.1"], {
    enabled: true,
    description: "strong reasoning; use for hard planning",
  });
  assert.equal(merged.entries["techlit/unit-kimi-x9"], undefined);

  assert.throws(
    () =>
      mergeCesiumModelAccess(current, {
        entries: {
          "openai/gpt-5.1": { description: "y".repeat(CESIUM_MODEL_DESCRIPTION_MAX_LENGTH + 1) },
        },
      }),
    /at most 250 characters/
  );
});

test("patchCesiumAgentSettings persists model access and clearing descriptions", async () => {
  const patched = await patchCesiumAgentSettings({
    modelAccess: {
      entries: {
        "acme/shared-model": { enabled: false },
        "techlit/unit-kimi-x9": { description: "fast + multimodal - great subagent default" },
      },
    },
  });
  assert.deepEqual(patched.modelAccess.entries["acme/shared-model"], { enabled: false });
  assert.equal(
    patched.modelAccess.entries["techlit/unit-kimi-x9"]?.description,
    "fast + multimodal - great subagent default"
  );

  const cleared = await patchCesiumAgentSettings({
    modelAccess: { entries: { "techlit/unit-kimi-x9": { description: null } } },
  });
  assert.equal(cleared.modelAccess.entries["techlit/unit-kimi-x9"], undefined);
  // Untouched entries survive subsequent patches.
  assert.deepEqual(cleared.modelAccess.entries["acme/shared-model"], { enabled: false });
});

test("roster filters disabled + tool-less models and keeps the active default", async () => {
  await patchCesiumAgentSettings({
    modelAccess: {
      entries: {
        "acme/shared-model": { enabled: false },
        "openai/shared-model": { enabled: false },
        "openai/gpt-5.1": { description: "deep reasoning specialist" },
      },
    },
  });
  const roster = await listCesiumAgentModelRoster({ defaultModelId: "acme/shared-model" });
  const ids = roster.map((entry) => entry.modelId);
  assert.ok(ids.includes("techlit/unit-kimi-x9"));
  assert.ok(ids.includes("openai/gpt-5.1"));
  // Disabled - but it is the active default, so it stays in the roster.
  assert.ok(ids.includes("acme/shared-model"));
  assert.equal(roster[0]?.modelId, "acme/shared-model");
  assert.equal(roster[0]?.isDefault, true);
  // Disabled and not default → gone. Tool-less models never appear.
  assert.ok(!ids.includes("openai/shared-model"));
  assert.ok(!ids.includes("acme/no-tools"));
  // User note flows through, and described models sort before undescribed ones.
  const gpt = roster.find((entry) => entry.modelId === "openai/gpt-5.1");
  assert.equal(gpt?.description, "deep reasoning specialist");
  assert.ok(
    ids.indexOf("openai/gpt-5.1") < ids.indexOf("techlit/unit-kimi-x9"),
    "described models should precede undescribed ones"
  );
});

test("formatCesiumModelRoster renders notes, default marker, and overflow", () => {
  const text = formatCesiumModelRoster(
    [
      {
        modelId: "techlit/unit-kimi-x9",
        modelName: "Unit Kimi X9",
        description: "fast multimodal default",
        supportsReasoning: false,
        supportsImages: true,
        contextWindow: 1_000_000,
        isDefault: true,
      },
      {
        modelId: "openai/gpt-5.1",
        modelName: "GPT-5.1",
        description: null,
        supportsReasoning: true,
        supportsImages: true,
        contextWindow: 400_000,
        isDefault: false,
      },
      {
        modelId: "acme/tiny",
        modelName: "Tiny",
        description: null,
        supportsReasoning: false,
        supportsImages: false,
        contextWindow: 8_000,
        isDefault: false,
      },
    ],
    { maxEntries: 2 }
  );
  assert.match(text, /inherit the current model by default/);
  assert.match(text, /techlit\/unit-kimi-x9 \(current default\).*- fast multimodal default/);
  assert.match(text, /openai\/gpt-5\.1/);
  assert.match(text, /…and 1 more enabled models/);
  assert.ok(!text.includes("acme/tiny"));
  assert.equal(formatCesiumModelRoster([]), "");
});

test("resolveCesiumSpawnModelId inherits, resolves shorthand, and rejects disabled", async () => {
  // Omitted → inherit the parent default, no catalog lookup required.
  assert.equal(
    await resolveCesiumSpawnModelId({ defaultModelId: "techlit/unit-kimi-x9" }),
    "techlit/unit-kimi-x9"
  );
  // Exact enabled id.
  assert.equal(
    await resolveCesiumSpawnModelId({
      requested: "openai/gpt-5.1",
      defaultModelId: "techlit/unit-kimi-x9",
    }),
    "openai/gpt-5.1"
  );
  // Bare model name resolves when unambiguous.
  assert.equal(
    await resolveCesiumSpawnModelId({
      requested: "unit-kimi-x9",
      defaultModelId: "openai/gpt-5.1",
    }),
    "techlit/unit-kimi-x9"
  );
  // Disabled models are rejected with the enabled roster in the message.
  await assert.rejects(
    resolveCesiumSpawnModelId({
      requested: "acme/shared-model",
      defaultModelId: "techlit/unit-kimi-x9",
    }),
    /not available for subagents[\s\S]*Model access/
  );
  // Unknown models are rejected too.
  await assert.rejects(
    resolveCesiumSpawnModelId({
      requested: "nonexistent/model",
      defaultModelId: "techlit/unit-kimi-x9",
    }),
    /not available for subagents/
  );
});

test("resolveCesiumSpawnModelId flags ambiguous bare names", async () => {
  // Re-enable both shared-model rows so the suffix is genuinely ambiguous.
  await patchCesiumAgentSettings({
    modelAccess: {
      entries: {
        "acme/shared-model": null,
        "openai/shared-model": null,
      },
    },
  });
  await assert.rejects(
    resolveCesiumSpawnModelId({
      requested: "shared-model",
      defaultModelId: "techlit/unit-kimi-x9",
    }),
    /ambiguous/
  );
});

test("composer catalog lists only providers with a usable credential", async () => {
  // No stored/env/OAuth credential yet: nothing from models.dev is runnable,
  // so the picker must not advertise it (the roster/settings catalog still can).
  for (const env of ["OPENAI_API_KEY", "CESIUM_BASE_URL", "CESIUM_API_KEY"]) {
    delete process.env[env];
  }
  await patchCesiumAgentSettings({
    defaultModelId: "techlit/unit-kimi-x9",
    customProviders: [
      {
        id: "local-box",
        name: "Local Box",
        apiKind: "openai-compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
        models: [{ id: "tiny", name: "Tiny" }],
      },
    ],
  });

  const before = await listCredentialedCesiumProviderIds();
  assert.ok(before.has("local-box"), "custom providers are always considered configured");
  assert.ok(!before.has("openai"));
  assert.ok(!before.has("acme"));

  const modelIds = (options: Awaited<ReturnType<typeof createCesiumAgentConfigOptions>>) =>
    options.find((option) => option.id === "model")?.options.map((option) => option.value) ?? [];

  const initial = modelIds(await createCesiumAgentConfigOptions());
  assert.ok(initial.includes("local-box/tiny"), "custom provider models stay listed");
  assert.ok(initial.includes("techlit/unit-kimi-x9"), "the active default always stays listed");
  assert.ok(!initial.includes("openai/gpt-5.1"), "no key for openai -> hidden from the picker");
  assert.ok(!initial.includes("acme/shared-model"), "no key for acme -> hidden from the picker");

  await upsertCesiumProviderKey({
    providerId: "openai",
    apiKind: "openai-responses",
    apiKey: "sk-test-composer-catalog-key",
  });
  const after = await listCredentialedCesiumProviderIds();
  assert.ok(after.has("openai"));
  assert.ok(after.has("custom-openai"), "stored keys also satisfy the custom- alias lookup");

  const withKey = modelIds(await createCesiumAgentConfigOptions());
  assert.ok(withKey.includes("openai/gpt-5.1"));
  assert.ok(!withKey.includes("acme/shared-model"), "unrelated providers stay hidden");

  // Env keys count too, without any stored key.
  process.env.OPENROUTER_API_KEY = "sk-or-v1-unit";
  try {
    assert.ok((await listCredentialedCesiumProviderIds()).has("openrouter"));
  } finally {
    delete process.env.OPENROUTER_API_KEY;
  }
});
