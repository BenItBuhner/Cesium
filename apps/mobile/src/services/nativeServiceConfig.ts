export type MobileFocusedConversations = {
  conversationId: string | null;
  activeConversationIds: string[];
};

/**
 * The native background socket exists only to keep active-run notifications
 * current while the WebView is suspended. An idle focused chat is reconciled
 * by the WebView on resume and must not keep a second connection alive.
 */
export function backgroundAgentConversationIds(
  focused: MobileFocusedConversations
): string[] {
  return [
    ...new Set(
      focused.activeConversationIds.filter(
        (conversationId): conversationId is string =>
          typeof conversationId === "string" && conversationId.length > 0
      )
    ),
  ];
}
