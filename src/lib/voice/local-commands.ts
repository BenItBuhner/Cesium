/**
 * Deterministic local handling for playback/mode commands. Per the
 * blueprint: never send a model request merely to interpret "stop talking".
 * Matches only when the WHOLE utterance is a command, so "stop the dev
 * server" still reaches the controller.
 */

export type LocalVoiceCommand =
  | { kind: "stop_speaking" }
  | { kind: "quiet_mode" }
  | { kind: "active_mode" }
  | { kind: "pause_listening" }
  | { kind: "resume_listening" };

const STOP_SPEAKING = new Set([
  "stop",
  "stop talking",
  "shut up",
  "cancel",
  "cancel that",
  "never mind",
  "nevermind",
  "okay stop",
  "ok stop",
]);

const QUIET_MODE = new Set([
  "go quiet",
  "be quiet",
  "quiet mode",
  "quiet please",
  "stop speaking to me",
  "mute yourself",
]);

const ACTIVE_MODE = new Set([
  "voice on",
  "active mode",
  "resume speaking",
  "speak to me",
  "you can talk again",
  "unmute yourself",
]);

const PAUSE_LISTENING = new Set([
  "pause listening",
  "stop listening",
  "pause voice",
  "pause the voice",
  "stop the voice",
]);

const RESUME_LISTENING = new Set([
  "resume listening",
  "start listening",
  "resume voice",
  "wake up",
]);

export function parseLocalVoiceCommand(
  utterance: string
): LocalVoiceCommand | null {
  const normalized = utterance
    .toLowerCase()
    .replace(/[.,!?'"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  if (PAUSE_LISTENING.has(normalized)) return { kind: "pause_listening" };
  if (RESUME_LISTENING.has(normalized)) return { kind: "resume_listening" };
  if (QUIET_MODE.has(normalized)) return { kind: "quiet_mode" };
  if (ACTIVE_MODE.has(normalized)) return { kind: "active_mode" };
  if (STOP_SPEAKING.has(normalized)) return { kind: "stop_speaking" };
  return null;
}
