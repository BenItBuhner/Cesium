import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  QUICK_OPEN_SCOPE_IDS,
  cycleQuickOpenScope,
  normalizeQuickOpenScope,
  normalizeQuickSwitcherScope,
  parseQuickOpenQuery,
} from "../src/lib/quick-open-scopes.ts";
import {
  createDefaultGlobalSettings,
  normalizeLoadedGlobalSettings,
} from "../src/lib/global-settings.ts";

describe("quick open scopes", () => {
  test("sigil prefixes override the base scope and strip the sigil", () => {
    assert.deepEqual(parseQuickOpenQuery(">split", "files"), {
      scope: "commands",
      query: "split",
      prefixed: true,
    });
    assert.deepEqual(parseQuickOpenQuery("@ demo chat", "files"), {
      scope: "conversations",
      query: "demo chat",
      prefixed: true,
    });
    assert.deepEqual(parseQuickOpenQuery("#theme", "tabs"), {
      scope: "settings",
      query: "theme",
      prefixed: true,
    });
  });

  test("word prefixes override the base scope", () => {
    assert.deepEqual(parseQuickOpenQuery("tabs: readme", "files"), {
      scope: "tabs",
      query: "readme",
      prefixed: true,
    });
    assert.deepEqual(parseQuickOpenQuery("FILES: app", "settings"), {
      scope: "files",
      query: "app",
      prefixed: true,
    });
    assert.deepEqual(parseQuickOpenQuery("chats:demo", "files"), {
      scope: "conversations",
      query: "demo",
      prefixed: true,
    });
  });

  test("plain queries keep the base scope", () => {
    assert.deepEqual(parseQuickOpenQuery("readme", "conversations"), {
      scope: "conversations",
      query: "readme",
      prefixed: false,
    });
    // A sigil not in first position is treated as literal query text.
    assert.deepEqual(parseQuickOpenQuery("a > b", "files"), {
      scope: "files",
      query: "a > b",
      prefixed: false,
    });
  });

  test("scope cycling wraps in both directions", () => {
    const first = QUICK_OPEN_SCOPE_IDS[0];
    const last = QUICK_OPEN_SCOPE_IDS[QUICK_OPEN_SCOPE_IDS.length - 1];
    assert.equal(cycleQuickOpenScope(last, 1), first);
    assert.equal(cycleQuickOpenScope(first, -1), last);
    assert.equal(cycleQuickOpenScope("files", 1), "conversations");
  });

  test("normalizers fall back on invalid input", () => {
    assert.equal(normalizeQuickOpenScope("tabs"), "tabs");
    assert.equal(normalizeQuickOpenScope("bogus"), "files");
    assert.equal(normalizeQuickOpenScope(undefined), "files");
    assert.equal(normalizeQuickSwitcherScope("both"), "both");
    assert.equal(normalizeQuickSwitcherScope(42), "conversations");
  });
});

describe("quick open settings persistence", () => {
  test("defaults are files / conversations", () => {
    const defaults = createDefaultGlobalSettings();
    assert.equal(defaults.general.quickOpenDefaultScope, "files");
    assert.equal(defaults.general.quickSwitcherScope, "conversations");
  });

  test("persisted values round-trip and invalid values are coerced", () => {
    const stored = createDefaultGlobalSettings();
    stored.general.quickOpenDefaultScope = "conversations";
    stored.general.quickSwitcherScope = "both";
    const loaded = normalizeLoadedGlobalSettings(JSON.parse(JSON.stringify(stored)));
    assert.equal(loaded.general.quickOpenDefaultScope, "conversations");
    assert.equal(loaded.general.quickSwitcherScope, "both");

    const corrupt = JSON.parse(JSON.stringify(stored)) as {
      general: Record<string, unknown>;
    };
    corrupt.general.quickOpenDefaultScope = "everything";
    corrupt.general.quickSwitcherScope = null;
    const recovered = normalizeLoadedGlobalSettings(corrupt);
    assert.equal(recovered.general.quickOpenDefaultScope, "files");
    assert.equal(recovered.general.quickSwitcherScope, "conversations");
  });
});
