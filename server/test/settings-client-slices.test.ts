import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-settings-client-slices-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const [{ settingsRoutes }, store] = await Promise.all([
  import("../src/routes/settings.js"),
  import("../src/lib/global-settings-store.js"),
]);

after(async () => {
  const fs = await import("node:fs/promises");
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

async function putSettings(settings: unknown): Promise<void> {
  const response = await settingsRoutes.request("/api/settings/global", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings }),
  });
  assert.equal(response.status, 200);
}

/**
 * Regression: the engine rebuilt a fixed shape on every read, so client-owned
 * top-level slices it did not enumerate (`aurora` first, then the account-wide
 * composer defaults) were dropped on the next GET and every device saw the
 * user's choices revert.
 */
test("client-owned top-level slices survive a save/read round-trip", async () => {
  const settings = await store.getGlobalSettings();
  const aurora = { enabled: true, intensity: 0.8, speed: 2, palette: "nebula" };
  const composer = {
    backendId: "cesium-agent",
    mode: "plan",
    model: { id: "techlit/kimi-k3", name: "Kimi K3", backendId: "cesium-agent" },
    lastModelByBackend: {
      "cesium-agent": { id: "techlit/kimi-k3", name: "Kimi K3", backendId: "cesium-agent" },
    },
    profileId: "work",
    statusBarVisibility: { repo: false, branch: true, goal: true, context: false },
    pillsVisibility: { attach: true, web: false },
  };
  await putSettings({ ...settings, aurora, composer });

  const persisted = await store.getGlobalSettings();
  assert.deepEqual(persisted.aurora, aurora);
  assert.deepEqual(persisted.composer, composer);
  assert.equal(persisted.schemaVersion, 1);
});

test("themeConfig keeps round-tripping alongside the new slices", async () => {
  const settings = await store.getGlobalSettings();
  const themeConfig = {
    appearance: "dark",
    lightThemeId: "default",
    darkThemeId: "oled",
    customThemes: [],
  };
  await putSettings({ ...settings, themeConfig });

  const persisted = await store.getGlobalSettings();
  assert.deepEqual(persisted.themeConfig, themeConfig);
});

test("non-object top-level junk is not persisted as a client slice", async () => {
  const settings = await store.getGlobalSettings();
  await putSettings({ ...settings, bogusScalar: "nope", bogusList: [1, 2, 3] });

  const persisted = (await store.getGlobalSettings()) as Record<string, unknown>;
  assert.equal("bogusScalar" in persisted, false);
  assert.equal("bogusList" in persisted, false);
});

test("engine-owned slices are still normalized, not passed through raw", async () => {
  const settings = await store.getGlobalSettings();
  await putSettings({
    ...settings,
    general: { ...settings.general, workspaceSortMode: "not-a-real-mode" },
  });

  const persisted = await store.getGlobalSettings();
  assert.equal(persisted.general.workspaceSortMode, "recent");
});
