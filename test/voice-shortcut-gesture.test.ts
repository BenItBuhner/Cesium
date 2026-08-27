import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VOICE_SHORTCUT_HOLD_MS,
  applyVoiceShortcutKeyDown,
  applyVoiceShortcutKeyUp,
  createVoiceShortcutGestureState,
} from "../src/lib/keyboard-shortcuts.ts";

test("a short tap toggles on and does not stop on release", () => {
  const state = createVoiceShortcutGestureState();
  assert.equal(applyVoiceShortcutKeyDown(state, 0), "toggle");
  assert.equal(applyVoiceShortcutKeyUp(state, VOICE_SHORTCUT_HOLD_MS - 1), "none");
});

test("a second tap toggles again so recording can stop", () => {
  const state = createVoiceShortcutGestureState();
  assert.equal(applyVoiceShortcutKeyDown(state, 0), "toggle");
  assert.equal(applyVoiceShortcutKeyUp(state, 40), "none");
  assert.equal(applyVoiceShortcutKeyDown(state, 80), "toggle");
  assert.equal(applyVoiceShortcutKeyUp(state, 120), "none");
});

test("holding past the threshold stops on release", () => {
  const state = createVoiceShortcutGestureState();
  assert.equal(applyVoiceShortcutKeyDown(state, 0), "toggle");
  assert.equal(applyVoiceShortcutKeyUp(state, VOICE_SHORTCUT_HOLD_MS), "stop");
});

test("key repeat while held does not toggle again", () => {
  const state = createVoiceShortcutGestureState();
  assert.equal(applyVoiceShortcutKeyDown(state, 0), "toggle");
  assert.equal(applyVoiceShortcutKeyDown(state, 16), "none");
  assert.equal(applyVoiceShortcutKeyDown(state, 32), "none");
  assert.equal(applyVoiceShortcutKeyUp(state, VOICE_SHORTCUT_HOLD_MS + 16), "stop");
});

test("keyup without a matching keydown is ignored", () => {
  const state = createVoiceShortcutGestureState();
  assert.equal(applyVoiceShortcutKeyUp(state, 1_000), "none");
});

test("a hold can follow a latched tap without leftover pending state", () => {
  const state = createVoiceShortcutGestureState();
  assert.equal(applyVoiceShortcutKeyDown(state, 0), "toggle");
  assert.equal(applyVoiceShortcutKeyUp(state, 50), "none");
  assert.equal(applyVoiceShortcutKeyDown(state, 400), "toggle");
  assert.equal(applyVoiceShortcutKeyUp(state, 400 + VOICE_SHORTCUT_HOLD_MS), "stop");
});
