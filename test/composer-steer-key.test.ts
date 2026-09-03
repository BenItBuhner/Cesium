import test from "node:test";
import assert from "node:assert/strict";
import { shouldSteerComposerOnKey } from "../src/lib/composer-steer-key.ts";
import {
  STEER_MESSAGE_COMMAND_ID,
  withToggledPlainShortcutBinding,
} from "../src/lib/keyboard-shortcuts.ts";

const tab = {
  key: "Tab",
  code: "Tab",
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
};

test("Tab does not steer when the steer command is unbound", () => {
  assert.equal(
    shouldSteerComposerOnKey(tab, {
      hasHardwareKeyboard: true,
      bindings: { [STEER_MESSAGE_COMMAND_ID]: [] },
      platform: "other",
      obstructed: false,
    }),
    false
  );
});

test("Tab steers when Steer with Tab is enabled", () => {
  assert.equal(
    shouldSteerComposerOnKey(tab, {
      hasHardwareKeyboard: true,
      bindings: { [STEER_MESSAGE_COMMAND_ID]: ["Tab"] },
      platform: "other",
      obstructed: false,
    }),
    true
  );
});

test("Shift+Tab does not steer when Tab is the steer binding", () => {
  assert.equal(
    shouldSteerComposerOnKey(
      { ...tab, shiftKey: true },
      {
        hasHardwareKeyboard: true,
        bindings: { [STEER_MESSAGE_COMMAND_ID]: ["Tab"] },
        platform: "other",
        obstructed: false,
      }
    ),
    false
  );
});

test("remapped steer keys work without enabling Tab", () => {
  const q = {
    key: "q",
    code: "KeyQ",
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
  };
  assert.equal(
    shouldSteerComposerOnKey(q, {
      hasHardwareKeyboard: true,
      bindings: { [STEER_MESSAGE_COMMAND_ID]: ["Q"] },
      platform: "other",
      obstructed: false,
    }),
    true
  );
});

test("mobile hardware-less surfaces never steal Tab for steer", () => {
  assert.equal(
    shouldSteerComposerOnKey(tab, {
      hasHardwareKeyboard: false,
      bindings: { [STEER_MESSAGE_COMMAND_ID]: ["Tab"] },
      platform: "other",
      obstructed: false,
    }),
    false
  );
});

test("toggling the Tab convenience binding leaves remapped keys intact", () => {
  assert.deepEqual(withToggledPlainShortcutBinding(["Q"], "Tab", true), ["Q", "Tab"]);
  assert.deepEqual(withToggledPlainShortcutBinding(["Q", "Tab"], "Tab", false), ["Q"]);
});
