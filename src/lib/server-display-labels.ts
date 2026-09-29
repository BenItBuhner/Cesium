import { projectListingEngineName, type ProjectListing } from "@cesium/core";
import type {
  AgentConversationGroup,
  AgentRailConversationSummary,
} from "@/lib/agent-types";
import type { ServerRailAppearance } from "@/lib/global-settings";
import { getServerDisplayLabel } from "@/lib/server-rail-appearance";

/** What the sidebar calls each saved server, keyed by server id. */
export type ServerDisplayLabels = ReadonlyMap<string, string>;

/**
 * What every surface calls `server`: "This device", then the user's rename,
 * then the name the engine reports, then the connection label.
 */
export function serverDisplayLabel(
  server: { id: string; label: string; baseUrl: string },
  appearances: Readonly<Record<string, Pick<ServerRailAppearance, "nickname">>>,
  engineNameById: Readonly<Record<string, string>>
): string {
  return getServerDisplayLabel(server, appearances[server.id], engineNameById[server.id]);
}

export function buildServerDisplayLabels(
  servers: ReadonlyArray<{ id: string; label: string; baseUrl: string }>,
  appearances: Record<string, ServerRailAppearance>,
  engineNameById: Record<string, string>
): ServerDisplayLabels {
  return new Map(
    servers.map((server) => [server.id, serverDisplayLabel(server, appearances, engineNameById)])
  );
}

export type ServerSwitchCommand = {
  serverId: string;
  label: string;
  detail: string;
  active: boolean;
  /** The toast when it runs. */
  message: string;
};

/** The command palette's "Server: Switch to …" entries. */
export function serverSwitchCommands(
  servers: ReadonlyArray<{ id: string; label: string; baseUrl: string }>,
  activeServerId: string,
  labelFor: (server: { id: string; label: string; baseUrl: string }) => string
): ServerSwitchCommand[] {
  return servers.map((server) => {
    const name = labelFor(server);
    const active = server.id === activeServerId;
    return {
      serverId: server.id,
      label: `Server: Switch to ${name}${active ? " (Active)" : ""}`,
      detail: server.baseUrl,
      active,
      message: active ? `${name} is already active` : `Switching to ${name}`,
    };
  });
}

/**
 * What a Project listing calls the server it came from, in the same order.
 * The name the engine reported with the listing stands in until the client
 * has learned the engine's name itself.
 */
export function projectListingServerLabel(
  listing: Pick<ProjectListing, "serverId" | "serverLabel" | "engineLabel">,
  servers: ReadonlyArray<{ id: string; label: string; baseUrl: string }>,
  appearances: Readonly<Record<string, Pick<ServerRailAppearance, "nickname">>>,
  engineNameById: Readonly<Record<string, string>>
): string {
  const server = servers.find((entry) => entry.id === listing.serverId);
  if (!server) {
    return projectListingEngineName(listing);
  }
  return getServerDisplayLabel(
    server,
    appearances[server.id],
    engineNameById[server.id] ?? listing.engineLabel
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

/** A sign-in placeholder is titled with its server's name; its badge stays "Auth required". */
function relabelSignInPlaceholder(
  group: AgentConversationGroup,
  labels: ServerDisplayLabels
): AgentConversationGroup {
  const label = group.serverId ? labels.get(group.serverId) : undefined;
  if (label === undefined || label === group.workspace.name) {
    return group;
  }
  const cached = relabeledGroups.get(group);
  if (cached?.labels === labels) {
    return cached.value;
  }
  const value = { ...group, workspace: { ...group.workspace, name: label } };
  relabeledGroups.set(group, { labels, value });
  return value;
}

function relabelGroup(
  group: AgentConversationGroup,
  labels: ServerDisplayLabels
): AgentConversationGroup {
  if (group.serverAuthRequired) {
    return relabelSignInPlaceholder(group, labels);
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
 * Shows each group and conversation under its server's display label, and
 * titles sign-in placeholders with it. Servers that are no longer saved keep
 * the label they were listed with. Returns `groups` itself when nothing
 * changes.
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
