import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyAgentRailViewPreset,
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

  test("leaves composer status defaults unset for legacy workspace migration", () => {
    const settings = createDefaultGlobalSettings();
    assert.equal(settings.general.composerStatusBarVisibility, undefined);
  });

  test("normalizes explicit composer status defaults", () => {
    const base = createDefaultGlobalSettings();
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        composerStatusBarVisibility: {
          repo: false,
          branch: false,
          context: false,
        },
      },
    });
    assert.deepEqual(settings.general.composerStatusBarVisibility, {
      repo: false,
      branch: false,
      goal: true,
      context: false,
    });
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
      orderBy: "updated",
      visibleStatusFilters: [],
      visibleServerIds: [],
      hiddenServerIds: [],
      showIcons: true,
      showEnvironment: true,
      showWorkspace: true,
      showBranch: false,
      showMachine: true,
      rowDetail: "balanced",
      sectionOrder: ["attention", "running", "pinned", "chats", "workspaces"],
      hiddenSections: [],
      scope: { type: "all" },
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

  test("keeps every grouping mode and falls back on unknown values", () => {
    const base = createDefaultGlobalSettings();
    for (const mode of [
      "workspace",
      "repository",
      "updated",
      "status",
      "server",
      "priority",
    ] as const) {
      const settings = normalizeLoadedGlobalSettings({
        ...base,
        general: {
          ...base.general,
          agentRail: {
            ...base.general.agentRail,
            groupBy: mode,
          },
        },
      });
      assert.equal(settings.general.agentRail.groupBy, mode);
    }
    const fallback = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        agentRail: {
          ...base.general.agentRail,
          groupBy: "nonsense",
        },
      },
    });
    assert.equal(fallback.general.agentRail.groupBy, "workspace");
  });

  test("normalizes order-by and show flags", () => {
    const base = createDefaultGlobalSettings();
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        agentRail: {
          ...base.general.agentRail,
          orderBy: "status",
          showEnvironment: false,
          showBranch: true,
          showMachine: false,
          showWorkspace: false,
        },
      },
    });
    assert.equal(settings.general.agentRail.orderBy, "status");
    assert.equal(settings.general.agentRail.showEnvironment, false);
    assert.equal(settings.general.agentRail.showBranch, true);
    assert.equal(settings.general.agentRail.showMachine, false);
    assert.equal(settings.general.agentRail.showWorkspace, false);
    const fallback = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        agentRail: {
          ...base.general.agentRail,
          orderBy: "nonsense",
          showBranch: "bad",
        },
      },
    });
    assert.equal(fallback.general.agentRail.orderBy, "updated");
    assert.equal(fallback.general.agentRail.showBranch, false);
  });

  test("normalizes harness enable toggles and defaults missing keys to on", () => {
    const base = createDefaultGlobalSettings();
    assert.deepEqual(base.agents.enabledHarnesses, {});
    assert.deepEqual(base.agents.harnessTransports, {});
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      agents: {
        ...base.agents,
        enabledHarnesses: {
          "cursor-sdk": false,
          "not-a-boolean": "nope",
          "": false,
        } as never,
      },
    });
    assert.equal(settings.agents.enabledHarnesses["cursor-sdk"], false);
    assert.equal(settings.agents.enabledHarnesses["cursor-acp"], undefined);
    assert.equal("not-a-boolean" in settings.agents.enabledHarnesses, false);
  });

  test("normalizes Cursor/Codex harness transport preferences", () => {
    const base = createDefaultGlobalSettings();
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      agents: {
        ...base.agents,
        harnessTransports: {
          cursor: "acp",
          codex: "nope",
          extra: "sdk",
        } as never,
      },
    });
    assert.equal(settings.agents.harnessTransports.cursor, "acp");
    assert.equal(settings.agents.harnessTransports.codex, undefined);
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
    assert.equal(settings.models.byBackend["cursor-acp"]?.length, 1);
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
      orderBy: "updated",
      visibleStatusFilters: [],
      visibleServerIds: [],
      hiddenServerIds: ["server-b"],
      showIcons: true,
      showEnvironment: true,
      showWorkspace: true,
      showBranch: false,
      showMachine: true,
      rowDetail: "balanced",
      sectionOrder: ["attention", "running", "pinned", "chats", "workspaces"],
      hiddenSections: [],
      scope: { type: "all" },
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
      "running",
      "pinned",
      "chats",
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
      "attention",
      "running",
      "pinned",
      "chats",
      "workspaces",
    ]);
    assert.deepEqual(settings.general.agentRail.hiddenSections, ["attention"]);
  });

  test("drops a hidden pinned section so folders always have a home", () => {
    const base = createDefaultGlobalSettings();
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        agentRail: {
          ...base.general.agentRail,
          hiddenSections: ["pinned", "attention"],
        },
      },
    });
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

  test("device picker defaults to every section visible in default order", () => {
    const settings = createDefaultGlobalSettings();
    assert.deepEqual(settings.general.devicePicker, {
      sectionOrder: ["servers", "codespaces", "cloud"],
      order: [],
      hidden: [],
    });
  });

  test("legacy profiles without devicePicker get the defaults", () => {
    const base = createDefaultGlobalSettings();
    const { devicePicker: _ignored, ...generalWithoutPicker } = base.general;
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: generalWithoutPicker,
    });
    assert.deepEqual(settings.general.devicePicker, base.general.devicePicker);
  });

  test("normalizes device picker section order and dedupes ids", () => {
    const base = createDefaultGlobalSettings();
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        devicePicker: {
          sectionOrder: ["cloud", "bogus", "cloud"],
          order: ["server:a", "", "server:a", 42, "cloud:cursor-sdk"],
          hidden: ["section:codespaces", "section:codespaces", null, "action:browser"],
        },
      },
    });
    assert.deepEqual(settings.general.devicePicker, {
      sectionOrder: ["cloud", "servers", "codespaces"],
      order: ["server:a", "cloud:cursor-sdk"],
      hidden: ["section:codespaces", "action:browser"],
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

  test("persists a workspace rail scope and defaults to all", () => {
    const base = createDefaultGlobalSettings();
    assert.deepEqual(base.general.agentRail.scope, { type: "all" });
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        agentRail: {
          ...base.general.agentRail,
          scope: { type: "workspace", workspaceKey: "local:ws-1" },
        },
      },
    });
    assert.deepEqual(settings.general.agentRail.scope, {
      type: "workspace",
      workspaceKey: "local:ws-1",
    });
  });

  test("persists a no-workspace rail scope", () => {
    const base = createDefaultGlobalSettings();
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        agentRail: {
          ...base.general.agentRail,
          scope: { type: "no-workspace" },
        },
      },
    });
    assert.deepEqual(settings.general.agentRail.scope, { type: "no-workspace" });
  });

  test("applies named rail view presets", () => {
    const rail = createDefaultGlobalSettings().general.agentRail;
    const inbox = applyAgentRailViewPreset("inbox", rail);
    assert.equal(inbox.groupBy, "priority");
    assert.equal(inbox.rowDetail, "balanced");
    const compact = applyAgentRailViewPreset("compact", rail);
    assert.equal(compact.groupBy, "workspace");
    assert.equal(compact.rowDetail, "compact");
    const compactFromInbox = applyAgentRailViewPreset("compact", inbox);
    assert.equal(compactFromInbox.groupBy, "workspace");
    assert.deepEqual(compactFromInbox.scope, { type: "all" });
    const restored = applyAgentRailViewPreset("default", compact);
    assert.equal(restored.groupBy, "workspace");
    assert.equal(restored.rowDetail, "balanced");
    const scoped = applyAgentRailViewPreset("default", {
      ...rail,
      scope: { type: "workspace", workspaceKey: "local:ws-1" },
      hiddenSections: ["attention"],
    });
    assert.deepEqual(scoped.scope, { type: "all" });
    assert.equal(scoped.hiddenSections.includes("attention"), false);
  });
});
