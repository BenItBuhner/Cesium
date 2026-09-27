import type {
  AgentConversationGroup,
  AgentRailConversationSummary,
} from "@/lib/agent-types";
import type { ServerRailAppearance } from "@/lib/global-settings";
import { getServerDisplayLabel } from "@/lib/server-rail-appearance";

/** What the sidebar calls each saved server, keyed by server id. */
export type ServerDisplayLabels = ReadonlyMap<string, string>;

export function buildServerDisplayLabels(
  servers: ReadonlyArray<{ id: string; label: string; baseUrl: string }>,
  appearances: Record<string, ServerRailAppearance>,
  engineNameById: Record<string, string>
): ServerDisplayLabels {
  return new Map(
    servers.map((server) => [
      server.id,
      getServerDisplayLabel(server, appearances[server.id], engineNameById[server.id]),
    ])
  );
}

export function sameServerDisplayLabels(a: ServerDisplayLabels, b: ServerDisplayLabels): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [serverId, label] of a) {
    if (b.get(serverId) !== label) {
      return false;
    }
  }
  return true;
}

// Rail rows are memoized on object identity, so a relabeled copy is reused for
// as long as its source object and label stay the same.
const relabeledConversations = new WeakMap<
  AgentRailConversationSummary,
  { label: string; value: AgentRailConversationSummary }
>();
const relabeledGroups = new WeakMap<
  AgentConversationGroup,
  { labels: ServerDisplayLabels; value: AgentConversationGroup }
>();
const relabeledRecords = new WeakMap<object, { label: string; value: object }>();

function relabelConversation(
  conversation: AgentRailConversationSummary,
  label: string | undefined
): AgentRailConversationSummary {
  if (label === undefined || conversation.serverLabel === label) {
    return conversation;
  }
  const cached = relabeledConversations.get(conversation);
  if (cached?.label === label) {
    return cached.value;
  }
  const value = { ...conversation, serverLabel: label };
  relabeledConversations.set(conversation, { label, value });
  return value;
}

function relabelGroup(
  group: AgentConversationGroup,
  labels: ServerDisplayLabels
): AgentConversationGroup {
  if (group.serverAuthRequired) {
    return group;
  }
  const cached = relabeledGroups.get(group);
  if (cached?.labels === labels) {
    return cached.value;
  }
  let conversationsChanged = false;
  const conversations = group.conversations.map((conversation) => {
    const serverId = conversation.serverId ?? group.serverId;
    const next = relabelConversation(conversation, serverId ? labels.get(serverId) : undefined);
    conversationsChanged ||= next !== conversation;
    return next;
  });
  const serverLabel = group.serverId ? labels.get(group.serverId) : undefined;
  const labelChanged = serverLabel !== undefined && serverLabel !== group.serverLabel;
  const value =
    labelChanged || conversationsChanged
      ? {
          ...group,
          serverLabel: labelChanged ? serverLabel : group.serverLabel,
          conversations: conversationsChanged ? conversations : group.conversations,
        }
      : group;
  relabeledGroups.set(group, { labels, value });
  return value;
}

/**
 * Shows each group and conversation under its server's display label.
 * Servers that are no longer saved keep the label they were listed with,
 * and the sign-in placeholders keep theirs. Returns `groups` itself when
 * nothing changes.
 */
export function relabelRailGroups(
  groups: AgentConversationGroup[],
  labels: ServerDisplayLabels
): AgentConversationGroup[] {
  if (labels.size === 0) {
    return groups;
  }
  let changed = false;
  const next = groups.map((group) => {
    const relabeled = relabelGroup(group, labels);
    changed ||= relabeled !== group;
    return relabeled;
  });
  return changed ? next : groups;
}

/** Same as `relabelRailGroups` for the workspace directory's records. */
export function relabelDirectoryWorkspaces<T extends { serverId: string; serverLabel: string }>(
  workspaces: T[],
  labels: ServerDisplayLabels
): T[] {
  if (labels.size === 0) {
    return workspaces;
  }
  let changed = false;
  const next = workspaces.map((workspace) => {
    const label = labels.get(workspace.serverId);
    if (label === undefined || label === workspace.serverLabel) {
      return workspace;
    }
    changed = true;
    const cached = relabeledRecords.get(workspace);
    if (cached?.label === label) {
      return cached.value as T;
    }
    const value = { ...workspace, serverLabel: label };
    relabeledRecords.set(workspace, { label, value });
    return value;
  });
  return changed ? next : workspaces;
}
