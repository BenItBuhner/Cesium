import type {
  AgentBackendId,
  AgentConfigOption,
  AgentConversationRecord,
  AgentEventInput,
  AgentStoredEvent,
} from "../lib/agents/types.js";
import type { GlobalSettings } from "../lib/global-settings-store.js";
import type {
  WorkspaceProfileFile,
  WorkspaceRecord,
} from "../lib/workspace-registry.js";
import type {
  PersistedWorkspaceSession,
  WorkspaceWindowRecord,
} from "../lib/workspace-session-store.js";

export type StorageDriverKind = "legacy-json" | "pg";

export type ListAgentConversationsInput = {
  workspaceId?: string;
  /** Cursor is the seq of the last record from the previous page (monotonic, desc by updatedAt). */
  cursor?: string | null;
  limit?: number;
  includeArchived?: boolean;
};

export type ListAgentConversationsResult = {
  records: AgentConversationRecord[];
  nextCursor: string | null;
};

export type AppendAgentEventsInput = {
  conversationId: string;
  events: AgentEventInput[];
};

export type ReadAgentEventsInput = {
  conversationId: string;
  /** Start seq (inclusive). */
  afterSeq?: number;
  /** Max rows to return. */
  limit?: number;
};

export type AgentProviderCacheRecord = {
  schemaVersion: 1;
  backendId: AgentBackendId;
  updatedAt: number;
  configOptions: AgentConfigOption[];
};

/**
 * Thrown by write paths that take an `expectedRevision` when the in-DB revision
 * has moved on (another writer beat us to it). Callers either refresh and
 * retry, or surface as an HTTP 409 with the current revision in `details`.
 */
export class StorageConflictError extends Error {
  readonly kind: "conflict" = "conflict";
  readonly actualRevision: number;
  readonly expectedRevision: number;

  constructor(
    message: string,
    options: { expectedRevision: number; actualRevision: number }
  ) {
    super(message);
    this.name = "StorageConflictError";
    this.expectedRevision = options.expectedRevision;
    this.actualRevision = options.actualRevision;
  }
}

/**
 * Low-level persistence contract the upper layers (routes, WS, agent runtime)
 * talk to. Both `legacy-json` and `pg` implementations satisfy this interface.
 *
 * Design rules:
 *   - Every method is async so callers can be swapped across backends.
 *   - Reads can return null; callers decide default-vs-missing semantics.
 *   - Writes accept pre-built records so the driver stays free of business
 *     logic (timestamps, id generation, validation all live above).
 *   - `revision` is optional; the pg driver uses it for If-Match style
 *     optimistic concurrency, the legacy driver ignores it.
 */
export interface StorageDriver {
  readonly kind: StorageDriverKind;

  init(): Promise<void>;
  close(): Promise<void>;

  // ---------- workspaces ----------
  listWorkspaces(): Promise<WorkspaceRecord[]>;
  getWorkspace(id: string): Promise<WorkspaceRecord | null>;
  getWorkspaceByRoot(root: string): Promise<WorkspaceRecord | null>;
  upsertWorkspace(record: WorkspaceRecord): Promise<void>;
  deleteWorkspace(id: string): Promise<void>;

  getWorkspaceProfile(): Promise<WorkspaceProfileFile>;
  saveWorkspaceProfile(profile: WorkspaceProfileFile): Promise<void>;

  // ---------- workspace sessions + windows ----------
  getWorkspaceSession(
    workspaceId: string
  ): Promise<PersistedWorkspaceSession | null>;
  saveWorkspaceSession(
    workspaceId: string,
    session: PersistedWorkspaceSession,
    expectedRevision?: number
  ): Promise<{ revision: number }>;

  listWorkspaceWindows(workspaceId: string): Promise<WorkspaceWindowRecord[]>;
  saveWorkspaceWindows(
    workspaceId: string,
    windows: WorkspaceWindowRecord[]
  ): Promise<void>;

  getWorkspaceWindowSession(
    workspaceId: string,
    windowId: string
  ): Promise<PersistedWorkspaceSession | null>;
  saveWorkspaceWindowSession(
    workspaceId: string,
    windowId: string,
    session: PersistedWorkspaceSession,
    expectedRevision?: number
  ): Promise<{ revision: number }>;

  // ---------- global settings ----------
  getGlobalSettings(): Promise<GlobalSettings | null>;
  saveGlobalSettings(
    settings: GlobalSettings,
    expectedRevision?: number
  ): Promise<{ revision: number }>;

  // ---------- auth ----------
  getAuthState(): Promise<{
    schemaVersion: number;
    secret: string;
    createdAt: number;
    updatedAt: number;
  } | null>;
  saveAuthState(state: {
    schemaVersion: number;
    secret: string;
    createdAt: number;
    updatedAt: number;
  }): Promise<void>;

  listAuthSessions(): Promise<
    Array<{
      id: string;
      username: string;
      createdAt: number;
      lastSeenAt: number;
      lastRotatedAt: number;
      expiresAt: number;
      remember: boolean;
    }>
  >;
  saveAuthSessions(
    sessions: Array<{
      id: string;
      username: string;
      createdAt: number;
      lastSeenAt: number;
      lastRotatedAt: number;
      expiresAt: number;
      remember: boolean;
    }>
  ): Promise<void>;

  // ---------- agent conversations ----------
  listAgentConversations(
    input: ListAgentConversationsInput
  ): Promise<ListAgentConversationsResult>;
  getAgentConversation(id: string): Promise<AgentConversationRecord | null>;
  upsertAgentConversation(record: AgentConversationRecord): Promise<void>;
  deleteAgentConversation(id: string): Promise<void>;

  appendAgentEvents(
    input: AppendAgentEventsInput
  ): Promise<{ events: AgentStoredEvent[]; newLastSeq: number }>;
  readAgentEvents(input: ReadAgentEventsInput): Promise<AgentStoredEvent[]>;
  /**
   * Events with seq strictly less than `beforeSeq`, newest-first load capped by
   * `limit`, then returned in ascending seq order (for turn-window paging).
   */
  readAgentEventsOlderThan(input: {
    conversationId: string;
    beforeSeq: number;
    limit: number;
  }): Promise<AgentStoredEvent[]>;
  readRecentAgentEvents(
    conversationId: string,
    limit: number
  ): Promise<AgentStoredEvent[]>;

  // ---------- provider cache ----------
  readProviderCache(
    backendId: AgentBackendId
  ): Promise<AgentProviderCacheRecord | null>;
  writeProviderCache(
    backendId: AgentBackendId,
    record: AgentProviderCacheRecord
  ): Promise<void>;
}
