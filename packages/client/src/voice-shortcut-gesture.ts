/**
 * Unified voice-transcription shortcut: a tap latches recording, a hold
 * records only until release. Key-repeat while held must not toggle again.
 */
export const VOICE_SHORTCUT_HOLD_MS = 250;

export type VoiceShortcutGestureState = {
  pendingRelease: boolean;
  downAt: number | null;
};

export type VoiceShortcutKeyDownAction = "toggle" | "none";
export type VoiceShortcutKeyUpAction = "stop" | "none";

export function createVoiceShortcutGestureState(): VoiceShortcutGestureState {
  return { pendingRelease: false, downAt: null };
}

export function applyVoiceShortcutKeyDown(
  state: VoiceShortcutGestureState,
  now: number
): VoiceShortcutKeyDownAction {
  if (state.pendingRelease) {
    return "none";
  }
  state.pendingRelease = true;
  state.downAt = now;
  return "toggle";
}

export function applyVoiceShortcutKeyUp(
  state: VoiceShortcutGestureState,
  now: number
): VoiceShortcutKeyUpAction {
  if (!state.pendingRelease) {
    return "none";
  }
  const downAt = state.downAt ?? now;
  state.pendingRelease = false;
  state.downAt = null;
  if (now - downAt >= VOICE_SHORTCUT_HOLD_MS) {
    return "stop";
  }
  return "none";
}
