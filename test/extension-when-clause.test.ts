import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateWhenClause } from "../src/lib/extensions/when-clause";
import {
  eventMatchesExtensionKeybinding,
  parseExtensionKeybinding,
} from "../src/lib/extensions/extension-keybindings";

test("when-clause: empty and bare keys", () => {
  assert.equal(evaluateWhenClause(undefined, {}), true);
  assert.equal(evaluateWhenClause("", {}), true);
  assert.equal(evaluateWhenClause("foo", { foo: true }), true);
  assert.equal(evaluateWhenClause("foo", { foo: false }), false);
  assert.equal(evaluateWhenClause("foo", {}), false);
  assert.equal(evaluateWhenClause("!foo", {}), true);
});

test("when-clause: boolean operators and parentheses", () => {
  const context = { a: true, b: false, c: true };
  assert.equal(evaluateWhenClause("a && b", context), false);
  assert.equal(evaluateWhenClause("a && c", context), true);
  assert.equal(evaluateWhenClause("a || b", context), true);
  assert.equal(evaluateWhenClause("b || (a && c)", context), true);
  assert.equal(evaluateWhenClause("!(a && c)", context), false);
  assert.equal(evaluateWhenClause("!b && a", context), true);
});

test("when-clause: equality and comparisons", () => {
  const context = { view: "cline.sidebar", count: 5, lang: "typescript" };
  assert.equal(evaluateWhenClause("view == cline.sidebar", context), true);
  assert.equal(evaluateWhenClause("view == 'cline.sidebar'", context), true);
  assert.equal(evaluateWhenClause("view != other.view", context), true);
  assert.equal(evaluateWhenClause("count > 3", context), true);
  assert.equal(evaluateWhenClause("count >= 6", context), false);
  assert.equal(evaluateWhenClause("lang == typescript && count < 10", context), true);
});

test("when-clause: regex matching", () => {
  const context = { resourceFilename: "example.test.ts" };
  assert.equal(evaluateWhenClause("resourceFilename =~ /\\.tsx?$/", context), true);
  assert.equal(evaluateWhenClause("resourceFilename =~ /\\.md$/", context), false);
});

test("when-clause: `in` operator", () => {
  const context = {
    resourceLangId: "typescript",
    supportedLangs: ["typescript", "javascript"],
    flags: { alpha: true },
    key: "alpha",
  };
  assert.equal(evaluateWhenClause("resourceLangId in supportedLangs", context), true);
  assert.equal(evaluateWhenClause("resourceLangId in flags", context), false);
  assert.equal(evaluateWhenClause("key in flags", context), true);
  assert.equal(evaluateWhenClause("resourceLangId not in supportedLangs", context), false);
  // Missing collections are simply not matched.
  assert.equal(evaluateWhenClause("resourceLangId in missing", context), false);
});

test("when-clause: unparseable clauses default to visible", () => {
  assert.equal(evaluateWhenClause("view == a b", { view: "z" }), true);
});

test("keybindings: parse and match single chords", () => {
  const binding = parseExtensionKeybinding({
    extensionId: "test.ext",
    command: "test.run",
    key: "ctrl+shift+y",
    platform: "other",
  });
  assert.ok(binding);
  assert.equal(binding.ctrl, true);
  assert.equal(binding.shift, true);
  assert.equal(binding.key, "y");
  assert.equal(
    eventMatchesExtensionKeybinding(
      { key: "Y", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false },
      binding
    ),
    true
  );
  assert.equal(
    eventMatchesExtensionKeybinding(
      { key: "y", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false },
      binding
    ),
    false
  );
});

test("keybindings: multi-chord and unmodified keys are rejected", () => {
  assert.equal(
    parseExtensionKeybinding({
      extensionId: "test.ext",
      command: "test.run",
      key: "ctrl+k ctrl+s",
      platform: "other",
    }),
    null
  );
  assert.equal(
    parseExtensionKeybinding({
      extensionId: "test.ext",
      command: "test.run",
      key: "a",
      platform: "other",
    }),
    null
  );
  // Function keys are allowed without modifiers.
  assert.ok(
    parseExtensionKeybinding({
      extensionId: "test.ext",
      command: "test.run",
      key: "f5",
      platform: "other",
    })
  );
});

test("keybindings: cmdorctrl resolves per platform", () => {
  const apple = parseExtensionKeybinding({
    extensionId: "test.ext",
    command: "test.run",
    key: "cmdorctrl+p",
    platform: "apple",
  });
  const other = parseExtensionKeybinding({
    extensionId: "test.ext",
    command: "test.run",
    key: "cmdorctrl+p",
    platform: "other",
  });
  assert.equal(apple?.meta, true);
  assert.equal(apple?.ctrl, false);
  assert.equal(other?.ctrl, true);
  assert.equal(other?.meta, false);
});
