import { clientKeyValueStore, getClientPlatform, getServerConnectionKey } from "@cesium/client";
import type {
  AgentConversationGroup,
  AgentRailConversationSummary,
} from "@/lib/agent-types";
import { getRepositoryGroupingKey } from "@/lib/multi-server-workspaces";

/**
 * Conversation catalogs - the rail listing of one engine, remembered so the
 * rail keeps showing that engine's conversations while it is unreachable.
 *
 * Engines own conversations; the workbench merely lists them. That was fine
 * for always-on machines, but GitHub Codespaces idle out within hours, and
 * every device then showed the codespace's conversations vanishing. Now each
 * successful live fetch is captured as a catalog, written to this device's
 * storage and mirrored to the account (Convex `conversationCatalogs`), and
 * whenever a fetch fails the freshest catalog stands in - flagged offline so
 * opening a row wakes the engine first.
 *
 * Everything here is pure or storage-only; React wiring lives in the rail.
 */

export const CONVERSATION_CATALOG_VERSION = 1;
export const CONVERSATION_CATALOG_STORAGE_KEY = "opencursor.conversation-catalog.v1";
export const CONVERSATION_CATALOG_EVENT = "opencursor:conversation-catalog-changed";

/**
 * Per-catalog payload ceiling (JSON chars). Comfortably inside Convex's
 * document limit and keeps a handful of engines within localStorage quota;
 * roughly a thousand rail rows. Older conversations are dropped first.
 */
export const MAX_CATALOG_PAYLOAD_CHARS = 400_000;

export type ConversationCatalog = {
  /** Durable engine identity - see {@link conversationCatalogServerKey}. */
  serverKey: string;
  serverName: string;
  baseUrl: string;
  /** Rail groups with device-local annotations stripped (re-applied on read). */
  groups: AgentConversationGroup[];
  conversationCount: number;
  /** Newest `updatedAt` among the catalogued conversations. */
  sourceUpdatedAt: number;
  /** When this listing was captured (or, for cloud copies, last written). */
  updatedAt: number;
};

export type ConversationCatalogStore = Record<string, ConversationCatalog>;

export type CloudConversationCatalogRow = {
  serverKey: string;
  serverName: string;
  baseUrl: string;
  payload: string;
  conversationCount: number;
  sourceUpdatedAt: number;
  updatedAt: number;
};

type ServerLike = { id: string; label: string; baseUrl: string };

/* ------------------------------------------------------------------------ */
/* Identity                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Codespace pairings survive recreation under a new codespace name (and thus
 * a new base URL), so they are keyed by repository; everything else by its
 * canonical connection key.
 */
export function conversationCatalogServerKey(
  server: Pick<ServerLike, "baseUrl">,
  codespaceDevices: ReadonlyArray<{ baseUrl: string; repoFullName: string }> = []
): string | null {
  let connectionKey: string;
  try {
    connectionKey = getServerConnectionKey(server.baseUrl);
  } catch {
    return null;
  }
  for (const device of codespaceDevices) {
    try {
      if (getServerConnectionKey(device.baseUrl) === connectionKey) {
        return `codespace:${device.repoFullName}`;
      }
    } catch {
      continue;
    }
  }
  return `url:${connectionKey}`;
}

/* ------------------------------------------------------------------------ */
/* Annotation                                                               */
/* ------------------------------------------------------------------------ */

const ANNOTATION_KEYS = [
  "serverId",
  "serverLabel",
  "workspaceKey",
  "conversationKey",
  "repositoryKey",
  "serverOffline",
] as const;

/**
 * Stamp rail groups with the owning connection so the cross-server rail can
 * tell machines apart. Shared by the live fetch path and the catalog restore
 * path: connection ids are device-local, so catalogs persist unannotated
 * groups and re-annotate against the reading device's connection.
 */
