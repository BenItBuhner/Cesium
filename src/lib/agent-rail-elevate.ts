import type {
  AgentConversationGroup,
  AgentRailConversationSummary,
} from "@/lib/agent-types";
import {
  agentRailConversationIsSettled,
  agentRailConversationNeedsAttention,
  compareAgentRailByStatusPriority,
  getAgentRailStatusKind,
  type AgentRailStatusContext,
} from "@/lib/agent-rail-status";
import { getRailConversationKey } from "@/lib/agent-rail-bulk-select";

export type AgentRailElevateContext = {
  unreadCompletionByConversationId?: Record<string, true>;
  acknowledgedFailureByConversationId?: Record<string, true>;
};

export function agentRailStatusContextForConversation(
  conversation: Pick<AgentRailConversationSummary, "id">,
  ctx: AgentRailElevateContext
): AgentRailStatusContext {
  return {
    unreadCompletion: Boolean(ctx.unreadCompletionByConversationId?.[conversation.id]),
    acknowledgedFailure: Boolean(ctx.acknowledgedFailureByConversationId?.[conversation.id]),
  };
}

export function conversationHasAttentionHome(
  conversation: Pick<
    AgentRailConversationSummary,
    "id" | "status" | "hasPendingPermission" | "hasPendingQuestion" | "settledAt"
  >,
  ctx: AgentRailElevateContext = {}
): boolean {
  return agentRailConversationNeedsAttention(
    conversation,
    agentRailStatusContextForConversation(conversation, ctx)
  );
}

/**
 * Actively working (running/pausing) and not already homed in Needs attention.
 * Settled runners stay in their home group: the user explicitly tucked them
 * away, so they keep their spinner but are not promoted.
 */
export function conversationHasRunningHome(
  conversation: Pick<
    AgentRailConversationSummary,
    "id" | "status" | "hasPendingPermission" | "hasPendingQuestion" | "settledAt"
  >,
  ctx: AgentRailElevateContext = {}
): boolean {
  if (conversationHasAttentionHome(conversation, ctx)) {
    return false;
  }
  if (agentRailConversationIsSettled(conversation)) {
    return false;
  }
  const kind = getAgentRailStatusKind(
    conversation,
    agentRailStatusContextForConversation(conversation, ctx)
  );
  return kind === "running" || kind === "pausing";
}

function collectFromGroups(
  groups: AgentConversationGroup[],
  ctx: AgentRailElevateContext,
  predicate: (
    conversation: AgentRailConversationSummary,
    ctx: AgentRailElevateContext
  ) => boolean
): Map<string, AgentRailConversationSummary> {
  const byKey = new Map<string, AgentRailConversationSummary>();
  for (const group of groups) {
    for (const conversation of group.conversations) {
      if (predicate(conversation, ctx)) {
        byKey.set(getRailConversationKey(conversation), conversation);
      }
    }
  }
  return byKey;
}

function collectElevatedConversations(
  groups: AgentConversationGroup[],
  extra: AgentRailConversationSummary[],
  ctx: AgentRailElevateContext,
  predicate: (
    conversation: AgentRailConversationSummary,
    ctx: AgentRailElevateContext
  ) => boolean
): AgentRailConversationSummary[] {
  const byKey = collectFromGroups(groups, ctx, predicate);
  for (const conversation of extra) {
    if (predicate(conversation, ctx)) {
      byKey.set(getRailConversationKey(conversation), conversation);
    }
  }
  return [...byKey.values()].sort((a, b) => compareAgentRailByStatusPriority(a, b, ctx));
}

/**
 * Cross-workspace inbox: permission, question, or unread failure.
 * Attention wins over pinned — each conversation has one home.
 */
export function collectAttentionConversations(
  groups: AgentConversationGroup[],
  extra: AgentRailConversationSummary[],
  ctx: AgentRailElevateContext = {}
): AgentRailConversationSummary[] {
  return collectElevatedConversations(groups, extra, ctx, conversationHasAttentionHome);
}

/**
 * Cross-workspace list of actively working agents. Ranks right below Needs
 * attention: the user will likely return to these next, so they must never be
 * buried inside workspace groups. Attention wins when a runner is blocked.
 */
export function collectRunningConversations(
  groups: AgentConversationGroup[],
  extra: AgentRailConversationSummary[],
  ctx: AgentRailElevateContext = {}
): AgentRailConversationSummary[] {
  return collectElevatedConversations(groups, extra, ctx, conversationHasRunningHome);
}

export function attentionConversationIdSet(
  conversations: AgentRailConversationSummary[]
): Set<string> {
  return new Set(conversations.map((conversation) => conversation.id));
}

/** Strip elevated (attention/running) rows from the pinned list so each row has one home. */
export function stripAttentionFromPinned(
  pinned: AgentRailConversationSummary[],
  attentionIds: Set<string>
): AgentRailConversationSummary[] {
  if (attentionIds.size === 0) {
    return pinned;
  }
  return pinned.filter((conversation) => !attentionIds.has(conversation.id));
}

/**
 * Remove elevated rows from home groups. Attention first, then running, then
 * pins. Empty groups stay so a scoped workspace with only elevated chats still
 * has a header.
 */
export function stripElevatedFromGroups(
  groups: AgentConversationGroup[],
  elevatedIds: Set<string>,
  pinnedIds: Set<string>
): AgentConversationGroup[] {
  if (elevatedIds.size === 0 && pinnedIds.size === 0) {
    return groups;
  }
  return groups.map((group) => ({
    ...group,
    conversations: group.conversations.filter(
      (conversation) =>
        !elevatedIds.has(conversation.id) && !pinnedIds.has(conversation.id)
    ),
  }));
}

/**
 * Stable partition: settled conversations sink below everything else in their
 * home group while both partitions keep their existing relative order.
 */
export function sinkSettledInGroups(
  groups: AgentConversationGroup[]
): AgentConversationGroup[] {
  return groups.map((group) => {
    if (!group.conversations.some((c) => agentRailConversationIsSettled(c))) {
      return group;
    }
    const unsettled: AgentRailConversationSummary[] = [];
    const settled: AgentRailConversationSummary[] = [];
    for (const conversation of group.conversations) {
      (agentRailConversationIsSettled(conversation) ? settled : unsettled).push(
        conversation
      );
    }
    return { ...group, conversations: [...unsettled, ...settled] };
  });
}
