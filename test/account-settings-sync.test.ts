import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  accountSettingsSignature,
  applyAccountSyncedSettings,
  parseAccountSettingsDocument,
  pickAccountSyncedSettings,
  resolveAccountSettingsSync,
  serializeAccountSettingsDocument,
  stableStringify,
} from "../src/lib/cloud/account-settings.ts";
import {
  createDefaultGlobalSettings,
  type GlobalSettingsState,
} from "../src/lib/global-settings.ts";

function settingsWith(patch: (base: GlobalSettingsState) => GlobalSettingsState): GlobalSettingsState {
  return patch(createDefaultGlobalSettings());
}

const themed = settingsWith((base) => ({
  ...base,
  themeConfig: { ...base.themeConfig, appearance: "dark" },
  composer: {
    ...base.composer,
    backendId: "cursor-sdk",
    mode: "plan",
    model: { id: "composer-2.5", name: "Composer 2.5", provider: "cursor", backendId: "cursor-sdk" },
    updatedAt: 10,
  },
  models: { byBackend: { "cursor-sdk": [{ id: "composer-2.5", name: "Composer 2.5", on: false }] } },
  agents: {
    ...base.agents,
    rememberedPermissions: [
      {
        id: "ws:cesium-agent:terminal:exact",
        workspaceId: "ws",
        backendId: "cesium-agent",
        toolKey: "terminal",
        toolLabel: "Terminal",
        decision: "allow",
        optionId: "allow_always",
        optionKind: "allow_always",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  },
}));

describe("account settings document", () => {
  test("stableStringify sorts keys and drops undefined", () => {
    assert.equal(stableStringify({ b: 1, a: [{ d: 2, c: undefined }] }), '{"a":[{"d":2}],"b":1}');
    assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  });

  test("engine-scoped slices never leave the device", () => {
    const synced = pickAccountSyncedSettings(themed) as Record<string, unknown>;
    assert.equal("models" in synced, false);
    assert.equal("rememberedPermissions" in (synced.agents as Record<string, unknown>), false);
    assert.equal((synced.composer as { backendId: string }).backendId, "cursor-sdk");
    assert.equal((synced.themeConfig as { appearance: string }).appearance, "dark");
  });

  test("serialize -> parse round-trips the synced projection", () => {
    const payload = serializeAccountSettingsDocument(themed);
    const parsed = parseAccountSettingsDocument(payload);
    assert.ok(parsed);
    assert.equal(stableStringify(parsed), stableStringify(pickAccountSyncedSettings(themed)));
    assert.equal(JSON.parse(payload).version, 2);
  });

  test("anything but a v2 document reads as 'no account settings'", () => {
    assert.equal(parseAccountSettingsDocument(null), null);
    assert.equal(parseAccountSettingsDocument("not json"), null);
    // The pre-account localStorage blob a stale client may still upload.
    assert.equal(
      parseAccountSettingsDocument(
        JSON.stringify({ version: 1, preferences: "{}", theme: "dark", themeConfig: null })
      ),
      null
    );
    assert.equal(parseAccountSettingsDocument(JSON.stringify({ version: 2 })), null);
  });

  test("apply overlays the account document but keeps engine-scoped slices", () => {
    const local = settingsWith((base) => ({
      ...base,
      models: themed.models,
      agents: { ...base.agents, rememberedPermissions: themed.agents.rememberedPermissions },
    }));
    const cloud = parseAccountSettingsDocument(serializeAccountSettingsDocument(themed))!;
    const applied = applyAccountSyncedSettings(local, cloud);
    assert.equal(applied.themeConfig.appearance, "dark");
    assert.equal(applied.composer.backendId, "cursor-sdk");
    assert.deepEqual(applied.models, themed.models);
    assert.equal(applied.agents.rememberedPermissions.length, 1);
    assert.equal(accountSettingsSignature(applied), stableStringify(cloud));
    // Re-applying the same document is referentially a no-op.
    assert.equal(applyAccountSyncedSettings(applied, cloud), applied);
  });
});

describe("account settings reconciliation", () => {
  const local = createDefaultGlobalSettings();
  const edited = settingsWith((base) => ({ ...base, aurora: { ...base.aurora, enabled: !base.aurora.enabled } }));
  const cloudDoc = (settings: GlobalSettingsState, updatedAt: number) => ({
    payload: serializeAccountSettingsDocument(settings),
    updatedAt,
  });
  const inSyncMarker = (settings: GlobalSettingsState, cloudUpdatedAt: number) => ({
    signature: accountSettingsSignature(settings),
    cloudUpdatedAt,
  });
  const decide = (input: Partial<Parameters<typeof resolveAccountSettingsSync>[0]>) =>
    resolveAccountSettingsSync({
      cloud: null,
      local,
      hydrated: true,
      marker: null,
      localEditsPending: false,
      localMigrationsPending: false,
      ...input,
    });

  test("waits while the cloud query is loading", () => {
    assert.deepEqual(decide({ cloud: undefined }), { action: "wait" });
  });

  test("seeds an empty account from hydrated settings only", () => {
    assert.deepEqual(decide({ cloud: null }), { action: "push" });
    assert.deepEqual(
      decide({ cloud: null, hydrated: false, localEditsPending: true }),
      { action: "noop" }
    );
  });

  test("a stale v1 blob in the cloud counts as empty and gets replaced", () => {
    assert.deepEqual(
      decide({ cloud: { payload: JSON.stringify({ version: 1, theme: "dark" }), updatedAt: 3 } }),
      { action: "push" }
    );
  });

  test("identical documents are a noop even with pending bookkeeping", () => {
    assert.deepEqual(
      decide({ cloud: cloudDoc(themed, 7), local: themed, localEditsPending: true, localMigrationsPending: true }),
      { action: "noop" }
    );
  });

  test("loading an engine's copy is not an edit: the account wins", () => {
    // Fresh engine (factory defaults) hydrated on a device whose account has a theme.
    assert.equal(decide({ cloud: cloudDoc(themed, 7) }).action, "apply");
    // Same when the account changed since this device last synced.
    assert.equal(
      decide({ cloud: cloudDoc(themed, 9), marker: inSyncMarker(local, 7) }).action,
      "apply"
    );
  });

  test("a fresh device applies the account before it connects an engine", () => {
    assert.equal(decide({ cloud: cloudDoc(themed, 7), hydrated: false }).action, "apply");
  });

  test("explicit local edits always push, whether or not the account moved", () => {
    assert.deepEqual(
      decide({ cloud: cloudDoc(local, 7), local: edited, marker: inSyncMarker(local, 7), localEditsPending: true }),
      { action: "push" }
    );
    // Another device wrote in the meantime: this device's pick still lands
    // (and that device then follows it) instead of being silently dropped.
    assert.deepEqual(
      decide({ cloud: cloudDoc(themed, 20), local: edited, marker: inSyncMarker(local, 7), localEditsPending: true }),
      { action: "push" }
    );
  });

  test("migrations push only while the account did not move", () => {
    assert.deepEqual(
      decide({ cloud: cloudDoc(local, 7), local: edited, marker: inSyncMarker(local, 7), localMigrationsPending: true }),
      { action: "push" }
    );
    // The account changed since the last reconciliation: the account wins and
    // the device's legacy fold is dropped.
    assert.equal(
      decide({ cloud: cloudDoc(themed, 20), local: edited, marker: inSyncMarker(local, 7), localMigrationsPending: true }).action,
      "apply"
    );
    // No marker at all (first reconciliation on this device): same outcome.
    assert.equal(
      decide({ cloud: cloudDoc(themed, 20), local: edited, localMigrationsPending: true }).action,
      "apply"
    );
  });

  test("unhydrated local edits never overwrite the account", () => {
    assert.equal(
      decide({
        cloud: cloudDoc(themed, 7),
        local: edited,
        hydrated: false,
        marker: inSyncMarker(local, 7),
        localEditsPending: true,
        localMigrationsPending: true,
      }).action,
      "apply"
    );
  });
});