export function annotateRailGroupsForServer(
  groups: AgentConversationGroup[],
  server: ServerLike
): AgentConversationGroup[] {
  return groups.map((group) => {
    const workspaceKey = `${server.id}:${group.workspace.id}`;
    const repositoryKey = group.repository?.isGitRepo
      ? getRepositoryGroupingKey({
          repository: group.repository,
          serverId: server.id,
          fallbackRoot: group.workspace.root,
        })
      : undefined;
    return {
      ...group,
      serverId: server.id,
      serverLabel: server.label,
      workspaceKey,
      ...(repositoryKey ? { repositoryKey } : {}),
      conversations: group.conversations.map((conversation) => {
        const repository = conversation.repository ?? group.repository;
        return {
          ...conversation,
          serverId: server.id,
          serverLabel: server.label,
          workspaceKey,
          conversationKey: `${server.id}:${conversation.id}`,
          ...(repositoryKey ? { repositoryKey } : {}),
          ...(repository ? { repository } : {}),
        };
      }),
    };
  });
}

function stripAnnotations(groups: AgentConversationGroup[]): AgentConversationGroup[] {
  return groups.map((group) => {
    const bare: Record<string, unknown> = { ...group };
    for (const key of ANNOTATION_KEYS) {
      delete bare[key];
    }
    delete bare.serverIds;
    delete bare.serverCachedAt;
    delete bare.serverAuthRequired;
    bare.conversations = group.conversations.map((conversation) => {
      const row: Record<string, unknown> = { ...conversation };
      for (const key of ANNOTATION_KEYS) {
        delete row[key];
      }
      return row as unknown as AgentRailConversationSummary;
    });
    return bare as unknown as AgentConversationGroup;
  });
}

/* ------------------------------------------------------------------------ */
/* Building                                                                 */
/* ------------------------------------------------------------------------ */

function countConversations(groups: AgentConversationGroup[]): number {
  return groups.reduce((sum, group) => sum + group.conversations.length, 0);
}

function newestUpdatedAt(groups: AgentConversationGroup[]): number {
  let newest = 0;
  for (const group of groups) {
    for (const conversation of group.conversations) {
      if (conversation.updatedAt > newest) {
        newest = conversation.updatedAt;
      }
    }
  }
  return newest;
}

/**
 * Drop the oldest conversations until the serialized listing fits the
 * payload ceiling. Groups are kept (even when emptied) so the workspace still
 * appears in the rail with a "more on the engine" feel rather than vanishing.
 */
export function trimCatalogGroupsToFit(
  groups: AgentConversationGroup[],
  maxChars = MAX_CATALOG_PAYLOAD_CHARS
): AgentConversationGroup[] {
  let current = groups;
  let serialized = JSON.stringify(current);
  while (serialized.length > maxChars) {
    const total = countConversations(current);
    if (total === 0) {
      return current;
    }
    // Remove the oldest ~20% in one pass; JSON.stringify per row is the cost.
    const cutoffCount = Math.max(1, Math.floor(total * 0.2));
    const oldest = current
      .flatMap((group) => group.conversations.map((conversation) => conversation.updatedAt))
      .sort((a, b) => a - b)[cutoffCount - 1]!;
    current = current.map((group) => ({
      ...group,
      conversations: group.conversations.filter(
        (conversation) => conversation.updatedAt > oldest
      ),
    }));
    if (countConversations(current) === total) {
      // Every remaining row shares the same timestamp; hard-cut instead.
      current = current.map((group) => ({
        ...group,
        conversations: group.conversations.slice(0, Math.floor(group.conversations.length / 2)),
      }));
    }
    serialized = JSON.stringify(current);
  }
  return current;
}

export function buildConversationCatalog(input: {
  serverKey: string;
  server: Pick<ServerLike, "label" | "baseUrl">;
  groups: AgentConversationGroup[];
  now?: number;
}): ConversationCatalog {
  const groups = trimCatalogGroupsToFit(stripAnnotations(input.groups));
  return {
    serverKey: input.serverKey,
    serverName: input.server.label,
    baseUrl: input.server.baseUrl,
    groups,
    conversationCount: countConversations(groups),
    sourceUpdatedAt: newestUpdatedAt(groups),
    updatedAt: input.now ?? Date.now(),
  };
}

