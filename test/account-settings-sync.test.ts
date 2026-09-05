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
  const cloudDoc = (settings: GlobalSettingsState, updatedAt: number) => ({
    payload: serializeAccountSettingsDocument(settings),
    updatedAt,
  });
  const inSyncMarker = (settings: GlobalSettingsState, cloudUpdatedAt: number) => ({
    signature: accountSettingsSignature(settings),
    cloudUpdatedAt,
  });

  test("waits while the cloud query is loading", () => {
    assert.deepEqual(
      resolveAccountSettingsSync({
        cloud: undefined,
        local,
        hydrated: true,
        marker: null,
        localEditsPending: false,
        localDirtySince: null,
      }),
      { action: "wait" }
    );
  });

  test("seeds an empty account from hydrated settings only", () => {
    assert.deepEqual(
      resolveAccountSettingsSync({
        cloud: null,
        local,
        hydrated: true,
        marker: null,
        localEditsPending: false,
        localDirtySince: null,
      }),
      { action: "push" }
    );
    assert.deepEqual(
      resolveAccountSettingsSync({
        cloud: null,
        local,
        hydrated: false,
        marker: null,
        localEditsPending: true,
        localDirtySince: 5,
      }),
      { action: "noop" }
    );
  });

  test("a stale v1 blob in the cloud counts as empty and gets replaced", () => {
    assert.deepEqual(
      resolveAccountSettingsSync({
        cloud: { payload: JSON.stringify({ version: 1, theme: "dark" }), updatedAt: 3 },
        local,
        hydrated: true,
        marker: null,
        localEditsPending: false,
        localDirtySince: null,
      }),
      { action: "push" }
    );
  });

  test("identical documents are a noop", () => {
    assert.deepEqual(
      resolveAccountSettingsSync({
        cloud: cloudDoc(themed, 7),
        local: themed,
        hydrated: true,
        marker: null,
        localEditsPending: true,
        localDirtySince: 1,
      }),
      { action: "noop" }
    );
  });

  test("loading an engine's copy is not an edit: the account wins", () => {
    // Fresh engine (factory defaults) hydrated on a device whose account has a theme.
    const decision = resolveAccountSettingsSync({
      cloud: cloudDoc(themed, 7),
      local,
      hydrated: true,
      marker: null,
      localEditsPending: false,
      localDirtySince: null,
    });
    assert.equal(decision.action, "apply");
    // Same when the account changed since this device last synced.
    const stale = resolveAccountSettingsSync({
      cloud: cloudDoc(themed, 9),
      local,
      hydrated: true,
      marker: inSyncMarker(local, 7),
      localEditsPending: false,
      localDirtySince: null,
    });
    assert.equal(stale.action, "apply");
  });

  test("a fresh device applies the account before it connects an engine", () => {
    const decision = resolveAccountSettingsSync({
      cloud: cloudDoc(themed, 7),
      local,
      hydrated: false,
      marker: null,
      localEditsPending: false,
      localDirtySince: null,
    });
    assert.equal(decision.action, "apply");
  });

  test("local edits push when the account did not move since the last sync", () => {
    const edited = settingsWith((base) => ({ ...base, aurora: { ...base.aurora, enabled: !base.aurora.enabled } }));
    assert.deepEqual(
      resolveAccountSettingsSync({
        cloud: cloudDoc(local, 7),
        local: edited,
        hydrated: true,
        marker: inSyncMarker(local, 7),
        localEditsPending: true,
        localDirtySince: 8,
      }),
      { action: "push" }
    );
  });

  test("conflicts resolve to the last writer", () => {
    const edited = settingsWith((base) => ({ ...base, aurora: { ...base.aurora, enabled: !base.aurora.enabled } }));
    // Account changed at 20, local edit started at 15 -> account wins.
    assert.equal(
      resolveAccountSettingsSync({
        cloud: cloudDoc(themed, 20),
        local: edited,
        hydrated: true,
        marker: inSyncMarker(local, 7),
        localEditsPending: true,
        localDirtySince: 15,
      }).action,
      "apply"
    );
    // Local edit started at 25 -> local wins.
    assert.equal(
      resolveAccountSettingsSync({
        cloud: cloudDoc(themed, 20),
        local: edited,
        hydrated: true,
        marker: inSyncMarker(local, 7),
        localEditsPending: true,
        localDirtySince: 25,
      }).action,
      "push"
    );
  });

  test("unhydrated local edits never overwrite the account", () => {
    const edited = settingsWith((base) => ({ ...base, aurora: { ...base.aurora, enabled: !base.aurora.enabled } }));
    assert.equal(
      resolveAccountSettingsSync({
        cloud: cloudDoc(themed, 7),
        local: edited,
        hydrated: false,
        marker: inSyncMarker(local, 7),
        localEditsPending: true,
        localDirtySince: 99,
      }).action,
      "apply"
    );
  });
});
