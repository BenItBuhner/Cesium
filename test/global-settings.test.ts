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
    });
  });

  test("migrates legacy environment group-by to workspace", () => {
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
    assert.equal(settings.general.agentRail.groupBy, "workspace");
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
    });
  });
});
