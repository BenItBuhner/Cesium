import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  APP_SETTINGS_MIGRATION_KEY,
  APP_SETTINGS_STORAGE_KEY,
  hasCompletedAppSettingsMigration,
  hasStoredAppSettings,
  markAppSettingsMigrationComplete,
  mergeEngineOwnedSettings,
  readLegacyDefaultServerId,
  readStoredAppSettings,
  serializeAppSettings,
  stripEngineOwnedSettings,
  writeStoredAppSettings,
} from "../packages/client/src/app-settings.ts";
import {
  createDefaultGlobalSettings,
  type GlobalSettingsState,
  type RememberedAgentPermissionRule,
} from "../packages/client/src/global-settings.ts";
import {
  applyPersonalizationPayload,
  collectPersonalizationPayload,
} from "../src/lib/cloud/personalization.ts";

/**
 * Client-first app settings: the client store is the source of truth for
 * personalization; engine-owned fields (model toggles, remembered permission
 * rules, engine-enforced flags) must never leak into local persistence or the
 * cloud payload.
 */

class MemoryStorage {
  private readonly data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key) ?? null : null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }
}

function installMockWindow() {
  const storage = new MemoryStorage();
  const mockWindow = {
    localStorage: storage,
    dispatchEvent() {
      return true;
    },
    location: {
      protocol: "http:",
      hostname: "localhost",
      host: "localhost:3000",
      origin: "http://localhost:3000",
      search: "",
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: mockWindow,
  });
  return mockWindow;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

function rememberedRule(id: string): RememberedAgentPermissionRule {
  return {
    id,
    workspaceId: "ws-1",
    backendId: "cesium-agent",
    toolKey: "terminal:run",
    toolLabel: "Run command",
    decision: "allow",
    optionId: "allow_always",
    optionKind: "allow_always",
    createdAt: 1,
    updatedAt: 2,
  };
}

function customizedSettings(): GlobalSettingsState {
  const settings = createDefaultGlobalSettings();
  return {
    ...settings,
    general: {
      ...settings.general,
      doNotDisturb: true,
      workspaceSortMode: "alphabetical",
    },
    agents: {
      ...settings.agents,
      submitCtrlEnter: true,
      branchPrefix: "feature/",
      rememberedPermissions: [rememberedRule("rule-1")],
      autoAcceptAllAgentPermissions: true,
      mcpProt: true,
    },
    models: {
      byBackend: {
        "cesium-agent": [{ id: "kimi-k3", name: "Kimi K3", on: false, backendId: "cesium-agent" }],
      },
    },
  };
}

describe("engine-owned settings split", () => {
  test("stripEngineOwnedSettings resets engine fields and keeps client preferences", () => {
    const stripped = stripEngineOwnedSettings(customizedSettings());
    // Client-owned preferences survive.
    assert.equal(stripped.general.doNotDisturb, true);
    assert.equal(stripped.general.workspaceSortMode, "alphabetical");
    assert.equal(stripped.agents.submitCtrlEnter, true);
    assert.equal(stripped.agents.branchPrefix, "feature/");
    // Engine-owned state is reset to defaults.
    assert.deepEqual(stripped.agents.rememberedPermissions, []);
    assert.equal(stripped.agents.autoAcceptAllAgentPermissions, false);
    assert.equal(stripped.agents.mcpProt, false);
    assert.deepEqual(stripped.models.byBackend, {});
  });

  test("mergeEngineOwnedSettings overlays only engine fields", () => {
    const base = stripEngineOwnedSettings(customizedSettings());
    const engine = customizedSettings();
    const merged = mergeEngineOwnedSettings(base, engine);
    assert.equal(merged.agents.rememberedPermissions.length, 1);
    assert.equal(merged.agents.autoAcceptAllAgentPermissions, true);
    assert.equal(merged.agents.mcpProt, true);
    assert.equal(merged.models.byBackend["cesium-agent"]?.[0]?.on, false);
    // Client fields come from base, untouched.
    assert.equal(merged.general.doNotDisturb, true);
    assert.equal(merged.agents.branchPrefix, "feature/");
  });
});

describe("client-first settings store", () => {
  test("write/read round-trip strips engine-owned state from storage", () => {
    const mockWindow = installMockWindow();
    assert.equal(hasStoredAppSettings(), false);

    writeStoredAppSettings(customizedSettings());
    assert.equal(hasStoredAppSettings(), true);

    const raw = mockWindow.localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
    assert.ok(raw);
    const parsed = JSON.parse(raw) as GlobalSettingsState;
    assert.deepEqual(parsed.agents.rememberedPermissions, []);
    assert.deepEqual(parsed.models.byBackend, {});

    const restored = readStoredAppSettings();
    assert.ok(restored);
    assert.equal(restored.general.doNotDisturb, true);
    assert.equal(restored.agents.branchPrefix, "feature/");
    assert.deepEqual(restored.agents.rememberedPermissions, []);
  });

  test("readStoredAppSettings tolerates corrupt payloads", () => {
    const mockWindow = installMockWindow();
    mockWindow.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, "{nope");
    assert.equal(readStoredAppSettings(), null);
    mockWindow.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ schemaVersion: 99 }));
    const fallback = readStoredAppSettings();
    assert.ok(fallback);
    assert.equal(fallback.general.doNotDisturb, false);
  });

  test("serializeAppSettings is stable for identical client state", () => {
    const a = customizedSettings();
    const b = customizedSettings();
    assert.equal(serializeAppSettings(a), serializeAppSettings(b));
  });

  test("migration marker round-trips", () => {
    const mockWindow = installMockWindow();
    assert.equal(hasCompletedAppSettingsMigration(), false);
    markAppSettingsMigrationComplete();
    assert.equal(hasCompletedAppSettingsMigration(), true);
    assert.equal(mockWindow.localStorage.getItem(APP_SETTINGS_MIGRATION_KEY), "1");
  });

  test("readLegacyDefaultServerId reads the raw pre-refactor field", () => {
    const mockWindow = installMockWindow();
    assert.equal(readLegacyDefaultServerId(), null);
    mockWindow.localStorage.setItem(
      "opencursor.server-connections",
      JSON.stringify({
        version: 1,
        activeServerId: "local",
        defaultServerId: "prod",
        servers: [],
      })
    );
    assert.equal(readLegacyDefaultServerId(), "prod");
  });
});

