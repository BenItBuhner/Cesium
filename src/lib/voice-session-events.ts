/**
 * Window-event bridge for the conversation-bound voice agent session. Launch
 * surfaces (keyboard shortcut, command palette, quick actions, landing button)
 * dispatch commands here; `VoiceSessionProvider` subscribes. Mirrors the
 * `chat-ui-shortcut-events` pattern so callers never need provider context.
 */
export const VOICE_SESSION_EVENT = "opencursor:voiceSession" as const;

export type VoiceSessionCommand =
  | "start"
  | "stop"
  | "minimize"
  | "expand"
  | "toggle";

export type VoiceSessionEventDetail = {
  command: VoiceSessionCommand;
};

export function dispatchVoiceSessionCommand(command: VoiceSessionCommand): void {
  window.dispatchEvent(
    new CustomEvent<VoiceSessionEventDetail>(VOICE_SESSION_EVENT, {
      detail: { command },
    })
  );
}

export function isVoiceSessionEvent(
  event: Event
): event is CustomEvent<VoiceSessionEventDetail> {
  return event.type === VOICE_SESSION_EVENT;
}
