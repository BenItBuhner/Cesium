import type { AgentConversationRecord } from "@/lib/agent-types";

export const AGENT_CONVERSATION_UPSERTED_EVENT = "opencursor:agent_conversation_upserted";

export const AGENT_CONVERSATION_DELETED_EVENT = "opencursor:agent_conversation_deleted";

export type AgentConversationDeletedDetail = {
  conversationId: string;
  workspaceId: string;
  serverId?: string;
};

export type AgentConversationUpsertedDetail = AgentConversationRecord & {
  serverId?: string;
};

export function dispatchAgentConversationUpserted(
  conversation: AgentConversationRecord,
  serverId?: string
): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<AgentConversationUpsertedDetail>(AGENT_CONVERSATION_UPSERTED_EVENT, {
      detail: serverId ? { ...conversation, serverId } : conversation,
    })
  );
}

export function dispatchAgentConversationDeleted(detail: AgentConversationDeletedDetail): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<AgentConversationDeletedDetail>(AGENT_CONVERSATION_DELETED_EVENT, {
      detail,
    })
  );
}