/** Structural fingerprint used to skip redundant cloud pushes. */
export function conversationCatalogSignature(catalog: ConversationCatalog): string {
  return `${catalog.serverKey}\0${catalog.conversationCount}\0${catalog.sourceUpdatedAt}\0${serializeConversationCatalogPayload(catalog).length}`;
}

/* ------------------------------------------------------------------------ */
/* Payload (cloud wire format)                                              */
/* ------------------------------------------------------------------------ */

export function serializeConversationCatalogPayload(catalog: ConversationCatalog): string {
  return JSON.stringify({ version: CONVERSATION_CATALOG_VERSION, groups: catalog.groups });
}

export function parseConversationCatalogPayload(payload: string): AgentConversationGroup[] | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const groups = (parsed as { groups?: unknown }).groups;
    if (!Array.isArray(groups)) {
      return null;
    }
    return groups.filter(isGroupShaped);
  } catch {
    return null;
  }
}

function isGroupShaped(value: unknown): value is AgentConversationGroup {
  if (!value || typeof value !== "object") {
    return false;
  }
  const group = value as { workspace?: unknown; conversations?: unknown };
  return (
    Boolean(group.workspace) &&
    typeof group.workspace === "object" &&
    typeof (group.workspace as { id?: unknown }).id === "string" &&
    Array.isArray(group.conversations)
  );
}

export function cloudRowToCatalog(row: CloudConversationCatalogRow): ConversationCatalog | null {
  const groups = parseConversationCatalogPayload(row.payload);
  if (!groups) {
    return null;
  }
  return {
    serverKey: row.serverKey,
    serverName: row.serverName,
    baseUrl: row.baseUrl,
    groups,
    conversationCount: row.conversationCount,
    sourceUpdatedAt: row.sourceUpdatedAt,
    updatedAt: row.updatedAt,
  };
}

/* ------------------------------------------------------------------------ */
/* Local store                                                              */
/* ------------------------------------------------------------------------ */

export function readConversationCatalogStore(): ConversationCatalogStore {
  const raw = clientKeyValueStore().getItem(CONVERSATION_CATALOG_STORAGE_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const { version, catalogs } = parsed as { version?: unknown; catalogs?: unknown };
    if (version !== CONVERSATION_CATALOG_VERSION || !catalogs || typeof catalogs !== "object") {
      return {};
    }
    const store: ConversationCatalogStore = {};
    for (const [serverKey, value] of Object.entries(catalogs as Record<string, unknown>)) {
      if (isCatalogShaped(value)) {
        store[serverKey] = value;
      }
    }
    return store;
  } catch {
    return {};
  }
}

function isCatalogShaped(value: unknown): value is ConversationCatalog {
  if (!value || typeof value !== "object") {
    return false;
  }
  const catalog = value as Partial<ConversationCatalog>;
  return (
    typeof catalog.serverKey === "string" &&
    typeof catalog.baseUrl === "string" &&
    Array.isArray(catalog.groups) &&
    typeof catalog.updatedAt === "number"
  );
}

export function writeConversationCatalogStore(store: ConversationCatalogStore): void {
  const kv = clientKeyValueStore();
  const serialized = JSON.stringify({ version: CONVERSATION_CATALOG_VERSION, catalogs: store });
  try {
    kv.setItem(CONVERSATION_CATALOG_STORAGE_KEY, serialized);
  } catch {
    // Quota exceeded: keep only the freshest catalog rather than nothing.
    const freshest = Object.values(store).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!freshest) {
      return;
    }
    try {
      kv.setItem(
        CONVERSATION_CATALOG_STORAGE_KEY,
        JSON.stringify({
          version: CONVERSATION_CATALOG_VERSION,
          catalogs: { [freshest.serverKey]: freshest },
        })
      );
    } catch {
      return;
    }
  }
  getClientPlatform().emitEvent(CONVERSATION_CATALOG_EVENT);
}

