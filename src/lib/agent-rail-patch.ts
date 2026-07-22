import type {
  AgentConversationGroup,
  AgentConversationRecord,
  AgentRailConversationSummary,
} from "@/lib/agent-types";
import { isRenderableAgentRailConversation } from "@/lib/agent-rail";

export function agentRecordToRailSummary(
  c: AgentConversationRecord
): AgentRailConversationSummary {
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    lastEventSeq: c.lastEventSeq,
    status: c.status,
    archivedAt: c.archivedAt ?? null,
    backendId: c.config.backendId,
    mode: c.config.mode,
    experimental: c.experimental,
    hasPendingPermission: c.pendingPermission != null,
  };
}

/** Stable ordering: recency first, then creation time, then id (never title — renames must not reshuffle ties). */
function compareRailOrder(
  a: AgentRailConversationSummary,
  b: AgentRailConversationSummary
): number {
  if (b.updatedAt !== a.updatedAt) {
    return b.updatedAt - a.updatedAt;
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }
  return a.id.localeCompare(b.id);
}

function sortRailSummaries(list: AgentRailConversationSummary[]): AgentRailConversationSummary[] {
  return [...list].sort(compareRailOrder);
}

function mergeRailSummaryByRecency(
  existing: AgentRailConversationSummary,
  incoming: AgentRailConversationSummary
): AgentRailConversationSummary {
  if (incoming.updatedAt > existing.updatedAt) {
    return incoming;
  }
  if (incoming.updatedAt < existing.updatedAt) {
    if (incoming.lastEventSeq > existing.lastEventSeq) {
      return { ...incoming, updatedAt: existing.updatedAt };
    }
    const metaChanged =
      existing.status !== incoming.status ||
      existing.title !== incoming.title ||
      existing.archivedAt !== incoming.archivedAt ||
      existing.backendId !== incoming.backendId ||
      existing.mode !== incoming.mode ||
      existing.experimental !== incoming.experimental ||
      existing.hasPendingPermission !== incoming.hasPendingPermission;
    if (metaChanged) {
      return {
        ...existing,
        ...incoming,
        updatedAt: existing.updatedAt,
      };
    }
    return existing;
  }
  return incoming;
}

/** Merge a live server record into cross-workspace rail groups (in-place copy). */
export function patchAgentConversationGroups(
  groups: AgentConversationGroup[],
  record: AgentConversationRecord,
  serverId?: string
): AgentConversationGroup[] {
  const summary = agentRecordToRailSummary(record);
  if (!isRenderableAgentRailConversation(summary)) {
    return removeConversationFromAgentGroups(groups, record.id, record.workspaceId, serverId);
  }
  let touched = false;
  const next = groups.map((group) => {
    if (
      group.workspace.id !== record.workspaceId ||
      (serverId && group.serverId && group.serverId !== serverId)
    ) {
      return group;
    }
    touched = true;
    const scopedSummary: AgentRailConversationSummary = {
      ...summary,
      serverId: group.serverId ?? serverId,
      serverLabel: group.serverLabel,
      workspaceKey: group.workspaceKey,
      conversationKey:
        group.serverId || serverId ? `${group.serverId ?? serverId}:${summary.id}` : undefined,
      repositoryKey: group.repositoryKey,
      repository: group.repository,
    };
    const idx = group.conversations.findIndex((c) => c.id === record.id);
    if (idx >= 0) {
      const prev = group.conversations[idx]!;
      const merged = mergeRailSummaryByRecency(prev, scopedSummary);
      const replaced = group.conversations.slice();
      replaced[idx] = merged;
      if (merged.updatedAt === prev.updatedAt) {
        return { ...group, conversations: replaced };
      }
      return { ...group, conversations: sortRailSummaries(replaced) };
    }
    return {
      ...group,
      conversations: sortRailSummaries([...group.conversations, scopedSummary]),
    };
  });
  return touched ? next : groups;
}

export function removeConversationFromAgentGroups(
  groups: AgentConversationGroup[],
  conversationId: string,
  workspaceId: string,
  serverId?: string
): AgentConversationGroup[] {
  return groups.map((group) =>
    group.workspace.id !== workspaceId ||
    (serverId && group.serverId && group.serverId !== serverId)
      ? group
      : {
          ...group,
          conversations: group.conversations.filter((c) => c.id !== conversationId),
        }
  );
}

export function patchAgentConversationTitleInGroups(
  groups: AgentConversationGroup[],
  conversationId: string,
  title: string
): AgentConversationGroup[] {
  return groups.map((group) => ({
    ...group,
    conversations: group.conversations.map((c) =>
      c.id === conversationId ? { ...c, title } : c
    ),
  }));
}
