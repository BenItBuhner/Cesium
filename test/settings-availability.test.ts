import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  filterSettingsNavEntries,
  filterSettingsSearchEntries,
  isSettingsNavAvailable,
  resolveSettingsEngineAvailability,
  settingsEnginePagesVisible,
  settingsNavRequiresServer,
} from "../src/lib/settings-availability.ts";
import {
  buildSettingsSearchIndex,
  searchSettingsIndex,
} from "../src/lib/settings-search-index.ts";

describe("settings availability", () => {
  test("classifies client hubs as available without a server", () => {
    for (const navId of [
      "account",
      "general",
      "appearance",
      "keyboardShortcuts",
      "servers",
      "advanced",
      "exportImport",
      "beta",
    ]) {
      assert.equal(settingsNavRequiresServer(navId), false);
      assert.equal(isSettingsNavAvailable(navId, false), true);
    }
  });

  test("classifies engine pages as server-bound", () => {
    for (const navId of [
      "voice",
      "agents",
      "models",
      "usage",
      "cloudAgents",
      "plugins",
      "extensions",
      "rulesSkills",
      "actions",
      "storage",
      "updates",
    ]) {
      assert.equal(settingsNavRequiresServer(navId), true);
      assert.equal(isSettingsNavAvailable(navId, false), false);
      assert.equal(isSettingsNavAvailable(navId, true), true);
    }
  });

  test("filters sidebar items and collapses leftover dividers", () => {
    const entries = [
      { kind: "item" as const, id: "account" },
      { kind: "divider" as const },
      { kind: "item" as const, id: "general" },
      { kind: "item" as const, id: "voice" },
      { kind: "item" as const, id: "agents" },
      { kind: "item" as const, id: "plugins" },
      { kind: "item" as const, id: "servers" },
      { kind: "divider" as const },
      { kind: "item" as const, id: "advanced" },
    ];

    const offline = filterSettingsNavEntries(entries, false);
    assert.deepEqual(
      offline.map((entry) => (entry.kind === "item" ? entry.id : "divider")),
      ["account", "divider", "general", "servers", "divider", "advanced"]
    );

    const online = filterSettingsNavEntries(entries, true);
    assert.equal(online.length, entries.length);
  });

  test("hides server-bound search hits when no engine is connected", () => {
    const index = buildSettingsSearchIndex({});
    const usageHits = searchSettingsIndex(index, "usage");
    assert.ok(usageHits.some((hit) => hit.navId === "usage"));
    assert.equal(
      filterSettingsSearchEntries(usageHits, false).some((hit) => hit.navId === "usage"),
      false
    );
    assert.ok(
      filterSettingsSearchEntries(searchSettingsIndex(index, "appearance"), false).some(
        (hit) => hit.navId === "appearance"
      )
    );
  });

  test("treats a saved but unreachable engine as disconnected", () => {
    assert.equal(
      resolveSettingsEngineAvailability({
        hasServer: false,
        servers: [],
        onlineCount: 0,
        statusById: {},
      }),
      "none"
    );
    assert.equal(
      resolveSettingsEngineAvailability({
        hasServer: true,
        servers: [{ id: "local" }],
        onlineCount: 0,
        statusById: {},
      }),
      "checking"
    );
    assert.equal(
      resolveSettingsEngineAvailability({
        hasServer: true,
        servers: [{ id: "local" }],
        onlineCount: 0,
        statusById: { local: { health: "offline" } },
      }),
      "none"
    );
    assert.equal(
      resolveSettingsEngineAvailability({
        hasServer: true,
        servers: [{ id: "local" }],
        onlineCount: 1,
        statusById: { local: { health: "online" } },
      }),
      "connected"
    );
    assert.equal(settingsEnginePagesVisible("checking"), true);
    assert.equal(settingsEnginePagesVisible("none"), false);
  });
});
