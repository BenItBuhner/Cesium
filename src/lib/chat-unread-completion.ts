import type { AgentConversationRecord } from "@/lib/agent-types";
import type { WorkspaceSessionState } from "@/lib/workspace-session";

/** True when this conversation is visible in the focused chat tab or active editor tab. */
export function isAgentConversationTabVisible(
  session: WorkspaceSessionState,
  conversationId: string
): boolean {
  const activeChat = session.chat.tabs.find((t) => t.active);
  if (activeChat?.id === conversationId) {
    return true;
  }
  const { leftTabs, rightTabs, leftActiveId, rightActiveId } = session.editor;
  const leftTab = leftTabs.find((t) => t.id === leftActiveId);
  if (leftTab?.conversationId === conversationId) {
    return true;
  }
  const rightTab = rightTabs.find((t) => t.id === rightActiveId);
  if (rightTab?.conversationId === conversationId) {
    return true;
  }
  return false;
}

export type UnreadCompletionByConversationId = Record<string, true>;

/**
 * Updates the unread-completion map when a conversation becomes idle or when the user
 * is viewing an idle conversation (clears stale flag). Returns null if the map is unchanged.
 */
export function nextUnreadCompletionMap(
  session: WorkspaceSessionState,
  previous: AgentConversationRecord | undefined,
  merged: AgentConversationRecord
): UnreadCompletionByConversationId | null {
  const id = merged.id;
  const before = session.chat.unreadChatCompletionByConversationId ?? {};
  const next = { ...before } as UnreadCompletionByConversationId;
  let dirty = false;

  const transitionedToIdle =
    Boolean(previous?.status) &&
    previous!.status !== "idle" &&
    merged.status === "idle";

  if (transitionedToIdle) {
    if (isAgentConversationTabVisible(session, id)) {
      if (next[id]) {
        delete next[id];
        dirty = true;
      }
    } else {
      if (!next[id]) {
        next[id] = true;
        dirty = true;
      }
    }
  } else if (merged.status === "idle" && isAgentConversationTabVisible(session, id) && next[id]) {
    delete next[id];
    dirty = true;
  }

  if (!dirty) {
    return null;
  }

  return next;
}
