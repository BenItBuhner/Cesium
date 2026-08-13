import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CLIENT_SETTINGS_STORAGE_KEY,
  USER_PREFERENCES_STORAGE_KEY,
  clientKeyValueStore,
  createDefaultGlobalSettings,
  serializeClientSettingsPayload,
} from "../packages/client/src/index.ts";
import {
  applyPersonalizationPayload,
  collectPersonalizationPayload,
} from "../src/lib/cloud/personalization.ts";

describe("cloud personalization v2", () => {
  test("collects and applies client-owned settings", () => {
    const store = clientKeyValueStore();
    const settings = {
      ...createDefaultGlobalSettings(),
      general: { ...createDefaultGlobalSettings().general, doNotDisturb: true },
    };
    store.setItem(CLIENT_SETTINGS_STORAGE_KEY, serializeClientSettingsPayload(settings));
    const payload = collectPersonalizationPayload();
    const parsed = JSON.parse(payload) as { version: number; clientSettings: string | null };
    assert.equal(parsed.version, 2);
    assert.ok(parsed.clientSettings);

    store.removeItem(CLIENT_SETTINGS_STORAGE_KEY);
    assert.equal(applyPersonalizationPayload(payload), true);
    const restored = store.getItem(CLIENT_SETTINGS_STORAGE_KEY);
    assert.ok(restored);
    assert.equal(JSON.parse(restored).general.doNotDisturb, true);
  });

  test("v1 payloads without clientSettings still apply theme prefs", () => {
    const store = clientKeyValueStore();
    const changed = applyPersonalizationPayload(
      JSON.stringify({
        version: 1,
        preferences: JSON.stringify({ experimentalIpadMode: false }),
        theme: "dark",
        themeConfig: null,
      })
    );
    assert.equal(changed, true);
    assert.equal(
      store.getItem(USER_PREFERENCES_STORAGE_KEY),
      JSON.stringify({ experimentalIpadMode: false })
    );
  });
});
