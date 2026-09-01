import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildSettingsSearchIndex,
  pluginsSettingsSubviewForSearchHit,
  searchSettingsIndex,
} from "../src/lib/settings-search-index.ts";

describe("settings search index", () => {
  test("finds nav and row entries by label", () => {
    const index = buildSettingsSearchIndex({});
    const appearance = searchSettingsIndex(index, "appearance");
    assert.ok(appearance.some((hit) => hit.kind === "nav" && hit.navId === "appearance"));

    const dnd = searchSettingsIndex(index, "do not disturb");
    assert.ok(dnd.some((hit) => hit.rowId === "do-not-disturb"));

    const composerLayout = searchSettingsIndex(index, "composer layout concise");
    assert.ok(composerLayout.some((hit) => hit.rowId === "composer-layout"));
  });

  test("indexes the composer footer under General", () => {
    const index = buildSettingsSearchIndex({});
    const hits = searchSettingsIndex(index, "composer footer");
    assert.ok(hits.some((hit) => hit.rowId === "composer-status-bar"));
  });

  test("indexes Advanced hub links", () => {
    const index = buildSettingsSearchIndex({});
    const nav = searchSettingsIndex(index, "advanced");
    assert.ok(nav.some((hit) => hit.kind === "nav" && hit.navId === "advanced"));
    const storage = searchSettingsIndex(index, "storage postgres");
    assert.ok(storage.some((hit) => hit.rowId === "storage-link" || hit.navId === "storage"));
  });

  test("indexes Integrations as the plugins hub", () => {
    const index = buildSettingsSearchIndex({});
    const hits = searchSettingsIndex(index, "integrations");
    assert.ok(hits.some((hit) => hit.kind === "nav" && hit.navId === "plugins"));

    const mcp = searchSettingsIndex(index, "mcp servers");
    assert.ok(mcp.some((hit) => hit.rowId === "mcp-link"));

    const rules = searchSettingsIndex(index, "rules skills subagents");
    assert.ok(rules.some((hit) => hit.rowId === "rules-link"));

    const extensions = searchSettingsIndex(index, "vs code extensions");
    assert.ok(extensions.some((hit) => hit.rowId === "extensions-link"));

    const plugins = searchSettingsIndex(index, "agent plugins");
    assert.ok(plugins.some((hit) => hit.rowId === "plugins-link"));
  });

  test("routes Integrations search hits to the matching subpage", () => {
    assert.equal(
      pluginsSettingsSubviewForSearchHit({
        navId: "plugins",
        id: "plugins::mcp-link",
        rowId: "mcp-link",
      }),
      "mcp"
    );
    assert.equal(
      pluginsSettingsSubviewForSearchHit({
        navId: "plugins",
        id: "plugins::section::mcp-presets",
      }),
      "mcp"
    );
    assert.equal(
      pluginsSettingsSubviewForSearchHit({
        navId: "plugins",
        id: "plugins::plugins-link",
        rowId: "plugins-link",
      }),
      "catalog"
    );
    assert.equal(
      pluginsSettingsSubviewForSearchHit({
        navId: "plugins",
        id: "plugins::section::discover",
      }),
      "catalog"
    );
    assert.equal(
      pluginsSettingsSubviewForSearchHit({
        navId: "plugins",
        id: "plugins::rules-link",
        rowId: "rules-link",
      }),
      "hub"
    );
    assert.equal(
      pluginsSettingsSubviewForSearchHit({ navId: "mcps", id: "nav::mcps" }),
      "mcp"
    );
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

  test("indexes new chat widget settings under General", () => {
    const index = buildSettingsSearchIndex({});
    const sectionHits = searchSettingsIndex(index, "new chat widgets");
    assert.ok(
      sectionHits.some((hit) => hit.id === "general::section::new-chat-widgets")
    );

    const tileHits = searchSettingsIndex(index, "landing tiles");
    assert.ok(tileHits.some((hit) => hit.rowId === "new-chat-widget-recent-chats"));
    assert.ok(tileHits.some((hit) => hit.rowId === "new-chat-widget-recent-activity"));
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

  test("indexes Voice settings for transcription and TTS", () => {
    const index = buildSettingsSearchIndex({});
    const nav = searchSettingsIndex(index, "voice");
    assert.ok(nav.some((hit) => hit.kind === "nav" && hit.navId === "voice"));

    const transcription = searchSettingsIndex(index, "transcription model");
    assert.ok(
      transcription.some(
        (hit) => hit.navId === "voice" && hit.rowId === "transcription-model"
      )
    );

    const whisper = searchSettingsIndex(index, "whisper");
    assert.ok(whisper.some((hit) => hit.navId === "voice"));

    const account = searchSettingsIndex(index, "client account");
    assert.ok(
      account.some((hit) => hit.navId === "voice" && hit.rowId === "voice-scope-client")
    );
    const defaultSource = searchSettingsIndex(index, "default voice provider");
    assert.ok(
      defaultSource.some((hit) => hit.navId === "voice" && hit.rowId === "voice-source-default")
    );
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

    const voiceHold = searchSettingsIndex(index, "hold record");
    assert.ok(
      voiceHold.some(
        (hit) =>
          hit.kind === "shortcut" &&
          hit.id === "shortcut::chat.action.toggleVoiceInput"
      )
    );
  });

  test("indexes Cursor ACP and harness enable toggles", () => {
    const index = buildSettingsSearchIndex({});
    const acp = searchSettingsIndex(index, "cursor acp oauth");
    assert.ok(
      acp.some(
        (hit) =>
          hit.rowId === "cursor-acp" ||
          hit.id === "harness::cursor-sdk" ||
          hit.id === "harness::cursor-acp"
      )
    );
    const toggles = searchSettingsIndex(index, "enabled harnesses");
    assert.ok(toggles.some((hit) => hit.rowId === "enabled-harnesses"));
  });

  test("indexes official Cesium subscription OAuth accounts", () => {
    const index = buildSettingsSearchIndex({});
    const hits = searchSettingsIndex(index, "supergrok");
    assert.ok(hits.some((hit) => hit.rowId === "cesium-oauth-accounts"));
    const chatgpt = searchSettingsIndex(index, "chatgpt codex");
    assert.ok(chatgpt.some((hit) => hit.rowId === "cesium-oauth-accounts"));
  });

  test("indexes aurora as a workbench and settings backdrop", () => {
    const index = buildSettingsSearchIndex({});
    const hits = searchSettingsIndex(index, "aurora settings");
    assert.ok(
      hits.some(
        (hit) =>
          hit.rowId === "aurora-background" &&
          hit.subtitle.includes("settings")
      )
    );
  });

  test("indexes unsigned-in account under the identity row", () => {
    const index = buildSettingsSearchIndex({});
    const hits = searchSettingsIndex(index, "not signed in");
    assert.ok(hits.some((hit) => hit.rowId === "account-identity"));
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
