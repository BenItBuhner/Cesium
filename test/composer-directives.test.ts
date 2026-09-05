import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyComposerDirectives,
  getActiveSlashQuery,
  getSlashMenuSections,
  parseSideChatDirective,
} from "../packages/core/src/composer-suggestions.ts";

describe("composer directives (shared core)", () => {
  test("applyComposerDirectives consumes bare mode and model lines", () => {
    const modes: string[] = [];
    const models: string[] = [];
    const remaining = applyComposerDirectives("/plan\n/model gpt-5.1\nShip it", {
      modeOptions: [
        { id: "agent", label: "Agent" },
        { id: "plan", label: "Plan" },
      ],
      models: [
        { id: "gpt-5.1", name: "GPT-5.1", provider: "openai", modelValue: "gpt-5.1" },
      ],
      backends: [],
      onModeChange: (modeId) => modes.push(modeId),
      onModelChange: (model) => models.push(model.id),
      onBackendChange: () => undefined,
    });
    assert.deepEqual(modes, ["plan"]);
    assert.deepEqual(models, ["gpt-5.1"]);
    assert.equal(remaining, "Ship it");
  });

  test("getActiveSlashQuery detects slash token on the current line", () => {
    assert.equal(getActiveSlashQuery("/pl"), "pl");
    assert.equal(getActiveSlashQuery("hello\n/model gp"), "gp");
    assert.equal(getActiveSlashQuery("no slash here"), null);
  });
});

describe("side chat slash command (shared core)", () => {
  test("parseSideChatDirective recognizes /side, /side-chat, and /btw with optional text", () => {
    assert.deepEqual(parseSideChatDirective("/side"), { text: "" });
    assert.deepEqual(parseSideChatDirective("  /side   "), { text: "" });
    assert.deepEqual(parseSideChatDirective("/side what is it doing right now?"), {
      text: "what is it doing right now?",
    });
    assert.deepEqual(parseSideChatDirective("/Side-Chat compare the two approaches"), {
      text: "compare the two approaches",
    });
    assert.deepEqual(parseSideChatDirective("/btw\nsecond line stays"), {
      text: "second line stays",
    });
    assert.equal(parseSideChatDirective("/sidebar please"), null, "prefix-only tokens are not commands");
    assert.equal(parseSideChatDirective("/sideways"), null);
    assert.equal(parseSideChatDirective("plain text /side"), null);
    assert.equal(parseSideChatDirective("/plan"), null);
  });

  test("bare /side lines are reserved and never treated as a mode switch", () => {
    const modes: string[] = [];
    const remaining = applyComposerDirectives("/side", {
      modeOptions: [
        { id: "agent", label: "Agent" },
        { id: "side", label: "Side" },
      ],
      models: [],
      backends: [],
      onModeChange: (modeId) => modes.push(modeId),
      onModelChange: () => undefined,
      onBackendChange: () => undefined,
    });
    assert.deepEqual(modes, []);
    assert.equal(remaining, "/side");
  });

  test("the slash menu lists Side chat only when the host can open one", () => {
    const backend = {
      id: "cesium-agent" as const,
      label: "Cesium Agent",
      available: true,
      capabilities: { supportsModeSelection: true, supportsModelSelection: true },
    };
    const withSideChat = getSlashMenuSections({
      activeBackend: backend,
      sideChatAvailable: true,
    });
    const commands = withSideChat.find((section) => section.id === "commands");
    const item = commands?.items.find((entry) => entry.id === "side-chat");
    assert.ok(item, "expected the Side chat command");
    assert.deepEqual(item.action, { kind: "side-chat" });
    assert.equal(item.label, "Side chat");
    assert.ok(item.searchKey?.includes("/side"));
    assert.ok(item.searchKey?.includes("btw"));

    const without = getSlashMenuSections({ activeBackend: backend, sideChatAvailable: false });
    assert.equal(
      without.find((section) => section.id === "commands")?.items.some((entry) => entry.id === "side-chat") ?? false,
      false
    );
  });
});
