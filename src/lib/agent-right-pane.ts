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
