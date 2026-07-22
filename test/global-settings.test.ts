import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createDefaultGlobalSettings,
  normalizeLoadedGlobalSettings,
} from "../src/lib/global-settings.ts";

describe("global settings", () => {
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
      sectionOrder: ["pinned", "chats", "workspaces"],
      hiddenSections: [],
    });
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
      sectionOrder: ["pinned", "chats", "workspaces"],
      hiddenSections: [],
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
