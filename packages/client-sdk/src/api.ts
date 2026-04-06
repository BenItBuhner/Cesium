import type {
  AgentConversationRecord,
  AgentConversationConfigPatch,
  AgentConversationCreateInput,
  AgentConversationListResult,
  AgentConversationSnapshot,
  AudioTranscriptionResult,
  FileNode,
  FileReadResult,
  FileSearchResult,
  FileStatResult,
  GlobalSettingsState,
  TerminalInfo,
  WorkspaceInfo,
  WorkspaceRecord,
  WorkspaceSessionState,
} from "./types.js";
import { type RuntimeClientConfig, resolveBaseUrl, toWebSocketUrl } from "./config.js";

export type ClientOptions = {
  config: RuntimeClientConfig;
  fetchImpl?: typeof fetch;
};

type RequestOptions = {
  skipWorkspaceHeader?: boolean;
  headers?: HeadersInit;
};

export class OpenCursorClient {
  private readonly config: RuntimeClientConfig;
  private readonly fetchImpl: typeof fetch;
  private activeWorkspaceId: string | null = null;

  constructor(options: ClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get baseUrl(): string {
    return resolveBaseUrl(this.config);
  }

  setActiveWorkspaceId(workspaceId: string | null): void {
    this.activeWorkspaceId = workspaceId;
  }

  getActiveWorkspaceId(): string | null {
    return this.activeWorkspaceId;
  }

  getServerBaseUrl(): string {
    return this.baseUrl;
  }

  buildAgentWebSocketUrl(workspaceId: string): string {
    const params = new URLSearchParams({ workspaceId });
    return `${toWebSocketUrl(this.baseUrl)}/ws/agent?${params.toString()}`;
  }

  buildFsWebSocketUrl(workspaceId: string, since = 0): string {
    const params = new URLSearchParams({ workspaceId, since: String(since) });
    return `${toWebSocketUrl(this.baseUrl)}/ws/fs?${params.toString()}`;
  }

  buildTerminalWebSocketUrl(terminalId: string): string {
    return `${toWebSocketUrl(this.baseUrl)}/ws/terminal/${encodeURIComponent(terminalId)}`;
  }

  private getWorkspaceHeaders(skipWorkspaceHeader?: boolean): HeadersInit {
    if (skipWorkspaceHeader || !this.activeWorkspaceId) {
      return {};
    }
    return {
      "x-opencursor-workspace-id": this.activeWorkspaceId,
    };
  }

  private async request<T>(
    input: string,
    init?: RequestInit,
    options?: RequestOptions
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${input}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...this.getWorkspaceHeaders(options?.skipWorkspaceHeader),
        ...(options?.headers ?? {}),
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Request failed with status ${response.status}`);
    }

    return (await response.json()) as T;
  }

  async fetchWorkspaceBootstrap(): Promise<{
    workspaces: WorkspaceRecord[];
    defaultWorkspaceId: string | null;
    startupWorkspaceId: string | null;
    recentWorkspaceIds: string[];
  }> {
    return this.request(`/api/workspaces/bootstrap`, undefined, {
      skipWorkspaceHeader: true,
    });
  }

  async fetchWorkspaces(): Promise<{
    workspaces: WorkspaceRecord[];
    defaultWorkspaceId: string | null;
    lastOpenedWorkspaceId: string | null;
    recentWorkspaceIds: string[];
  }> {
    return this.request(`/api/workspaces`, undefined, {
      skipWorkspaceHeader: true,
    });
  }

  async openWorkspaceSelection(input: {
    workspaceId?: string;
    root?: string;
    name?: string;
  }): Promise<{
    workspace: WorkspaceRecord;
    workspaces: WorkspaceRecord[];
    defaultWorkspaceId: string | null;
    recentWorkspaceIds: string[];
  }> {
    return this.request(
      `/api/workspaces/open`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      { skipWorkspaceHeader: true }
    );
  }

  async createWorkspaceSelection(input: {
    name?: string;
    parentPath: string;
    directoryName: string;
    setDefault?: boolean;
  }): Promise<{
    workspace: WorkspaceRecord;
    workspaces: WorkspaceRecord[];
    defaultWorkspaceId: string | null;
    recentWorkspaceIds: string[];
  }> {
    return this.request(
      `/api/workspaces/create`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      { skipWorkspaceHeader: true }
    );
  }

  async setDefaultWorkspaceSelection(
    workspaceId: string
  ): Promise<{ ok: true; defaultWorkspaceId: string | null }> {
    return this.request(
      `/api/workspaces/default`,
      {
        method: "PATCH",
        body: JSON.stringify({ workspaceId }),
      },
      { skipWorkspaceHeader: true }
    );
  }

  async fetchWorkspaceSession(
    workspaceId: string
  ): Promise<{ workspace: WorkspaceRecord; session: WorkspaceSessionState | null }> {
    return this.request(`/api/workspaces/${encodeURIComponent(workspaceId)}/session`, undefined, {
      skipWorkspaceHeader: true,
    });
  }

  async saveWorkspaceSession(
    workspaceId: string,
    session: WorkspaceSessionState,
    options?: { keepalive?: boolean }
  ): Promise<void> {
    await this.request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/session`,
      {
        method: "PUT",
        body: JSON.stringify(session),
        keepalive: options?.keepalive,
      },
      { skipWorkspaceHeader: true }
    );
  }

  async fetchAgentDeploymentHints(): Promise<{
    cursorAgent: {
      resolved: boolean;
      commandPreview: string | null;
      extraArgs: string[];
      permissionModeEnv: string | null;
      acpCapabilitiesJsonSet: boolean;
      cursorBinEnvSet: boolean;
    };
  }> {
    return this.request(`/api/agents/deployment-hints`);
  }

