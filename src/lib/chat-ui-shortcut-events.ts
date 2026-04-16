/** Dispatched from keyboard shortcut layer; composer / workspace UI subscribe. */
export const CHAT_UI_SHORTCUT_EVENT = "opencursor:chatUiShortcut" as const;

export type ChatComposerShortcutAction =
  | "openModelDropdown"
  | "openModeDropdown"
  | "openBackendDropdown"
  | "toggleVoiceInput"
  | "toggleComposerExpand"
  | "attachImage";

export type ChatUiShortcutEventDetail =
  | { target: "composer"; action: ChatComposerShortcutAction }
  | { target: "workspacePicker" };

export function dispatchChatComposerShortcut(action: ChatComposerShortcutAction): void {
  window.dispatchEvent(
    new CustomEvent<ChatUiShortcutEventDetail>(CHAT_UI_SHORTCUT_EVENT, {
      detail: { target: "composer", action },
    })
  );
}

export function dispatchWorkspacePickerShortcut(): void {
  window.dispatchEvent(
    new CustomEvent<ChatUiShortcutEventDetail>(CHAT_UI_SHORTCUT_EVENT, {
      detail: { target: "workspacePicker" },
    })
  );
}

export function isChatUiShortcutEvent(
  event: Event
): event is CustomEvent<ChatUiShortcutEventDetail> {
  return event.type === CHAT_UI_SHORTCUT_EVENT;
}
