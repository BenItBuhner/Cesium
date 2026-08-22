import assert from "node:assert/strict";
import test from "node:test";

import {
  CESIUM_MODEL_DESCRIPTION_MAX_LENGTH,
  selectAccessControlledModels,
  summarizeCesiumModelAccess,
} from "../src/components/editor/settings/CesiumModelAccessSection";
import type { CesiumModelCatalogEntry } from "../src/lib/server-api";

const catalog: CesiumModelCatalogEntry[] = [
  {
    providerId: "techlit",
    providerName: "TechLit",
    modelId: "techlit/kimi-k3",
    modelName: "Kimi K3",
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
    modelName: "GPT-5.1",
    apiKind: "openai-responses",
    supportsTools: true,
    supportsReasoning: true,
    supportsStructuredOutput: true,
    supportsImages: true,
    contextWindow: 400_000,
  },
  {
    providerId: "acme",
    providerName: "Acme",
    modelId: "acme/no-tools",
    modelName: "No Tools",
    apiKind: "openai-compatible",
    supportsTools: false,
    supportsReasoning: false,
    supportsStructuredOutput: false,
    supportsImages: false,
    contextWindow: 8_000,
  },
];

test("model access UI only governs tool-capable models", () => {
  const models = selectAccessControlledModels(catalog);
  assert.deepEqual(
    models.map((model) => model.modelId),
    ["techlit/kimi-k3", "openai/gpt-5.1"]
  );
});

test("summarizeCesiumModelAccess counts enabled and described models", () => {
  const empty = summarizeCesiumModelAccess(catalog, {});
  assert.deepEqual(empty, { total: 2, enabled: 2, described: 0 });

  const filtered = summarizeCesiumModelAccess(catalog, {
    "openai/gpt-5.1": { enabled: false },
    "techlit/kimi-k3": { enabled: true, description: "fast multimodal default" },
    "acme/no-tools": { enabled: false }, // tool-less models never count
  });
  assert.deepEqual(filtered, { total: 2, enabled: 1, described: 1 });
});

test("description cap mirrors the server contract", () => {
  assert.equal(CESIUM_MODEL_DESCRIPTION_MAX_LENGTH, 250);
});
