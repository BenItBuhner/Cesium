import test from "node:test";
import assert from "node:assert/strict";
import { shouldSubmitComposerOnEnter } from "../src/lib/composer-submit-key.ts";

const enter = (overrides: Partial<Parameters<typeof shouldSubmitComposerOnEnter>[0]> = {}) => ({
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  ...overrides,
});

test("mobile Enter inserts a newline instead of submitting", () => {
  assert.equal(
    shouldSubmitComposerOnEnter(enter(), {
      hasHardwareKeyboard: false,
      submitCtrlEnter: false,
    }),
    false
  );
});

test("hardware Enter submits when plain Enter submission is enabled", () => {
  assert.equal(
    shouldSubmitComposerOnEnter(enter(), {
      hasHardwareKeyboard: true,
      submitCtrlEnter: false,
    }),
    true
  );
});

test("hardware Shift+Enter inserts a newline when plain Enter submission is enabled", () => {
  assert.equal(
    shouldSubmitComposerOnEnter(enter({ shiftKey: true }), {
      hasHardwareKeyboard: true,
      submitCtrlEnter: false,
    }),
    false
  );
});

test("Ctrl/Cmd+Enter submits when modifier submission is enabled", () => {
  assert.equal(
    shouldSubmitComposerOnEnter(enter({ ctrlKey: true }), {
      hasHardwareKeyboard: true,
      submitCtrlEnter: true,
    }),
    true
  );
  assert.equal(
    shouldSubmitComposerOnEnter(enter({ metaKey: true }), {
      hasHardwareKeyboard: true,
      submitCtrlEnter: true,
    }),
    true
  );
});

test("plain hardware Enter inserts a newline when modifier submission is enabled", () => {
  assert.equal(
    shouldSubmitComposerOnEnter(enter(), {
      hasHardwareKeyboard: true,
      submitCtrlEnter: true,
    }),
    false
  );
});
