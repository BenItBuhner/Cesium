import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildSettingsSearchIndex,
  searchSettingsIndex,
} from "../src/lib/settings-search-index.ts";

describe("settings search index", () => {
  test("finds nav and row entries by label", () => {
    const index = buildSettingsSearchIndex({});
    const appearance = searchSettingsIndex(index, "appearance");
    assert.ok(appearance.some((hit) => hit.kind === "nav" && hit.navId === "appearance"));

    const dnd = searchSettingsIndex(index, "do not disturb");
    assert.ok(dnd.some((hit) => hit.rowId === "do-not-disturb"));
  });

  test("indexes model names from the catalog", () => {
    const index = buildSettingsSearchIndex({
      "cesium-agent": [
        { id: "cerebras/llama", name: "Cerebras Llama 3.3 70B", on: true },
      ],
    });
    const hits = searchSettingsIndex(index, "cerebras");
    assert.ok(hits.some((hit) => hit.kind === "model" && hit.backendId === "cesium-agent"));
  });

  test("indexes MCP settings under Plugins, not a top-level MCP nav", () => {
    const index = buildSettingsSearchIndex({});
    const presets = searchSettingsIndex(index, "mcp presets");
    assert.ok(
      presets.some(
        (hit) => hit.navId === "plugins" && hit.id === "plugins::section::mcp-presets"
      )
    );
    assert.equal(
      searchSettingsIndex(index, "MCPs").some((hit) => hit.kind === "nav" && hit.navId === "mcps"),
      false
    );
  });

  test("indexes Cloud Agents settings", () => {
    const index = buildSettingsSearchIndex({});
    const nav = searchSettingsIndex(index, "cloud agents");
    assert.ok(nav.some((hit) => hit.kind === "nav" && hit.navId === "cloudAgents"));

    const connections = searchSettingsIndex(index, "linear slack");
    assert.ok(
      connections.some((hit) => hit.id === "cloudAgents::section::connections")
    );

    const autoDispatch = searchSettingsIndex(index, "auto-dispatch");
    assert.ok(autoDispatch.some((hit) => hit.rowId === "cloud-agents-auto-dispatch"));
  });

  test("indexes VS Code extension settings", () => {
    const index = buildSettingsSearchIndex({});
    const navHits = searchSettingsIndex(index, "extensions");
    assert.ok(navHits.some((hit) => hit.kind === "nav" && hit.navId === "extensions"));

    assert.ok(index.some((hit) => hit.navId === "beta" && hit.rowId === "vscode-extensions"));
  });

  test("indexes backend public access controls under Servers", () => {
    const index = buildSettingsSearchIndex({});
    const hits = searchSettingsIndex(index, "permanent connection link");
    assert.ok(
      hits.some(
        (hit) => hit.navId === "servers" && hit.rowId === "stable-link"
      )
    );
  });

  test("finds keyboard shortcut commands", () => {
    const index = buildSettingsSearchIndex({});
    const openSettings = searchSettingsIndex(index, "open settings");
    assert.ok(
      openSettings.some(
        (hit) => hit.kind === "shortcut" && hit.label.toLowerCase().includes("settings")
      )
    );

    const newChat = searchSettingsIndex(index, "new chat");
    assert.ok(
      newChat.some(
        (hit) => hit.kind === "shortcut" && hit.id === "shortcut::chat.action.newChat"
      )
    );
  });

  test("can omit iPad beta rows for desktop shells", () => {
    const index = buildSettingsSearchIndex({}, { includeIpadBeta: false });
    assert.equal(
      index.some((hit) => hit.id === "beta::section::ipad"),
      false
    );
    assert.equal(
      index.some((hit) => hit.id === "beta::ipad-text-input"),
      false
    );
  });
});
