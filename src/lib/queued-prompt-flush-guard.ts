/** Prevents two surfaces (e.g. chat panel + agent editor) from popping the same queue twice. */
const flushingConversationIds = new Set<string>();

export function tryBeginQueuedPromptFlush(conversationId: string): boolean {
  if (flushingConversationIds.has(conversationId)) {
    return false;
  }
  flushingConversationIds.add(conversationId);
  return true;
}

export function endQueuedPromptFlush(conversationId: string): void {
  flushingConversationIds.delete(conversationId);
}