describe("personalization payload v2", () => {
  test("collect includes the client-owned app settings document", () => {
    installMockWindow();
    writeStoredAppSettings(customizedSettings());

    const payload = JSON.parse(collectPersonalizationPayload()) as {
      version: number;
      appSettings: string | null;
    };
    assert.equal(payload.version, 2);
    assert.ok(payload.appSettings);
    const embedded = JSON.parse(payload.appSettings) as GlobalSettingsState;
    assert.equal(embedded.general.doNotDisturb, true);
    // Engine-owned state must never reach the cloud payload.
    assert.deepEqual(embedded.agents.rememberedPermissions, []);
    assert.deepEqual(embedded.models.byBackend, {});
  });

  test("apply writes the app settings document and reports the change", () => {
    installMockWindow();
    writeStoredAppSettings(customizedSettings());
    const payload = collectPersonalizationPayload();

    // Fresh device: nothing stored yet.
    const fresh = installMockWindow();
    assert.equal(applyPersonalizationPayload(payload), true);
    assert.ok(fresh.localStorage.getItem(APP_SETTINGS_STORAGE_KEY));
    const restored = readStoredAppSettings();
    assert.ok(restored);
    assert.equal(restored.general.doNotDisturb, true);

    // Applying the identical payload again is a no-op.
    assert.equal(applyPersonalizationPayload(payload), false);
  });

  test("v1 payloads without appSettings still apply cleanly", () => {
    const mockWindow = installMockWindow();
    const v1 = JSON.stringify({
      version: 1,
      preferences: JSON.stringify({ experimentalIpadMode: true }),
      theme: "dark",
      themeConfig: null,
    });
    assert.equal(applyPersonalizationPayload(v1), true);
    assert.equal(mockWindow.localStorage.getItem("opencursor-theme"), "dark");
    assert.equal(mockWindow.localStorage.getItem(APP_SETTINGS_STORAGE_KEY), null);
  });

  test("garbage payloads are rejected without side effects", () => {
    installMockWindow();
    assert.equal(applyPersonalizationPayload("not json"), false);
    assert.equal(applyPersonalizationPayload("42"), false);
    assert.equal(hasStoredAppSettings(), false);
  });
});
