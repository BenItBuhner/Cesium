import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-settings-models-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const [{ settingsRoutes }, store, { writeAgentBackendConfigCache }] = await Promise.all([
  import("../src/routes/settings.js"),
  import("../src/lib/global-settings-store.js"),
  import("../src/lib/agents/provider-cache-store.js"),
]);

after(async () => {
  const fs = await import("node:fs/promises");
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

test("model toggle saves survive later stale full global settings PUT", async () => {
  await writeAgentBackendConfigCache("cursor-sdk", [
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "model-a",
      options: [
        { value: "model-a", name: "Model A" },
        { value: "model-b", name: "Model B" },
      ],
    },
  ]);

  await store.setModelToggles([
    { backendId: "cursor-sdk", modelId: "model-a", on: false },
  ]);

  const staleGlobal = await store.getGlobalSettings();
  staleGlobal.models = {
    byBackend: {
      "cursor-sdk": [
        { backendId: "cursor-sdk", id: "model-a", name: "Model A", on: true },
        { backendId: "cursor-sdk", id: "model-b", name: "Model B", on: true },
      ],
    },
  };

  const response = await settingsRoutes.request("/api/settings/global", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings: staleGlobal }),
  });
  assert.equal(response.status, 200);

  const toggles = await store.getModelToggleState(["cursor-sdk"]);
  const modelA = toggles.byBackend["cursor-sdk"]?.find((model) => model.id === "model-a");
  assert.equal(modelA?.on, false);
});
