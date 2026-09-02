import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  createDefaultGlobalSettings,
  createMemoryKeyValueStore,
  globalSettingsCacheStorageKey,
  readCachedGlobalSettings,
  setClientPlatform,
  writeCachedGlobalSettings,
  type ClientPlatform,
  type GlobalSettingsState,
  type KeyValueStore,
} from "@cesium/client";

function installMemoryPlatform(): KeyValueStore {
  const store = createMemoryKeyValueStore();
  const platform: ClientPlatform = {
    keyValueStore: store,
    getLocation: () => null,
    getRuntimeConfiguredServerBaseUrl: () => null,
    emitEvent: () => undefined,
    addEventListener: () => () => undefined,
    prefersDarkColorScheme: () => false,
  };
  setClientPlatform(platform);
  return store;
}

function customizedSettings(): GlobalSettingsState {
  const base = createDefaultGlobalSettings();
  return {
    ...base,
    general: {
      ...base.general,
      newChatWidgets: {
        order: ["recent-chats", "shortcuts", "actions", "recent-activity"],
        hidden: ["recent-activity"],
      },
      agentRail: {
        ...base.general.agentRail,
        groupBy: "priority",
        rowDetail: "compact",
      },
    },
  };
}

describe("global settings local cache", () => {
  let store: KeyValueStore;

  beforeEach(() => {
    store = installMemoryPlatform();
  });

  test("round-trips customized settings per settings server", () => {
    const custom = customizedSettings();
    writeCachedGlobalSettings("server-a", custom);

    const restored = readCachedGlobalSettings("server-a");
    assert.ok(restored, "expected a cached blob for server-a");
    assert.deepEqual(restored.general.newChatWidgets, {
      order: ["recent-chats", "shortcuts", "actions", "recent-activity"],
      hidden: ["recent-activity"],
    });
    assert.equal(restored.general.agentRail.groupBy, "priority");
    assert.equal(restored.general.agentRail.rowDetail, "compact");
  });

  test("cache entries are isolated by settings server id", () => {
    writeCachedGlobalSettings("server-a", customizedSettings());
    assert.equal(readCachedGlobalSettings("server-b"), null);
  });

  test("missing entry reads as null, never defaults", () => {
    assert.equal(readCachedGlobalSettings("server-a"), null);
  });

  test("corrupt JSON reads as null instead of throwing or wiping", () => {
    store.setItem(globalSettingsCacheStorageKey("server-a"), "{not json");
    assert.equal(readCachedGlobalSettings("server-a"), null);
  });

  test("non-object payloads read as null", () => {
    store.setItem(globalSettingsCacheStorageKey("server-a"), JSON.stringify(42));
    assert.equal(readCachedGlobalSettings("server-a"), null);
  });

  test("unknown schema versions read as null so stale caches cannot seed", () => {
    store.setItem(
      globalSettingsCacheStorageKey("server-a"),
      JSON.stringify({ ...customizedSettings(), schemaVersion: 2 })
    );
    assert.equal(readCachedGlobalSettings("server-a"), null);
  });

  test("cached blobs are normalized on read (bad widget ids dropped)", () => {
    const base = createDefaultGlobalSettings();
    store.setItem(
      globalSettingsCacheStorageKey("server-a"),
      JSON.stringify({
        ...base,
        general: {
          ...base.general,
          newChatWidgets: {
            order: ["actions", "actions", "bogus", "recent-chats"],
            hidden: ["bogus", "shortcuts"],
          },
        },
      })
    );
    const restored = readCachedGlobalSettings("server-a");
    assert.ok(restored);
    assert.deepEqual(restored.general.newChatWidgets, {
      order: ["actions", "recent-chats", "shortcuts", "recent-activity"],
      hidden: ["shortcuts"],
    });
  });

  test("empty server id is a no-op for both read and write", () => {
    writeCachedGlobalSettings("", customizedSettings());
    assert.equal(store.getItem(globalSettingsCacheStorageKey("")), null);
    assert.equal(readCachedGlobalSettings(""), null);
  });
});
