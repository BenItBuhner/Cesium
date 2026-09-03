import {
  STEER_MESSAGE_COMMAND_ID,
  eventMatchesShortcutCommand,
  type KeyboardShortcutBindingsMap,
  type ShortcutPlatform,
} from "@/lib/keyboard-shortcuts";

export type ComposerSteerKeyState = Pick<
  KeyboardEvent,
  "key" | "code" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey"
>;

export type ComposerSteerKeyOptions = {
  hasHardwareKeyboard: boolean;
  bindings: KeyboardShortcutBindingsMap | undefined;
  platform: ShortcutPlatform;
  obstructed: boolean;
};

export function shouldSteerComposerOnKey(
  event: ComposerSteerKeyState,
  options: ComposerSteerKeyOptions
): boolean {
  if (!options.hasHardwareKeyboard || options.obstructed) {
    return false;
  }

  return eventMatchesShortcutCommand(
    event as KeyboardEvent,
    STEER_MESSAGE_COMMAND_ID,
    options.bindings,
    options.platform
  );
}
