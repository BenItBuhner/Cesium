import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  clientSettingsHavePersonalization,
  mergeEngineBoundSettings,
  parseClientSettingsPayload,
  serializeClientSettingsPayload,
  stripEngineBoundSettings,
} from "../packages/client/src/client-settings.ts";
import {
  createDefaultGlobalSettings,
  normalizeLoadedGlobalSettings,
} from "../packages/client/src/global-settings.ts";

describe("client-owned settings", () => {
  test("stripEngineBoundSettings drops models and remembered permissions", () => {
    const base = createDefaultGlobalSettings();
    const dirty = {
      ...base,
      models: { byBackend: { cesium: [{ id: "kimi-k3", name: "kimi-k3", on: true }] } },
      agents: {
        ...base.agents,
        rememberedPermissions: [
          {
            id: "perm-1",
            workspaceId: "ws",
            backendId: "cesium",
            toolKey: "editFile",
            toolLabel: "Edit",
            decision: "allow" as const,
            optionId: "allow",
            optionKind: "allow_always" as const,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        autoAcceptAllAgentPermissions: true,
        submitCtrlEnter: true,
      },
      general: { ...base.general, doNotDisturb: true },
    };
    const stripped = stripEngineBoundSettings(dirty);
    assert.deepEqual(stripped.models, createDefaultGlobalSettings().models);
    assert.equal(stripped.agents.rememberedPermissions.length, 0);
    assert.equal(stripped.agents.autoAcceptAllAgentPermissions, false);
    assert.equal(stripped.agents.submitCtrlEnter, true);
    assert.equal(stripped.general.doNotDisturb, true);
  });

  test("mergeEngineBoundSettings keeps client personalization", () => {
    const client = {
      ...createDefaultGlobalSettings(),
      general: { ...createDefaultGlobalSettings().general, showVoiceOrb: true },
    };
    const engine = {
      ...createDefaultGlobalSettings(),
      models: { byBackend: { cesium: [{ id: "kimi-k3", name: "kimi-k3", on: true }] } },
      general: { ...createDefaultGlobalSettings().general, showVoiceOrb: false },
    };
    const merged = mergeEngineBoundSettings(client, engine);
    assert.equal(merged.general.showVoiceOrb, true);
    assert.equal(merged.models.byBackend.cesium?.[0]?.id, "kimi-k3");
  });

  test("round-trips a personalization payload without engine slices", () => {
    const settings = normalizeLoadedGlobalSettings({
      ...createDefaultGlobalSettings(),
      general: { ...createDefaultGlobalSettings().general, sideColumnsSwapped: true },
    });
    const raw = serializeClientSettingsPayload(settings);
    const parsed = parseClientSettingsPayload(raw);
    assert.ok(parsed);
    assert.equal(parsed?.general.sideColumnsSwapped, true);
    assert.equal(parsed?.models.byBackend.cesium, undefined);
    assert.equal(clientSettingsHavePersonalization(parsed!), true);
    assert.equal(clientSettingsHavePersonalization(createDefaultGlobalSettings()), false);
  });
});