/** Upsert one catalog locally; returns the resulting store. */
export function upsertConversationCatalog(catalog: ConversationCatalog): ConversationCatalogStore {
  const store = readConversationCatalogStore();
  const existing = store[catalog.serverKey];
  if (existing && existing.updatedAt > catalog.updatedAt) {
    return store;
  }
  const next = { ...store, [catalog.serverKey]: catalog };
  writeConversationCatalogStore(next);
  return next;
}

export function removeConversationCatalog(serverKey: string): void {
  const store = readConversationCatalogStore();
  if (!(serverKey in store)) {
    return;
  }
  const next = { ...store };
  delete next[serverKey];
  writeConversationCatalogStore(next);
}

/**
 * Fold the account's catalogs into the local store: per engine, the copy
 * written most recently wins. Returns whether anything changed so callers
 * can skip a redundant write.
 */
export function mergeCloudCatalogsIntoStore(
  store: ConversationCatalogStore,
  rows: ReadonlyArray<CloudConversationCatalogRow>
): { store: ConversationCatalogStore; changed: boolean } {
  let changed = false;
  const next = { ...store };
  for (const row of rows) {
    const incoming = cloudRowToCatalog(row);
    if (!incoming) {
      continue;
    }
    const existing = next[incoming.serverKey];
    if (existing && existing.updatedAt >= incoming.updatedAt) {
      continue;
    }
    next[incoming.serverKey] = incoming;
    changed = true;
  }
  return { store: changed ? next : store, changed };
}

/* ------------------------------------------------------------------------ */
/* Offline projection                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Statuses that cannot be true of a conversation on an engine that is not
 * running: a sleeping codespace has no live provider runtime, and the engine
 * itself marks these runs interrupted the moment it boots again.
 */
const LIVE_ONLY_STATUSES = new Set<AgentRailConversationSummary["status"]>([
  "running",
  "pause_requested",
  "pausing",
  "paused",
  "awaiting_permission",
  "awaiting_question",
]);

function projectOfflineSummary(
  summary: AgentRailConversationSummary
): AgentRailConversationSummary {
  return {
    ...summary,
    status: LIVE_ONLY_STATUSES.has(summary.status) ? "interrupted" : summary.status,
    hasPendingPermission: false,
    hasPendingQuestion: false,
    pendingPermissionTitle: null,
    serverOffline: true,
  };
}

/**
 * Build rail groups for servers whose live fetch did not succeed, from the
 * freshest catalog known for each. Rows are annotated against this device's
 * connection and flagged `serverOffline` so the rail can render them muted
 * and route opens through the wake/reconnect path.
 */
export function resolveOfflineCatalogGroups(input: {
  servers: ReadonlyArray<ServerLike>;
  /** Connection ids whose live fetch succeeded this round. */
  fetchedServerIds: ReadonlySet<string>;
  store: ConversationCatalogStore;
  serverKeyFor: (server: ServerLike) => string | null;
}): AgentConversationGroup[] {
  const result: AgentConversationGroup[] = [];
  for (const server of input.servers) {
    if (input.fetchedServerIds.has(server.id)) {
      continue;
    }
    const serverKey = input.serverKeyFor(server);
    if (!serverKey) {
      continue;
    }
    const catalog = input.store[serverKey];
    if (!catalog) {
      continue;
    }
    const annotated = annotateRailGroupsForServer(catalog.groups, server);
    for (const group of annotated) {
      result.push({
        ...group,
        serverOffline: true,
        serverCachedAt: catalog.updatedAt,
        conversations: group.conversations.map(projectOfflineSummary),
      });
    }
  }
  return result;
}
