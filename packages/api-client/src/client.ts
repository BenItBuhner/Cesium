import type { ApiClientConfig } from "./runtime";
import { resolveClientServerBaseUrl } from "./runtime";

export type AgentConversationConfig = {
  backendId: string;
  mode: string;
  modelId: string;
  modelName: string;
};

export type FileNode = {
  name: string;
  type: "file" | "folder";
  children?: FileNode[];
  language?: string;
  hasChildren?: boolean;
  childrenLoaded?: boolean;
};

export type TerminalInfo = {
  id: string;
  shell: string;
  cwd?: string;
  running?: boolean;
};

export type WorkspaceRecord = {
  id: string;
  name: string;
  root: string;
};

export type WorkspaceInfo = {
  id: string;
  name: string;
  root: string;
};

export type WorkspaceBootstrapResult = {
  workspaces: WorkspaceRecord[];
  defaultWorkspaceId: string | null;
  startupWorkspaceId: string | null;
  recentWorkspaceIds: string[];
  homeWorkspaceId: string | null;
};

export type AgentBackendInfo = {
  id: string;
  label: string;
  description?: string;
  available: boolean;
  defaultMode: string;
  defaultModelId: string;
  defaultModelName: string;
};

export type AgentConversationSummary = {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastEventSeq: number;
  status: string;
  backendId: string;
  mode: string;
  experimental: boolean;
  hasPendingPermission: boolean;
};

export type AgentConversationGroupsResult = {
  backends: AgentBackendInfo[];
  groups: Array<{
    workspace: WorkspaceRecord;
    conversations: AgentConversationSummary[];
  }>;
  nextCursor: string | null;
};

export type AgentStoredEvent = {
  seq?: number;
  eventId?: string;
  kind: string;
  messageId?: string;
  content?: string;
  displayContent?: string;
  text?: string;
  title?: string;
  detail?: string;
  status?: string;
  toolKind?: string;
  toolCallId?: string;
  createdAt?: number;
};

export type AgentConversationSnapshot = {
  conversation?: {
    id: string;
    title: string;
    status: string;
    config?: AgentConversationConfig;
  };
  events?: AgentStoredEvent[];
  head?: {
    events?: AgentStoredEvent[];
  };
};

export type FileReadResult = {
  content: string;
  language: string;
  size: number;
  fileKind: "text" | "svg" | "image";
  mimeType: string;
  truncated?: boolean;
};

export type RequestOptions = {
  workspaceId?: string | null;
  skipWorkspaceHeader?: boolean;
};

export type CreateConversationInput = {
  workspaceId: string;
  config: AgentConversationConfig;
  title?: string;
};

export type CesiumApiClient = {
  health(): Promise<{ ok: boolean; transcription?: { configured: boolean } }>;
  workspaceBootstrap(): Promise<WorkspaceBootstrapResult>;
  fetchTree(workspaceId: string, depth?: number): Promise<{ root: string; tree: FileNode }>;
  fetchFolderChildren(workspaceId: string, path: string, depth?: number): Promise<{ path: string; children: FileNode[] }>;
  readFile(workspaceId: string, path: string, full?: boolean): Promise<FileReadResult>;
  listTerminals(workspaceId: string): Promise<TerminalInfo[]>;
  getWorkspaceInfo(workspaceId: string): Promise<WorkspaceInfo>;
  listAgentConversationsAll(params?: { limit?: number; cursor?: string | null }): Promise<AgentConversationGroupsResult>;
  fetchAgentConversationSnapshot(workspaceId: string, conversationId: string, options?: { full?: boolean; limitEvents?: number; limitTurns?: number }): Promise<{ snapshot: AgentConversationSnapshot }>;
  createAndPromptAgentConversation(input: {
    workspaceId: string;
    conversation?: {
      title?: string;
      config?: AgentConversationConfig;
    };
    text: string;
  }): Promise<{ snapshot: AgentConversationSnapshot }>;
};

export function createCesiumApiClient(config: ApiClientConfig): CesiumApiClient {
  const baseUrl = () =>
    resolveClientServerBaseUrl(config.serverBaseUrl, config.runtime.location());

  async function request<T>(
    path: string,
    init?: RequestInit,
    options?: RequestOptions
  ): Promise<T> {
    const headers = new Headers(init?.headers);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (!options?.skipWorkspaceHeader && options?.workspaceId) {
      headers.set("x-opencursor-workspace-id", options.workspaceId);
    }

    const response = await config.runtime.fetch(`${baseUrl()}${path}`, {
      ...init,
      headers,
      credentials: "include",
      cache: (init?.method ?? "GET").toUpperCase() === "GET" ? "default" : "no-store",
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Request failed with status ${response.status}`);
    }

    return (await response.json()) as T;
  }

  return {
    health: () => request("/health", undefined, { skipWorkspaceHeader: true }),
    workspaceBootstrap: () =>
      request("/api/workspaces/bootstrap", undefined, { skipWorkspaceHeader: true }),
    fetchTree: (workspaceId, depth = 2) => request(`/api/fs/tree?depth=${depth}`, undefined, { workspaceId }),
    fetchFolderChildren: (workspaceId, path, depth = 1) =>
      request(
        `/api/fs/tree/children?${new URLSearchParams({ path, depth: String(depth) }).toString()}`,
        undefined,
        { workspaceId }
      ),
    readFile: (workspaceId, path, full = true) =>
      request(
        `/api/fs/read?${new URLSearchParams({ path, ...(full ? { full: "1" } : {}) }).toString()}`,
        undefined,
        { workspaceId }
      ),
    listTerminals: (workspaceId) => request("/api/terminals", undefined, { workspaceId }),
    getWorkspaceInfo: (workspaceId) =>
      request(`/api/workspaces/${encodeURIComponent(workspaceId)}`, undefined, {
        skipWorkspaceHeader: true,
      }),
    listAgentConversationsAll: (params = {}) => {
      const search = new URLSearchParams();
      if (params.limit) search.set("limit", String(params.limit));
      if (params.cursor) search.set("cursor", params.cursor);
      const suffix = search.size > 0 ? `?${search.toString()}` : "";
      return request(`/api/agents/conversations/all${suffix}`, undefined, {
        skipWorkspaceHeader: true,
      });
    },
    fetchAgentConversationSnapshot: (workspaceId, conversationId, options = {}) => {
      const search = new URLSearchParams();
      if (options.full) search.set("full", "1");
      if (options.limitEvents != null) search.set("limitEvents", String(options.limitEvents));
      if (options.limitTurns != null) search.set("limitTurns", String(options.limitTurns));
      const suffix = search.size > 0 ? `?${search.toString()}` : "";
      return request(
        `/api/agents/conversations/${encodeURIComponent(conversationId)}${suffix}`,
        undefined,
        { workspaceId }
      );
    },
    createAndPromptAgentConversation: (input) =>
      request(
        "/api/agents/conversations/create-and-prompt",
        {
          method: "POST",
          body: JSON.stringify({
            conversation: input.conversation ?? {},
            text: input.text,
          }),
        },
        { workspaceId: input.workspaceId }
      ),
  };
}
