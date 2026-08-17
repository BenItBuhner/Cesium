import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getQuickActionPreset,
  isQuickActionUiCommandId,
  QUICK_ACTION_UI_COMMANDS,
} from "../packages/core/src/quick-actions.ts";
import {
  dispatchVoiceSessionCommand,
  isVoiceSessionEvent,
  VOICE_SESSION_EVENT,
  type VoiceSessionEventDetail,
} from "../src/lib/voice-session-events.ts";

test("voice.startAgent is a registered quick action ui command", () => {
  assert.equal(isQuickActionUiCommandId("voice.startAgent"), true);
  const command = QUICK_ACTION_UI_COMMANDS.find(
    (candidate) => candidate.id === "voice.startAgent"
  );
  assert.ok(command);
  assert.equal(command.label, "Start voice agent");
});

test("start-voice-agent preset targets the ui command", () => {
  const preset = getQuickActionPreset("start-voice-agent");
  assert.ok(preset);
  assert.equal(preset.kind, "ui");
  assert.equal(preset.uiCommand, "voice.startAgent");
  assert.equal(preset.confirm, false);
});

test("dispatchVoiceSessionCommand round-trips through the window event", () => {
  const received: VoiceSessionEventDetail[] = [];
  const target = new EventTarget();
  const listener = (event: Event) => {
    if (isVoiceSessionEvent(event)) {
      received.push(event.detail);
    }
  };
  target.addEventListener(VOICE_SESSION_EVENT, listener);
  (globalThis as { window?: unknown }).window = target;
  try {
    dispatchVoiceSessionCommand("start");
    dispatchVoiceSessionCommand("minimize");
  } finally {
    delete (globalThis as { window?: unknown }).window;
    target.removeEventListener(VOICE_SESSION_EVENT, listener);
  }
  assert.deepEqual(received, [{ command: "start" }, { command: "minimize" }]);
});