  async listAgentConversations(): Promise<AgentConversationListResult> {
    return this.request(`/api/agents/conversations`);
  }

  async createAgentConversation(
    input: AgentConversationCreateInput
  ): Promise<{ conversation: AgentConversationRecord }> {
    return this.request(`/api/agents/conversations`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async fetchAgentConversationSnapshot(
    conversationId: string,
    options?: { hydrateRuntime?: boolean }
  ): Promise<{ snapshot: AgentConversationSnapshot }> {
    const params = new URLSearchParams();
    if (options?.hydrateRuntime) {
      params.set("hydrate", "1");
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request(`/api/agents/conversations/${encodeURIComponent(conversationId)}${suffix}`);
  }

  async updateAgentConversationConfig(
    conversationId: string,
    patch: AgentConversationConfigPatch
  ): Promise<{ conversation: AgentConversationRecord }> {
    return this.request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/config`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  async promptAgentConversation(
    conversationId: string,
    text: string
  ): Promise<{ snapshot: AgentConversationSnapshot }> {
    return this.request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }

  async cancelAgentConversation(
    conversationId: string
  ): Promise<{ conversation: AgentConversationRecord }> {
    return this.request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  async answerAgentPermission(
    conversationId: string,
    input: { requestId: string; optionId?: string; cancelled?: boolean }
  ): Promise<{ conversation: AgentConversationRecord }> {
    return this.request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/permission`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async transcribeAudio(
    file: Blob,
    filename = "recording.webm",
    options?: { language?: string; prompt?: string }
  ): Promise<AudioTranscriptionResult> {
    const form = new FormData();
    form.set("file", file, filename);
    if (options?.language) {
      form.set("language", options.language);
    }
    if (options?.prompt) {
      form.set("prompt", options.prompt);
    }
    const response = await this.fetchImpl(`${this.baseUrl}/api/audio/transcriptions`, {
      method: "POST",
      body: form,
      headers: this.getWorkspaceHeaders(),
      cache: "no-store",
    });
    if (!response.ok) {
      const message = await response.text();
      let parsedError = "";
      try {
        parsedError = (JSON.parse(message) as { error?: string })?.error ?? "";
      } catch {
        parsedError = "";
      }
      throw new Error(parsedError || message || `Request failed with status ${response.status}`);
    }
    return (await response.json()) as AudioTranscriptionResult;
  }

  async fetchGlobalSettings(): Promise<{ settings: GlobalSettingsState }> {
    return this.request(`/api/settings/global`, undefined, { skipWorkspaceHeader: true });
  }

  async saveGlobalSettings(
    settings: GlobalSettingsState,
    options?: { keepalive?: boolean }
  ): Promise<void> {
    await this.request(
      `/api/settings/global`,
      {
        method: "PUT",
        body: JSON.stringify({ settings }),
        keepalive: options?.keepalive,
      },
      { skipWorkspaceHeader: true }
    );
  }

  async fetchTree(depth?: number): Promise<{ root: string; tree: FileNode }> {
    const query = depth ? `?depth=${depth}` : "";
    return this.request(`/api/fs/tree${query}`);
  }

  async fetchFolderChildren(
    path: string,
    depth = 1
  ): Promise<{ path: string; children: FileNode[] }> {
    const params = new URLSearchParams({
      path,
      depth: String(depth),
    });
    return this.request(`/api/fs/tree/children?${params.toString()}`);
  }

  async readFile(path: string): Promise<FileReadResult> {
    return this.request(`/api/fs/read?path=${encodeURIComponent(path)}`);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.request(`/api/fs/write`, {
      method: "POST",
      body: JSON.stringify({ path, content }),
    });
  }

  async mkdir(relativePath: string): Promise<void> {
    await this.request(`/api/fs/mkdir`, {
      method: "POST",
      body: JSON.stringify({ path: relativePath }),
    });
  }

  async deletePath(relativePath: string): Promise<void> {
    await this.request(`/api/fs/delete`, {
      method: "POST",
      body: JSON.stringify({ path: relativePath }),
    });
  }

  async renamePath(from: string, to: string): Promise<void> {
    await this.request(`/api/fs/rename`, {
      method: "POST",
      body: JSON.stringify({ from, to }),
    });
  }

  async statFile(path: string): Promise<FileStatResult> {
    return this.request(`/api/fs/stat?path=${encodeURIComponent(path)}`);
  }

  async searchFiles(query: string, glob?: string): Promise<FileSearchResult[]> {
    const params = new URLSearchParams();
    params.set("q", query);
    if (glob) params.set("glob", glob);
    const result = await this.request<{ matches: FileSearchResult[] }>(
      `/api/fs/search?${params.toString()}`
    );
    return result.matches;
  }

  async getWorkspace(): Promise<WorkspaceInfo> {
    const workspace = this.activeWorkspaceId
      ? await this.fetchWorkspaceSession(this.activeWorkspaceId)
      : null;
    if (!workspace) {
      throw new Error("No active workspace.");
    }
    return workspace.workspace;
  }

  async listTerminals(): Promise<TerminalInfo[]> {
    const result = await this.request<{ terminals: TerminalInfo[] }>(`/api/terminals`);
    return result.terminals;
  }

  async createTerminal(shell?: string): Promise<{ id: string }> {
    return this.request(`/api/terminals`, {
      method: "POST",
      body: JSON.stringify(shell ? { shell } : {}),
    });
  }

  async deleteTerminal(id: string): Promise<void> {
    await this.request(`/api/terminals/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
}
