import { getJSON, setJSON } from "../../cache/kv.js";
import { getStorage } from "../../storage/runtime.js";
import { listWorkspaces, type WorkspaceRecord } from "../workspace-registry.js";
import { listAgentBackendsWithCache } from "./providers.js";
import {
  RAIL_ALL_FIRST_PAGE_CACHE_KEY,
  RAIL_ALL_FIRST_PAGE_CACHE_TTL_SEC,
} from "./cache-keys.js";
import type { AgentConversationRecord } from "./types.js";

export type AgentConversationsAllSummary = {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastEventSeq: number;
  status: AgentConversationRecord["status"];
  archivedAt: number | null;
  backendId: AgentConversationRecord["config"]["backendId"];
  mode: AgentConversationRecord["config"]["mode"];
  experimental: boolean;
  hasPendingPermission: boolean;
};

export type AgentConversationsAllPayload = {
  backends: Awaited<ReturnType<typeof listAgentBackendsWithCache>>;
  groups: Array<{
    workspace: WorkspaceRecord;
    conversations: AgentConversationsAllSummary[];
  }>;
  nextCursor: string | null;
};

const MIN_CONVERSATIONS_PER_WORKSPACE = 20;
const PLACEHOLDER_CONVERSATION_TITLES = new Set([
  "new chat",
  "start new chat",
  "start a new chat",
]);

function isRenderableRailConversation(conversation: AgentConversationRecord): boolean {
  return !(
    conversation.lastEventSeq === 0 &&
    conversation.status === "idle" &&
    conversation.archivedAt == null &&
    conversation.pendingPermission == null &&
    PLACEHOLDER_CONVERSATION_TITLES.has(conversation.title.trim().toLowerCase())
  );
}

function summarizeConversation(conversation: AgentConversationRecord): AgentConversationsAllSummary {
  return {
    id: conversation.id,
    workspaceId: conversation.workspaceId,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastEventSeq: conversation.lastEventSeq,
    status: conversation.status,
    archivedAt: conversation.archivedAt ?? null,
    backendId: conversation.config.backendId,
    mode: conversation.config.mode,
    experimental: conversation.experimental,
    hasPendingPermission: conversation.pendingPermission != null,
  };
}

/**
 * Build the same JSON the GET `/api/agents/conversations/all` handler returns.
 * Each `listWorkspaceConversationRecords` read repopulates per-workspace Redis.
 *
 * Dynamic-imports `session-store` to avoid a static circular dependency.
 */
export async function buildAgentConversationsAllPayload(input: {
  limit: number;
  offset: number;
}): Promise<AgentConversationsAllPayload> {
  const { limit, offset } = input;
  const [workspaces, backends] = await Promise.all([
    listWorkspaces(),
    listAgentBackendsWithCache(),
  ]);
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));

  if (offset === 0) {
    const storage = await getStorage();
    const [globalPage, perWorkspacePages] = await Promise.all([
      storage.listAgentConversations({
        limit,
        includeArchived: true,
      }),
      Promise.all(
        workspaces.map((workspace) =>
          storage.listAgentConversations({
            workspaceId: workspace.id,
            limit: MIN_CONVERSATIONS_PER_WORKSPACE,
            includeArchived: true,
          })
        )
      ),
    ]);
    const byId = new Map<string, AgentConversationRecord>();
    for (const conversation of globalPage.records) {
      byId.set(conversation.id, conversation);
    }
    for (const page of perWorkspacePages) {
      for (const conversation of page.records) {
        byId.set(conversation.id, conversation);
      }
    }
    const records = [...byId.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title)
    );
    return {
      backends,
      groups: groupConversationSummaries(workspaces, workspaceById, records),
      nextCursor: globalPage.nextCursor ? String(limit) : null,
    };
  }

  const perWorkspace = await Promise.all(
    workspaces.map(async (workspace) => {
      const page = await (await getStorage()).listAgentConversations({
        workspaceId: workspace.id,
        limit: offset === 0 ? MIN_CONVERSATIONS_PER_WORKSPACE : limit + offset,
        includeArchived: true,
      });
      return page.records.map((conversation) => ({
        workspace,
        conversation,
      }));
    })
  );
  const flat = perWorkspace
    .flat()
    .sort(
      (a, b) =>
        b.conversation.updatedAt - a.conversation.updatedAt ||
        a.conversation.title.localeCompare(b.conversation.title)
    );
  const window = flat.slice(offset, offset + limit).map((entry) => entry.conversation);
  return {
    backends,
    groups: groupConversationSummaries(workspaces, workspaceById, window),
    nextCursor: offset + window.length < flat.length ? String(offset + window.length) : null,
  };
}

function groupConversationSummaries(
  workspaces: WorkspaceRecord[],
  workspaceById: Map<string, WorkspaceRecord>,
  records: AgentConversationRecord[]
): AgentConversationsAllPayload["groups"] {
  const groupMap = new Map<string, AgentConversationsAllPayload["groups"][number]>();
  for (const workspace of workspaces) {
    groupMap.set(workspace.id, { workspace, conversations: [] });
  }
  for (const conversation of records) {
    if (!isRenderableRailConversation(conversation)) {
      continue;
    }
    const workspace = workspaceById.get(conversation.workspaceId);
    if (!workspace) {
      continue;
    }
    groupMap.get(workspace.id)?.conversations.push(summarizeConversation(conversation));
  }
  return Array.from(groupMap.values());
}

/**
 * Rebuilds the first-page cross-workspace rail in Redis. Run after a debounced write so
 * cold HTTP loads stay fast even if the previous cache expired.
 */
export async function repopulateAgentRailFirstPageCache(
  firstPageOptions?: { limit?: number }
): Promise<void> {
  const limit = Math.max(1, Math.min(Math.floor(firstPageOptions?.limit ?? 500), 1000));
  const body = await buildAgentConversationsAllPayload({ limit, offset: 0 });
  await setJSON(
    RAIL_ALL_FIRST_PAGE_CACHE_KEY,
    body,
    RAIL_ALL_FIRST_PAGE_CACHE_TTL_SEC
  );
}

/**
 * @internal Used by performance tests: ensure cache layer contains the first-page rail.
 */
export async function readAgentRailFirstPageCacheFromStore(): Promise<AgentConversationsAllPayload | null> {
  return getJSON<AgentConversationsAllPayload>(RAIL_ALL_FIRST_PAGE_CACHE_KEY);
}
