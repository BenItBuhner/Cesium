import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createDefaultGlobalSettings,
  normalizeLoadedGlobalSettings,
} from "../src/lib/global-settings.ts";

describe("global settings", () => {
  test("stream event batching is enabled by default", () => {
    const settings = createDefaultGlobalSettings();
    assert.equal(settings.general.batchStreamEvents, true);
  });

  test("normalizes missing stream event batching to the enabled default", () => {
    const base = createDefaultGlobalSettings();
    const { batchStreamEvents: _ignored, ...generalWithoutBatching } = base.general;
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: generalWithoutBatching,
    });
    assert.equal(settings.general.batchStreamEvents, true);
  });

  test("preserves an explicit disabled stream event batching setting", () => {
    const base = createDefaultGlobalSettings();
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        batchStreamEvents: false,
      },
    });
    assert.equal(settings.general.batchStreamEvents, false);
  });

  test("voice orb is opt-in (hidden by default)", () => {
    const settings = createDefaultGlobalSettings();
    assert.equal(settings.general.showVoiceOrb, false);
  });

  test("normalizes missing showVoiceOrb to opt-in default", () => {
    const base = createDefaultGlobalSettings();
    const { showVoiceOrb: _ignored, ...generalWithoutOrb } = base.general;
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: generalWithoutOrb,
    });
    assert.equal(settings.general.showVoiceOrb, false);
  });

  test("preserves explicit showVoiceOrb true", () => {
    const base = createDefaultGlobalSettings();
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        showVoiceOrb: true,
      },
    });
    assert.equal(settings.general.showVoiceOrb, true);
  });

  test("defaults workspace rail appearances to empty map", () => {
    const settings = createDefaultGlobalSettings();
    assert.deepEqual(settings.general.workspaceRailAppearances, {});
  });

  test("normalizes workspace rail appearances by server-scoped workspace key", () => {
    const base = createDefaultGlobalSettings();
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        workspaceRailAppearances: {
          "server-a:ws-1": { icon: "Rocket", color: "#2563eb" },
          "": { icon: "Bad", color: "nope" },
        },
      },
    });
    assert.deepEqual(settings.general.workspaceRailAppearances, {
      "server-a:ws-1": { icon: "Rocket", color: "#2563eb" },
    });
  });

  test("defaults agent rail grouping settings", () => {
    const settings = createDefaultGlobalSettings();
    assert.deepEqual(settings.general.agentRail, {
      groupBy: "workspace",
      visibleStatusFilters: [],
      visibleServerIds: [],
      hiddenServerIds: [],
      showIcons: true,
      rowDetail: "balanced",
      sectionOrder: ["attention", "pinned", "chats", "workspaces"],
      hiddenSections: [],
    });
  });

  test("preserves priority group-by", () => {
    const base = createDefaultGlobalSettings();
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        agentRail: {
          ...base.general.agentRail,
          groupBy: "priority",
        },
      },
    });
    assert.equal(settings.general.agentRail.groupBy, "priority");
  });

  test("preserves machine group-by", () => {
    const base = createDefaultGlobalSettings();
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        agentRail: {
          ...base.general.agentRail,
          groupBy: "server",
        },
      },
    });
    assert.equal(settings.general.agentRail.groupBy, "server");
  });

  test("drops retired harness ids from model toggle settings", () => {
    const base = createDefaultGlobalSettings();
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      models: {
        byBackend: {
          "cursor-sdk": [{ id: "composer-2.5", name: "Composer 2.5", on: true }],
          "cursor-acp": [{ id: "auto", name: "Auto", on: true }],
          "codex-adapter": [{ id: "gpt-5", name: "GPT-5", on: true }],
          "opencode-acp": [{ id: "auto", name: "Auto", on: true }],
          "gemini-acp": [{ id: "auto", name: "Auto", on: true }],
        },
      },
    });
    assert.equal(settings.models.byBackend["cursor-sdk"]?.length, 1);
    assert.equal(settings.models.byBackend["cursor-acp"], undefined);
    assert.equal(settings.models.byBackend["codex-adapter"], undefined);
    assert.equal(settings.models.byBackend["opencode-acp"], undefined);
    assert.equal(settings.models.byBackend["gemini-acp"], undefined);
  });

  test("normalizes agent rail grouping settings", () => {
    const base = createDefaultGlobalSettings();
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        agentRail: {
          groupBy: "repository",
          visibleStatusFilters: ["running"],
          visibleServerIds: ["server-a"],
          hiddenServerIds: ["server-b"],
          showIcons: "bad",
        },
      },
    });

    assert.deepEqual(settings.general.agentRail, {
      groupBy: "repository",
      visibleStatusFilters: ["running"],
      visibleServerIds: [],
      hiddenServerIds: ["server-b"],
      showIcons: true,
      rowDetail: "balanced",
      sectionOrder: ["attention", "pinned", "chats", "workspaces"],
      hiddenSections: [],
    });
  });

  test("migrates legacy 'auto' row detail to balanced", () => {
    const base = createDefaultGlobalSettings();
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        agentRail: {
          ...base.general.agentRail,
          rowDetail: "auto",
        },
      },
    });
    assert.equal(settings.general.agentRail.rowDetail, "balanced");
  });

  test("migrates persisted section order missing the attention section to the top", () => {
    const base = createDefaultGlobalSettings();
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        agentRail: {
          ...base.general.agentRail,
          sectionOrder: ["chats", "pinned", "workspaces"],
        },
      },
    });
    assert.deepEqual(settings.general.agentRail.sectionOrder, [
      "attention",
      "chats",
      "pinned",
      "workspaces",
    ]);
  });

  test("preserves custom attention section placement and row detail mode", () => {
    const base = createDefaultGlobalSettings();
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        agentRail: {
          ...base.general.agentRail,
          rowDetail: "expanded",
          sectionOrder: ["pinned", "attention", "chats", "workspaces"],
          hiddenSections: ["attention"],
        },
      },
    });
    assert.equal(settings.general.agentRail.rowDetail, "expanded");
    assert.deepEqual(settings.general.agentRail.sectionOrder, [
      "pinned",
      "attention",
      "chats",
      "workspaces",
    ]);
    assert.deepEqual(settings.general.agentRail.hiddenSections, ["attention"]);
  });

  test("falls back to balanced row detail for unknown persisted values", () => {
    const base = createDefaultGlobalSettings();
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        agentRail: {
          ...base.general.agentRail,
          rowDetail: "gigantic",
        },
      },
    });
    assert.equal(settings.general.agentRail.rowDetail, "balanced");
  });

  test("defaults new-chat widgets to all visible in default order", () => {
    const settings = createDefaultGlobalSettings();
    assert.deepEqual(settings.general.newChatWidgets, {
      order: ["shortcuts", "actions", "recent-chats", "recent-activity"],
      hidden: [],
    });
  });

  test("normalizes missing new-chat widgets to defaults", () => {
    const base = createDefaultGlobalSettings();
    const { newChatWidgets: _ignored, ...generalWithoutWidgets } = base.general;
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: generalWithoutWidgets,
    });
    assert.deepEqual(settings.general.newChatWidgets, {
      order: ["shortcuts", "actions", "recent-chats", "recent-activity"],
      hidden: [],
    });
  });

  test("preserves custom new-chat widget order and hidden set", () => {
    const base = createDefaultGlobalSettings();
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        newChatWidgets: {
          order: ["recent-chats", "shortcuts", "actions", "recent-activity"],
          hidden: ["recent-activity"],
        },
      },
    });
    assert.deepEqual(settings.general.newChatWidgets, {
      order: ["recent-chats", "shortcuts", "actions", "recent-activity"],
      hidden: ["recent-activity"],
    });
  });

  test("appends missing widget ids and drops unknown/duplicate widget ids", () => {
    const base = createDefaultGlobalSettings();
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        newChatWidgets: {
          order: ["actions", "actions", "bogus", "recent-chats"],
          hidden: ["bogus", "shortcuts", "shortcuts"],
        },
      },
    });
    assert.deepEqual(settings.general.newChatWidgets, {
      order: ["actions", "recent-chats", "shortcuts", "recent-activity"],
      hidden: ["shortcuts"],
    });
  });

  test("normalizes machine workspace sorting", () => {
    const base = createDefaultGlobalSettings();
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        workspaceSortMode: "machine",
      },
    });
    assert.equal(settings.general.workspaceSortMode, "machine");
  });
});
