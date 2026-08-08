import type {
  AgentBackendId,
  AgentConversationCreateInput,
  AgentConversationSnapshot,
  AgentConversationSnapshotHead,
  ImageAttachment,
  WorkspaceRecord,
} from "@cesium/contracts";

export type PageOptions = {
  limit?: number;
  cursor?: string | null;
  signal?: AbortSignal;
};

export type WorkspacesResponse = {
  workspaces: WorkspaceRecord[];
  defaultWorkspaceId: string | null;
  lastOpenedWorkspaceId?: string | null;
  startupWorkspaceId?: string | null;
  recentWorkspaceIds: string[];
  homeWorkspaceId: string | null;
  repositoriesByWorkspaceId?: Record<string, unknown>;
};

export type CreateAndPromptInput = {
  conversation?: AgentConversationCreateInput;
  text?: string;
  attachments?: ImageAttachment[];
  clientEventId?: string;
  clientMessageId?: string;
  configOverride?: unknown;
};

export type PromptInput = {
  text?: string;
  attachments?: ImageAttachment[];
  clientEventId?: string;
  clientMessageId?: string;
  clientTimezone?: string;
  delivery?: "normal" | "steer";
  configOverride?: unknown;
  planHandoff?: unknown;
};

export type ConversationSnapshotResponse = {
  snapshot: AgentConversationSnapshot | AgentConversationSnapshotHead;
};

export type CreateStandaloneConversationInput = CreateAndPromptInput & {
  title?: string;
};

export type FileReadResult = {
  content: string;
  language: string;
  size: number;
  fileKind: "text" | "svg" | "image";
  mimeType: string;
  previewPath?: string;
  readByteOffset?: number;
  readByteLength?: number;
  truncated?: boolean;
  totalSize?: number;
};

export type FileStatResult = {
  exists: boolean;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtime: number | null;
};

export type FileSearchResult = {
  path: string;
  name: string;
  language: string;
};

export type CreateCloudAgentTaskInput = {
  title: string;
  prompt?: string;
  workspaceId?: string;
  backendId?: AgentBackendId;
  modelId?: string;
  executionMode?: "isolated" | "local";
  dispatch?: boolean;
};

export type StorageDriverKind = "legacy-json" | "pg";

export type StorageStatus = {
  currentDriver: StorageDriverKind;
  drivers: Record<
    StorageDriverKind,
    {
      stats: {
        driver: StorageDriverKind;
        workspaces: number;
        agentConversations: number;
        authSessions: number;
        providerCacheEntries: number;
        hasGlobalSettings: boolean;
        hasAuthState: boolean;
      } | null;
      available: boolean;
      error?: string;
    }
  >;
  migrationRunning: boolean;
};
