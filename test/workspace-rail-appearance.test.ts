import assert from "node:assert/strict";

import { describe, test } from "node:test";

import {

  buildWorkspaceAppearanceKey,

  collectHomeWorkspaceAppearancesToPersist,

  getDefaultHomeWorkspaceAppearance,

  getWorkspaceRailAppearance,

  hasSavedWorkspaceRailAppearance,

  pickStableWorkspaceColor,

  resolveWorkspaceAppearanceKey,

} from "../src/lib/workspace-rail-appearance.ts";



describe("workspace rail appearance", () => {

  test("builds server-scoped workspace keys", () => {

    assert.equal(buildWorkspaceAppearanceKey("srv-1", "ws-a"), "srv-1:ws-a");

  });



  test("resolves appearance key from workspaceKey or server + id", () => {

    assert.equal(

      resolveWorkspaceAppearanceKey({

        workspaceKey: "srv-1:ws-a",

        workspaceId: "ws-a",

      }),

      "srv-1:ws-a"

    );

    assert.equal(

      resolveWorkspaceAppearanceKey({

        serverId: "srv-1",

        workspaceId: "ws-a",

      }),

      "srv-1:ws-a"

    );

    assert.equal(

      resolveWorkspaceAppearanceKey({

        workspaceId: "ws-a",

        fallbackServerId: "srv-2",

      }),

      "srv-2:ws-a"

    );

  });



  test("detects saved customization", () => {

    const appearances = { "srv-1:home": { icon: "Rocket", color: "#2563eb" } };

    assert.equal(hasSavedWorkspaceRailAppearance(appearances, "srv-1:home"), true);

    assert.equal(hasSavedWorkspaceRailAppearance(appearances, "srv-1:other"), false);

  });



  test("falls back to palette color by index for non-home workspaces", () => {

    const appearance = getWorkspaceRailAppearance({}, "missing:key", 1);

    assert.equal(appearance.icon, "Folder");

    assert.equal(appearance.color, "#2563eb");

  });



  test("uses stable home icon and color when unsaved", () => {

    const key = "srv-1:home-ws";

    const appearance = getWorkspaceRailAppearance({}, key, 0, { isHome: true });

    assert.equal(appearance.icon, "Home");

    assert.equal(appearance.color, pickStableWorkspaceColor(key));

    assert.equal(

      getWorkspaceRailAppearance({}, key, 99, { isHome: true }).color,

      appearance.color

    );

  });



  test("respects saved home customization", () => {

    const saved = { icon: "Folder", color: "#dc2626" };

    const appearance = getWorkspaceRailAppearance(

      { "srv-1:home": saved },

      "srv-1:home",

      0,

      { isHome: true }

    );

    assert.deepEqual(appearance, saved);

  });



  test("pickStableWorkspaceColor is deterministic", () => {

    assert.equal(

      pickStableWorkspaceColor("srv-a:ws-1"),

      pickStableWorkspaceColor("srv-a:ws-1")

    );

    assert.notEqual(

      pickStableWorkspaceColor("srv-a:ws-1"),

      pickStableWorkspaceColor("srv-b:ws-1")

    );

  });



  test("collectHomeWorkspaceAppearancesToPersist only includes unsaved home rows", () => {

    const patches = collectHomeWorkspaceAppearancesToPersist(

      { "srv-1:home": { icon: "Rocket", color: "#2563eb" } },

      [

        { workspaceKey: "srv-1:home", isHome: true },

        { workspaceKey: "srv-1:other", isHome: false },

        { workspaceKey: "srv-2:home", isHome: true },

      ]

    );

    assert.deepEqual(Object.keys(patches), ["srv-2:home"]);

    assert.equal(patches["srv-2:home"].icon, "Home");

    assert.equal(

      patches["srv-2:home"].color,

      getDefaultHomeWorkspaceAppearance("srv-2:home").color

    );

  });

});


