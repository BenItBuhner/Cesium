import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-settings-agent-rail-${Date.now()}-${Math.random()
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

/**
 * Regression: the server used to keep a drifted copy of the agent rail
 * settings schema, so PUT /api/settings/global silently stripped
 * `rowDetail` / `sectionOrder` / `hiddenSections`, reset `groupBy` values it
 * did not know ("priority", and it rewrote "server" to "workspace"), and
 * dropped the "machine" workspace sort. The client then refetched and the
 * user's choices evaporated.
 */
test("agent rail view settings survive a save/read round-trip", async () => {
  const settings = await store.getGlobalSettings();
  settings.general.workspaceSortMode = "machine";
  settings.general.agentRail = {
    ...settings.general.agentRail,
    groupBy: "priority",
    rowDetail: "expanded",
    sectionOrder: ["pinned", "attention", "chats", "workspaces"],
    hiddenSections: ["chats"],
  };

  const response = await settingsRoutes.request("/api/settings/global", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings }),
  });
  assert.equal(response.status, 200);

  const persisted = await store.getGlobalSettings();
  assert.equal(persisted.general.workspaceSortMode, "machine");
  assert.equal(persisted.general.agentRail.groupBy, "priority");
  assert.equal(persisted.general.agentRail.rowDetail, "expanded");
  // Persisted orders missing the running section surface it in its default
  // slot, right below Needs attention.
  assert.deepEqual(persisted.general.agentRail.sectionOrder, [
    "attention",
    "running",
    "pinned",
    "chats",
    "workspaces",
  ]);
  assert.deepEqual(persisted.general.agentRail.hiddenSections, ["chats"]);
});

test("every grouping mode survives the save round-trip", async () => {
  for (const mode of [
    "workspace",
    "repository",
    "updated",
    "status",
    "server",
    "priority",
  ] as const) {
    const settings = await store.getGlobalSettings();
    settings.general.agentRail = {
      ...settings.general.agentRail,
      groupBy: mode,
    };

    const response = await settingsRoutes.request("/api/settings/global", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
    });
    assert.equal(response.status, 200);

    const persisted = await store.getGlobalSettings();
    assert.equal(persisted.general.agentRail.groupBy, mode);
  }
});

test("order-by and show flags survive the save round-trip", async () => {
  const settings = await store.getGlobalSettings();
  settings.general.agentRail = {
    ...settings.general.agentRail,
    orderBy: "status",
    showEnvironment: false,
    showBranch: true,
    showMachine: false,
    showWorkspace: false,
  };

  const response = await settingsRoutes.request("/api/settings/global", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings }),
  });
  assert.equal(response.status, 200);

  const persisted = await store.getGlobalSettings();
  assert.equal(persisted.general.agentRail.orderBy, "status");
  assert.equal(persisted.general.agentRail.showEnvironment, false);
  assert.equal(persisted.general.agentRail.showBranch, true);
  assert.equal(persisted.general.agentRail.showMachine, false);
  assert.equal(persisted.general.agentRail.showWorkspace, false);
});

test("legacy persisted agent rail settings gain migrated defaults", async () => {
  const settings = await store.getGlobalSettings();
  const legacyRail = {
    groupBy: "priority",
    visibleStatusFilters: [],
    visibleServerIds: [],
    hiddenServerIds: [],
    showIcons: true,
    // Pre-release name for balanced; no sectionOrder at all.
    rowDetail: "auto",
  };
  const response = await settingsRoutes.request("/api/settings/global", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      settings: {
        ...settings,
        general: { ...settings.general, agentRail: legacyRail },
      },
    }),
  });
  assert.equal(response.status, 200);

  const persisted = await store.getGlobalSettings();
  assert.equal(persisted.general.agentRail.rowDetail, "balanced");
  assert.deepEqual(persisted.general.agentRail.sectionOrder, [
    "attention",
    "running",
    "pinned",
    "chats",
    "workspaces",
  ]);
  // New knobs gain their defaults on legacy payloads.
  assert.equal(persisted.general.agentRail.orderBy, "updated");
  assert.equal(persisted.general.agentRail.showEnvironment, true);
  assert.equal(persisted.general.agentRail.showBranch, false);
});
