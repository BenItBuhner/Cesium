export function resolveAgentRightPaneOpen({
  isDraftConversationSelected,
  persistedRightPaneOpen,
  draftRightPaneExplicitlyOpen,
}: {
  isDraftConversationSelected: boolean;
  persistedRightPaneOpen: boolean;
  draftRightPaneExplicitlyOpen: boolean;
}): boolean {
  return isDraftConversationSelected
    ? draftRightPaneExplicitlyOpen
    : persistedRightPaneOpen;
}

/**
 * Switching conversations always lands on chat. Persisted tabs stay, but the
 * workbench pane must not pop back open just because that conversation already
 * had a plan, browser, or file sitting in it.
 */
export function shouldRestorePersistedRightPaneOpen(): boolean {
  return false;
}
