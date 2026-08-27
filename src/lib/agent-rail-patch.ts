import type {
  AgentConversationGroup,
  AgentConversationRecord,
  AgentRailConversationSummary,
} from "@/lib/agent-types";
import { isRenderableAgentRailConversation } from "@/lib/agent-rail";

/** Rail rows show at most one short line of detail; mirror the server-side cap. */
const RAIL_DETAIL_MAX_LENGTH = 140;

function summarizeRailDetailText(text: string | null | undefined): string | null {
  if (!text) {
    return null;
  }
  const firstLine = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine) {
    return null;
  }
  return firstLine.length > RAIL_DETAIL_MAX_LENGTH
    ? `${firstLine.slice(0, RAIL_DETAIL_MAX_LENGTH - 1)}…`
    : firstLine;
}

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
    settledAt: c.settledAt ?? null,
    settledUntil: c.settledUntil ?? null,
    backendId: c.config.backendId,
    mode: c.config.mode,
    experimental: c.experimental,
    hasPendingPermission: c.pendingPermission != null,
    hasPendingQuestion: c.pendingQuestion != null,
    pendingPermissionTitle: summarizeRailDetailText(c.pendingPermission?.title),
    lastErrorSummary: summarizeRailDetailText(c.lastError),
    ...(c.origin ? { origin: c.origin } : {}),
  };
}

function originMergeKey(
  origin: AgentRailConversationSummary["origin"] | undefined
): string | null {
  if (!origin) {
    return null;
  }
  if (origin.kind === "cloud") {
    return `cloud:${origin.providerId}`;
  }
  if (origin.kind === "cloud-snapshot") {
    return `cloud-snapshot:${origin.snapshotKey}`;
  }
  if (origin.kind === "trigger") {
    return `trigger:${origin.triggerId}:${origin.firedAt}`;
  }
  return `import:${origin.backendId}:${origin.externalSessionId}`;
}

/** Stable ordering: recency first, then creation time, then id (never title - renames must not reshuffle ties). */
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
      return {
        ...incoming,
        archivedAt: existing.archivedAt,
        settledAt: existing.settledAt,
        settledUntil: existing.settledUntil,
        updatedAt: existing.updatedAt,
      };
    }
    const metaChanged =
      existing.status !== incoming.status ||
      existing.title !== incoming.title ||
      existing.archivedAt !== incoming.archivedAt ||
      (existing.settledAt ?? null) !== (incoming.settledAt ?? null) ||
      (existing.settledUntil ?? null) !== (incoming.settledUntil ?? null) ||
      existing.backendId !== incoming.backendId ||
      existing.mode !== incoming.mode ||
      existing.experimental !== incoming.experimental ||
      existing.hasPendingPermission !== incoming.hasPendingPermission ||
      (existing.hasPendingQuestion ?? false) !== (incoming.hasPendingQuestion ?? false) ||
      (existing.pendingPermissionTitle ?? null) !== (incoming.pendingPermissionTitle ?? null) ||
      (existing.lastErrorSummary ?? null) !== (incoming.lastErrorSummary ?? null) ||
      originMergeKey(existing.origin) !== originMergeKey(incoming.origin);
    if (metaChanged) {
      return {
        ...existing,
        ...incoming,
        archivedAt: existing.archivedAt,
        settledAt: existing.settledAt,
        settledUntil: existing.settledUntil,
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

/**
 * Patch one rail row without waiting for a full server record.
 *
 * Conversation ids can collide across connected servers, so every optimistic
 * mutation must stay scoped to the row's workspace and server.
 */
export function patchAgentConversationSummaryInGroups(
  groups: AgentConversationGroup[],
  target: AgentRailConversationSummary,
  patch: Partial<AgentRailConversationSummary>
): AgentConversationGroup[] {
  let changed = false;
  const next = groups.map((group) => {
    if (
      group.workspace.id !== target.workspaceId ||
      (target.serverId && group.serverId && group.serverId !== target.serverId)
    ) {
      return group;
    }
    const index = group.conversations.findIndex(
      (conversation) =>
        conversation.id === target.id &&
        (!target.conversationKey || conversation.conversationKey === target.conversationKey)
    );
    if (index < 0) {
      return group;
    }
    changed = true;
    const conversations = group.conversations.slice();
    conversations[index] = { ...conversations[index]!, ...patch };
    return {
      ...group,
      conversations:
        patch.updatedAt == null ? conversations : sortRailSummaries(conversations),
    };
  });
  return changed ? next : groups;
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
