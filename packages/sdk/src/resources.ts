import {
  AgentConversationListSchema,
  AgentConversationRecordSchema,
  AgentConversationSnapshotResponseSchema,
  CESIUM_PROTOCOL_VERSION,
  CesiumAuthStatusSchema,
  CesiumServerMetadataSchema,
  CloudAgentSettingsSchema,
  CloudAgentTaskSchema,
  CloudAgentTasksResponseSchema,
  WorkspaceRecordSchema,
  WorkspacesResponseSchema,
  type AgentBackendId,
  type AgentConversationConfigPatch,
  type AgentConversationCreateInput,
  type AgentConversationGroupsResult,
  type AgentConversationListResult,
  type AgentConversationMetadataPatch,
  type AgentConversationRecord,
  type AgentContextUsageSnapshot,
  type AgentSocketClientMessage,
  type AgentSocketServerMessage,
  type CesiumAgentSettingsPublic,
  type CesiumAuthSession,
  type CesiumAuthStatus,
  type CesiumModelCatalogEntry,
  type CesiumServerMetadata,
  type CloudAgentEndpoints,
  type CloudAgentExecutionMode,
  type CloudAgentProviderId,
  type CloudAgentRoutingRule,
  type CloudAgentSettingsPublic,
  type CloudAgentTaskArtifact,
  type CloudAgentTaskRecord,
  type CloudAgentTaskStatus,
  type FileNode,
  type GitWorkspaceStatus,
  type GitWorktreeInfo,
  type GitWorktreeSetupResult,
  type McpConnectionStatus,
  type McpPresetDefinition,
  type McpServerConfig,
  type McpServerPublic,
  type ModelToggleState,
  type ModelToggleUpdate,
  type OrchestrationBoardRecord,
  type OrchestrationBoardSnapshot,
  type OrchestrationColumnId,
  type OrchestrationIssuePriority,
  type TerminalInfo,
  type WorkspaceRecord,
} from "@cesium/contracts";
import { CesiumSocket } from "./socket.js";
import { CesiumTransport, type CesiumRequestOptions } from "./transport.js";
import type {
  ConversationSnapshotResponse,
  CreateAndPromptInput,
  CreateCloudAgentTaskInput,
  CreateStandaloneConversationInput,
  FileReadResult,
  FileSearchResult,
  FileStatResult,
  PageOptions,
  PromptInput,
  StorageStatus,
  WorkspacesResponse,
} from "./types.js";

function id(value: string): string {
  return encodeURIComponent(value);
}

function finiteInteger(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return Math.floor(value);
}

export class SystemResource {
  constructor(private readonly transport: CesiumTransport) {}

  meta(options?: { signal?: AbortSignal }): Promise<CesiumServerMetadata> {
    return this.transport.request("system.meta", "/api/meta", {
      signal: options?.signal,
      schema: CesiumServerMetadataSchema,
    });
  }

  async health(options?: { signal?: AbortSignal }): Promise<{
    ok: true;
    transcription?: { configured: boolean };
  }> {
    return this.transport.request("system.health", "/health", {
      signal: options?.signal,
    });
  }

  async assertCompatible(): Promise<CesiumServerMetadata> {
    const metadata = await this.meta();
    const expectedMajor = CESIUM_PROTOCOL_VERSION.split(".")[0];
    const actualMajor = metadata.protocolVersion.split(".")[0];
    if (expectedMajor !== actualMajor) {
      throw new Error(
        `Incompatible Cesium protocol: SDK ${CESIUM_PROTOCOL_VERSION}, server ${metadata.protocolVersion}.`
      );
    }
    return metadata;
  }
}

export class AuthResource {
  constructor(private readonly transport: CesiumTransport) {}

  status(options?: { signal?: AbortSignal }): Promise<CesiumAuthStatus> {
    return this.transport.request("auth.status", "/api/auth/status", {
      signal: options?.signal,
      schema: CesiumAuthStatusSchema,
    });
  }

  login(input: {
    username: string;
    password: string;
    remember?: boolean;
    signal?: AbortSignal;
  }): Promise<{
    ok: true;
    authenticated: true;
    token: string;
    session: CesiumAuthSession;
  }> {
    return this.transport.request("auth.login", "/api/auth/login", {
      method: "POST",
      json: {
        username: input.username,
        password: input.password,
        remember: input.remember,
      },
      signal: input.signal,
    });
  }

  logout(options?: { signal?: AbortSignal }): Promise<{ ok: true }> {
    return this.transport.request("auth.logout", "/api/auth/logout", {
      method: "POST",
      json: {},
      signal: options?.signal,
    });
  }
}

export class WorkspacesResource {
  constructor(private readonly transport: CesiumTransport) {}

  list(options?: { signal?: AbortSignal }): Promise<WorkspacesResponse> {
    return this.transport.request("workspaces.list", "/api/workspaces", {
      signal: options?.signal,
      schema: WorkspacesResponseSchema,
    });
  }

  bootstrap(options?: { signal?: AbortSignal }): Promise<WorkspacesResponse> {
    return this.transport.request(
      "workspaces.bootstrap",
      "/api/workspaces/bootstrap",
      {
        signal: options?.signal,
        schema: WorkspacesResponseSchema,
      }
    );
  }

  open(input: {
    workspaceId?: string;
    root?: string;
    name?: string;
    trackRecent?: boolean;
    signal?: AbortSignal;
  }): Promise<
    WorkspacesResponse & {
      workspace: WorkspaceRecord;
    }
  > {
    return this.transport.request("workspaces.open", "/api/workspaces/open", {
      method: "POST",
      json: input,
      signal: input.signal,
    });
  }

  create(input: {
    name?: string;
    parentPath?: string;
    directoryName?: string;
    setDefault?: boolean;
    signal?: AbortSignal;
  }): Promise<
    WorkspacesResponse & {
      workspace: WorkspaceRecord;
    }
  > {
    return this.transport.request("workspaces.create", "/api/workspaces/create", {
      method: "POST",
      json: input,
      signal: input.signal,
    });
  }

  async get(
    workspaceId: string,
    options?: { signal?: AbortSignal }
  ): Promise<WorkspaceRecord | null> {
    const response = await this.list(options);
    return response.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  }

  async remove(
    workspaceId: string,
    options?: { deleteFiles?: boolean; signal?: AbortSignal }
  ): Promise<WorkspacesResponse> {
    return this.transport.request(
      "workspaces.remove",
      `/api/workspaces/${id(workspaceId)}`,
      {
        method: "DELETE",
        query: { deleteFiles: options?.deleteFiles },
        signal: options?.signal,
      }
    );
  }
}

export class FilesResource {
  constructor(
    private readonly transport: CesiumTransport,
    private readonly workspaceId: string
  ) {}

  tree(options?: {
    depth?: number;
    signal?: AbortSignal;
  }): Promise<{ root: string; tree: FileNode }> {
    return this.transport.request("files.tree", "/api/fs/tree", {
      workspaceId: this.workspaceId,
      query: { depth: finiteInteger(options?.depth ?? 2) },
      signal: options?.signal,
    });
  }

  children(
    path: string,
    options?: { depth?: number; signal?: AbortSignal }
  ): Promise<{ path: string; children: FileNode[] }> {
    return this.transport.request("files.children", "/api/fs/tree/children", {
      workspaceId: this.workspaceId,
      query: { path, depth: finiteInteger(options?.depth ?? 1) },
      signal: options?.signal,
    });
  }

  read(
    path: string,
    options?: {
      full?: boolean;
      byteOffset?: number;
      byteLength?: number;
      signal?: AbortSignal;
    }
  ): Promise<FileReadResult> {
    return this.transport.request("files.read", "/api/fs/read", {
      workspaceId: this.workspaceId,
      query: {
        path,
        full: options?.full ? 1 : undefined,
        byteOffset: finiteInteger(options?.byteOffset),
        byteLength: finiteInteger(options?.byteLength),
      },
      signal: options?.signal,
    });
  }

  async write(
    path: string,
    content: string,
    options?: { signal?: AbortSignal }
  ): Promise<void> {
    await this.transport.request("files.write", "/api/fs/write", {
      method: "POST",
      workspaceId: this.workspaceId,
      json: { path, content },
      signal: options?.signal,
    });
  }

  stat(path: string, options?: { signal?: AbortSignal }): Promise<FileStatResult> {
    return this.transport.request("files.stat", "/api/fs/stat", {
      workspaceId: this.workspaceId,
      query: { path },
      signal: options?.signal,
    });
  }

  async mkdir(path: string, options?: { signal?: AbortSignal }): Promise<void> {
    await this.transport.request("files.mkdir", "/api/fs/mkdir", {
      method: "POST",
      workspaceId: this.workspaceId,
      json: { path },
      signal: options?.signal,
    });
  }

  async remove(path: string, options?: { signal?: AbortSignal }): Promise<void> {
    await this.transport.request("files.remove", "/api/fs/delete", {
      method: "POST",
      workspaceId: this.workspaceId,
      json: { path },
      signal: options?.signal,
    });
  }

  async rename(
    from: string,
    to: string,
    options?: { signal?: AbortSignal }
  ): Promise<void> {
    await this.transport.request("files.rename", "/api/fs/rename", {
      method: "POST",
      workspaceId: this.workspaceId,
      json: { from, to },
      signal: options?.signal,
    });
  }

  async upload(
    path: string,
    file: Blob,
    options?: { fileName?: string; signal?: AbortSignal }
  ): Promise<void> {
    const form = new FormData();
    form.set("path", path);
    form.set("file", file, options?.fileName);
    const response = await this.transport.raw("/api/fs/upload", {
      method: "POST",
      workspaceId: this.workspaceId,
      body: form,
      signal: options?.signal,
    });
    await this.transport.parseResponse("files.upload", response);
  }

  async search(
    query: string,
    options?: { glob?: string; signal?: AbortSignal }
  ): Promise<FileSearchResult[]> {
    const result = await this.transport.request<{ matches: FileSearchResult[] }>(
      "files.search",
      "/api/fs/search",
      {
        workspaceId: this.workspaceId,
        query: { q: query, glob: options?.glob },
        signal: options?.signal,
      }
    );
    return result.matches;
  }
}

export class TerminalsResource {
  constructor(
    private readonly transport: CesiumTransport,
    private readonly workspaceId: string
  ) {}

  async list(options?: { signal?: AbortSignal }): Promise<TerminalInfo[]> {
    const result = await this.transport.request<{ terminals: TerminalInfo[] }>(
      "terminals.list",
      "/api/terminals",
      {
        workspaceId: this.workspaceId,
        signal: options?.signal,
      }
    );
    return result.terminals;
  }

  create(
    input?: { shell?: string; signal?: AbortSignal }
  ): Promise<{ id: string }> {
    return this.transport.request("terminals.create", "/api/terminals", {
      method: "POST",
      workspaceId: this.workspaceId,
      json: input?.shell ? { shell: input.shell } : {},
      signal: input?.signal,
    });
  }

  async remove(idValue: string, options?: { signal?: AbortSignal }): Promise<void> {
    await this.transport.request(
      "terminals.remove",
      `/api/terminals/${id(idValue)}`,
      {
        method: "DELETE",
        workspaceId: this.workspaceId,
        signal: options?.signal,
      }
    );
  }

  async webSocketUrl(terminalId: string): Promise<string> {
    return this.transport.webSocketUrl(`/ws/terminal/${id(terminalId)}`);
  }
}

export class GitResource {
  constructor(
    private readonly transport: CesiumTransport,
    private readonly workspaceId: string
  ) {}

  status(options?: { signal?: AbortSignal }): Promise<GitWorkspaceStatus> {
    return this.transport.request(
      "workspaces.git.status",
      `/api/workspaces/${id(this.workspaceId)}/git/status`,
      {
        workspaceId: this.workspaceId,
        signal: options?.signal,
      }
    );
  }

  initialize(options?: {
    defaultBranch?: string;
    signal?: AbortSignal;
  }): Promise<{ status: GitWorkspaceStatus }> {
    return this.transport.request(
      "workspaces.git.init",
      `/api/workspaces/${id(this.workspaceId)}/git/init`,
      {
        method: "POST",
        workspaceId: this.workspaceId,
        json: { defaultBranch: options?.defaultBranch },
        signal: options?.signal,
      }
    );
  }

  switchBranch(
    branch: string,
    options?: { create?: boolean; signal?: AbortSignal }
  ): Promise<{ status: GitWorkspaceStatus }> {
    return this.transport.request(
      "workspaces.git.switch",
      `/api/workspaces/${id(this.workspaceId)}/git/switch`,
      {
        method: "POST",
        workspaceId: this.workspaceId,
        json: { branch, create: options?.create },
        signal: options?.signal,
      }
    );
  }

  createWorktree(input: {
    branch: string;
    path?: string;
    createBranch?: boolean;
    signal?: AbortSignal;
  }): Promise<{
    worktree: GitWorktreeInfo;
    workspace?: WorkspaceRecord;
    setup?: GitWorktreeSetupResult;
  }> {
    return this.transport.request(
      "workspaces.git.worktrees.create",
      `/api/workspaces/${id(this.workspaceId)}/git/worktrees`,
      {
        method: "POST",
        workspaceId: this.workspaceId,
        json: input,
        signal: input.signal,
      }
    );
  }

  removeWorktree(
    path: string,
    options?: { force?: boolean; signal?: AbortSignal }
  ): Promise<{ ok: true }> {
    return this.transport.request(
      "workspaces.git.worktrees.remove",
      `/api/workspaces/${id(this.workspaceId)}/git/worktrees`,
      {
        method: "DELETE",
        workspaceId: this.workspaceId,
        json: { path, force: options?.force },
        signal: options?.signal,
      }
    );
  }
}

export class ConversationsResource {
  constructor(
    private readonly transport: CesiumTransport,
    private readonly workspaceId: string
  ) {}

  list(options?: PageOptions): Promise<AgentConversationListResult> {
    return this.transport.request(
      "conversations.list",
      "/api/agents/conversations",
      {
        workspaceId: this.workspaceId,
        query: {
          limit: finiteInteger(options?.limit),
          cursor: options?.cursor,
        },
        signal: options?.signal,
        schema: AgentConversationListSchema,
      }
    );
  }

  async *iterate(options?: Omit<PageOptions, "cursor">): AsyncIterable<AgentConversationRecord> {
    let cursor: string | null | undefined;
    do {
      const page = await this.list({ ...options, cursor });
      yield* page.conversations;
      cursor = page.nextCursor;
    } while (cursor);
  }

  async create(
    input: AgentConversationCreateInput,
    options?: { signal?: AbortSignal }
  ): Promise<AgentConversationRecord> {
    const response = await this.transport.request<{
      conversation: AgentConversationRecord;
    }>("conversations.create", "/api/agents/conversations", {
      method: "POST",
      workspaceId: this.workspaceId,
      json: input,
      signal: options?.signal,
    });
    return AgentConversationRecordSchema.parse(response.conversation);
  }

  createAndPrompt(
    input: CreateAndPromptInput,
    options?: { signal?: AbortSignal }
  ): Promise<ConversationSnapshotResponse> {
    return this.transport.request(
      "conversations.createAndPrompt",
      "/api/agents/conversations/create-and-prompt",
      {
        method: "POST",
        workspaceId: this.workspaceId,
        json: input,
        signal: options?.signal,
        schema: AgentConversationSnapshotResponseSchema,
      }
    );
  }

  get(
    conversationId: string,
    options?: {
      hydrateRuntime?: boolean;
      full?: boolean;
      limitTurns?: number;
      limitEvents?: number;
      signal?: AbortSignal;
    }
  ): Promise<ConversationSnapshotResponse> {
    return this.transport.request(
      "conversations.get",
      `/api/agents/conversations/${id(conversationId)}`,
      {
        workspaceId: this.workspaceId,
        query: {
          hydrate: options?.hydrateRuntime ? 1 : undefined,
          full: options?.full ? 1 : undefined,
          limitTurns: finiteInteger(options?.limitTurns),
          limitEvents: finiteInteger(options?.limitEvents),
        },
        signal: options?.signal,
        schema: AgentConversationSnapshotResponseSchema,
      }
    );
  }

  contextUsage(
    conversationId: string,
    options?: { signal?: AbortSignal }
  ): Promise<{ usage: AgentContextUsageSnapshot }> {
    return this.transport.request(
      "conversations.contextUsage",
      `/api/agents/conversations/${id(conversationId)}/context-usage`,
      {
        workspaceId: this.workspaceId,
        signal: options?.signal,
      }
    );
  }

  prompt(
    conversationId: string,
    input: PromptInput,
    options?: { signal?: AbortSignal }
  ): Promise<ConversationSnapshotResponse> {
    return this.transport.request(
      "conversations.prompt",
      `/api/agents/conversations/${id(conversationId)}/prompt`,
      {
        method: "POST",
        workspaceId: this.workspaceId,
        json: input,
        signal: options?.signal,
        schema: AgentConversationSnapshotResponseSchema,
      }
    );
  }

  updateConfig(
    conversationId: string,
    patch: AgentConversationConfigPatch,
    options?: { signal?: AbortSignal }
  ): Promise<{ conversation: AgentConversationRecord }> {
    return this.transport.request(
      "conversations.config",
      `/api/agents/conversations/${id(conversationId)}/config`,
      {
        method: "PATCH",
        workspaceId: this.workspaceId,
        json: patch,
        signal: options?.signal,
      }
    );
  }

  updateMetadata(
    conversationId: string,
    patch: AgentConversationMetadataPatch,
    options?: { signal?: AbortSignal }
  ): Promise<{ conversation: AgentConversationRecord }> {
    return this.transport.request(
      "conversations.metadata",
      `/api/agents/conversations/${id(conversationId)}/metadata`,
      {
        method: "PATCH",
        workspaceId: this.workspaceId,
        json: patch,
        signal: options?.signal,
      }
    );
  }

  retry(conversationId: string): Promise<ConversationSnapshotResponse> {
    return this.actionSnapshot(conversationId, "retry");
  }

  cancel(conversationId: string): Promise<{ conversation: AgentConversationRecord }> {
    return this.actionConversation(conversationId, "cancel");
  }

  pause(conversationId: string): Promise<{ conversation: AgentConversationRecord }> {
    return this.actionConversation(conversationId, "pause");
  }

  resume(conversationId: string): Promise<{ conversation: AgentConversationRecord }> {
    return this.actionConversation(conversationId, "resume");
  }

  answerPermission(
    conversationId: string,
    input: { requestId: string; optionId?: string; cancelled?: boolean }
  ): Promise<{ conversation: AgentConversationRecord }> {
    return this.transport.request(
      "conversations.permission",
      `/api/agents/conversations/${id(conversationId)}/permission`,
      {
        method: "POST",
        workspaceId: this.workspaceId,
        json: input,
      }
    );
  }

  answerQuestion(
    conversationId: string,
    input: { questionId: string; answer: string }
  ): Promise<{ conversation: AgentConversationRecord }> {
    return this.transport.request(
      "conversations.question",
      `/api/agents/conversations/${id(conversationId)}/question`,
      {
        method: "POST",
        workspaceId: this.workspaceId,
        json: input,
      }
    );
  }

  fork(
    conversationId: string,
    input?: { upToMessageId?: string; beforeMessageId?: string }
  ): Promise<{ conversation: AgentConversationRecord }> {
    return this.transport.request(
      "conversations.fork",
      `/api/agents/conversations/${id(conversationId)}/fork`,
      {
        method: "POST",
        workspaceId: this.workspaceId,
        json: input ?? {},
      }
    );
  }

  events(input: {
    conversationIds: string[];
    sinceByConversationId?: Record<string, number>;
    reconnect?: boolean;
  }): CesiumSocket<AgentSocketClientMessage, AgentSocketServerMessage> {
    return new CesiumSocket({
      reconnect: input.reconnect,
      initialMessage: {
        type: "subscribe",
        conversationIds: input.conversationIds,
        sinceByConversationId: input.sinceByConversationId,
      },
      create: async () => {
        const url = await this.transport.webSocketUrl("/ws/agent", {
          workspaceId: this.workspaceId,
        });
        return this.transport.createWebSocket(url);
      },
    });
  }

  private actionSnapshot(
    conversationId: string,
    action: "retry"
  ): Promise<ConversationSnapshotResponse> {
    return this.transport.request(
      `conversations.${action}`,
      `/api/agents/conversations/${id(conversationId)}/${action}`,
      {
        method: "POST",
        workspaceId: this.workspaceId,
        json: {},
        schema: AgentConversationSnapshotResponseSchema,
      }
    );
  }

  private actionConversation(
    conversationId: string,
    action: "cancel" | "pause" | "resume"
  ): Promise<{ conversation: AgentConversationRecord }> {
    return this.transport.request(
      `conversations.${action}`,
      `/api/agents/conversations/${id(conversationId)}/${action}`,
      {
        method: "POST",
        workspaceId: this.workspaceId,
        json: {},
      }
    );
  }
}

export class McpResource {
  constructor(
    private readonly transport: CesiumTransport,
    private readonly workspaceId: string
  ) {}

  async presets(): Promise<McpPresetDefinition[]> {
    const result = await this.transport.request<{ presets: McpPresetDefinition[] }>(
      "mcp.presets",
      "/api/mcp/presets"
    );
    return result.presets;
  }

  async list(): Promise<McpServerPublic[]> {
    const result = await this.transport.request<{ servers: McpServerPublic[] }>(
      "mcp.servers.list",
      `/api/workspaces/${id(this.workspaceId)}/mcp/servers`,
      { workspaceId: this.workspaceId }
    );
    return result.servers;
  }

  async upsert(input: {
    presetId?: string;
    server?: Partial<McpServerConfig> & { label: string };
    secretValues?: Record<string, string>;
  }): Promise<McpServerPublic> {
    const result = await this.transport.request<{ server: McpServerPublic }>(
      "mcp.servers.upsert",
      `/api/workspaces/${id(this.workspaceId)}/mcp/servers`,
      {
        method: "PUT",
        workspaceId: this.workspaceId,
        json: input,
      }
    );
    return result.server;
  }

  async remove(serverId: string): Promise<void> {
    await this.transport.request(
      "mcp.servers.remove",
      `/api/workspaces/${id(this.workspaceId)}/mcp/servers/${id(serverId)}`,
      {
        method: "DELETE",
        workspaceId: this.workspaceId,
      }
    );
  }

  async test(serverId: string): Promise<McpConnectionStatus> {
    const result = await this.transport.request<{ status: McpConnectionStatus }>(
      "mcp.servers.test",
      `/api/workspaces/${id(this.workspaceId)}/mcp/servers/${id(serverId)}/test`,
      {
        method: "POST",
        workspaceId: this.workspaceId,
      }
    );
    return result.status;
  }
}

export class OrchestrationResource {
  constructor(
    private readonly transport: CesiumTransport,
    private readonly workspaceId: string
  ) {}

  async listBoards(): Promise<OrchestrationBoardRecord[]> {
    const result = await this.transport.request<{ boards: OrchestrationBoardRecord[] }>(
      "orchestration.boards.list",
      "/api/orchestration/boards",
      { workspaceId: this.workspaceId }
    );
    return result.boards;
  }

  async createBoard(input?: {
    title?: string;
    description?: string;
  }): Promise<OrchestrationBoardRecord> {
    const result = await this.transport.request<{ board: OrchestrationBoardRecord }>(
      "orchestration.boards.create",
      "/api/orchestration/boards",
      {
        method: "POST",
        workspaceId: this.workspaceId,
        json: input ?? {},
      }
    );
    return result.board;
  }

  getBoard(boardId: string): Promise<OrchestrationBoardSnapshot> {
    return this.transport.request(
      "orchestration.boards.get",
      `/api/orchestration/boards/${id(boardId)}`,
      { workspaceId: this.workspaceId }
    );
  }

  updateBoard(
    boardId: string,
    patch: {
      title?: string;
      description?: string;
      archived?: boolean;
    }
  ): Promise<OrchestrationBoardSnapshot> {
    return this.transport.request(
      "orchestration.boards.update",
      `/api/orchestration/boards/${id(boardId)}`,
      {
        method: "PATCH",
        workspaceId: this.workspaceId,
        json: patch,
      }
    );
  }

  async removeBoard(boardId: string): Promise<void> {
    await this.transport.request(
      "orchestration.boards.remove",
      `/api/orchestration/boards/${id(boardId)}`,
      {
        method: "DELETE",
        workspaceId: this.workspaceId,
      }
    );
  }

  createIssue(
    boardId: string,
    input: {
      title: string;
      description?: string;
      columnId?: OrchestrationColumnId;
      priority?: OrchestrationIssuePriority;
      acceptanceCriteria?: string[];
      dependencyIssueIds?: string[];
    }
  ): Promise<OrchestrationBoardSnapshot> {
    return this.transport.request(
      "orchestration.issues.create",
      `/api/orchestration/boards/${id(boardId)}/issues`,
      {
        method: "POST",
        workspaceId: this.workspaceId,
        json: input,
      }
    );
  }
}

export class WorkspaceResource {
  readonly conversations: ConversationsResource;
  readonly files: FilesResource;
  readonly terminals: TerminalsResource;
  readonly git: GitResource;
  readonly mcp: McpResource;
  readonly orchestration: OrchestrationResource;

  constructor(
    readonly id: string,
    transport: CesiumTransport
  ) {
    this.conversations = new ConversationsResource(transport, id);
    this.files = new FilesResource(transport, id);
    this.terminals = new TerminalsResource(transport, id);
    this.git = new GitResource(transport, id);
    this.mcp = new McpResource(transport, id);
    this.orchestration = new OrchestrationResource(transport, id);
  }
}

export class AgentsResource {
  constructor(private readonly transport: CesiumTransport) {}

  listAllConversations(options?: PageOptions): Promise<AgentConversationGroupsResult> {
    return this.transport.request(
      "conversations.listAll",
      "/api/agents/conversations/all",
      {
        query: {
          limit: finiteInteger(options?.limit),
          cursor: options?.cursor,
        },
        signal: options?.signal,
      }
    );
  }

  createStandalone(
    input: CreateStandaloneConversationInput,
    options?: { signal?: AbortSignal }
  ): Promise<ConversationSnapshotResponse & { workspace: WorkspaceRecord }> {
    return this.transport.request(
      "conversations.createStandalone",
      "/api/agents/conversations/standalone/create-and-prompt",
      {
        method: "POST",
        json: input,
        signal: options?.signal,
      }
    );
  }

  models(): Promise<{ byBackend: Record<string, Array<{ id: string; name: string }>> }> {
    return this.transport.request(
      "agents.models",
      "/api/settings/models-by-backend"
    );
  }
}

export class SettingsResource {
  constructor(private readonly transport: CesiumTransport) {}

  async getGlobal<TSettings = unknown>(options?: {
    signal?: AbortSignal;
  }): Promise<{ settings: TSettings; revision?: number; etag: string | null }> {
    const response = await this.transport.raw("/api/settings/global", {
      signal: options?.signal,
    });
    const etag = response.headers.get("etag");
    const body = await this.transport.parseResponse<{
      settings: TSettings;
      revision?: number;
    }>("settings.global.get", response);
    return { ...body, etag };
  }

  async updateGlobal<TSettings>(
    settings: TSettings,
    options?: { etag?: string; signal?: AbortSignal }
  ): Promise<{ ok: true; revision?: number; etag: string | null }> {
    const response = await this.transport.raw("/api/settings/global", {
      method: "PUT",
      headers: options?.etag ? { "if-match": options.etag } : undefined,
      json: { settings },
      signal: options?.signal,
    });
    const etag = response.headers.get("etag");
    const body = await this.transport.parseResponse<{
      ok: true;
      revision?: number;
    }>("settings.global.update", response);
    return { ...body, etag };
  }

  models(): Promise<ModelToggleState> {
    return this.transport.request("settings.models.list", "/api/settings/models");
  }

  refreshModels(): Promise<
    ModelToggleState & { timedOut: string[]; failed: string[] }
  > {
    return this.transport.request(
      "settings.models.refresh",
      "/api/settings/models/refresh",
      { method: "POST" }
    );
  }

  updateModelToggles(toggles: ModelToggleUpdate[]): Promise<ModelToggleState> {
    return this.transport.request(
      "settings.models.update",
      "/api/settings/models/toggles",
      { method: "PUT", json: { toggles } }
    );
  }

  async cesiumAgent(): Promise<CesiumAgentSettingsPublic> {
    const result = await this.transport.request<{
      settings: CesiumAgentSettingsPublic;
    }>("settings.cesiumAgent.get", "/api/settings/cesium-agent");
    return result.settings;
  }

  async updateCesiumAgent(
    patch: Partial<CesiumAgentSettingsPublic>
  ): Promise<CesiumAgentSettingsPublic> {
    const result = await this.transport.request<{
      ok: true;
      settings: CesiumAgentSettingsPublic;
    }>("settings.cesiumAgent.update", "/api/settings/cesium-agent", {
      method: "PATCH",
      json: patch,
    });
    return result.settings;
  }

  async cesiumModels(): Promise<CesiumModelCatalogEntry[]> {
    const result = await this.transport.request<{
      models: CesiumModelCatalogEntry[];
    }>("settings.cesiumAgent.models", "/api/settings/cesium-agent/models");
    return result.models;
  }
}

export class CloudAgentsResource {
  constructor(private readonly transport: CesiumTransport) {}

  getSettings(): Promise<{
    settings: CloudAgentSettingsPublic;
    endpoints: CloudAgentEndpoints;
  }> {
    return this.transport.request(
      "cloudAgents.settings.get",
      "/api/cloud-agents/settings",
      {
        schema: {
          parse(value) {
            const payload = value as {
              settings: unknown;
              endpoints: CloudAgentEndpoints;
            };
            return {
              settings: CloudAgentSettingsSchema.parse(payload.settings),
              endpoints: payload.endpoints,
            };
          },
        },
      }
    );
  }

  updateSettings(patch: {
    defaults?: Partial<CloudAgentSettingsPublic["defaults"]>;
    routingRules?: CloudAgentRoutingRule[];
  }): Promise<{ ok: true; settings: CloudAgentSettingsPublic }> {
    return this.transport.request(
      "cloudAgents.settings.update",
      "/api/cloud-agents/settings",
      { method: "PATCH", json: patch }
    );
  }

  saveConnectionToken(input: {
    providerId: CloudAgentProviderId;
    accessToken: string;
    webhookSecret?: string;
  }): Promise<{ ok: true; settings: CloudAgentSettingsPublic }> {
    return this.transport.request(
      "cloudAgents.connections.token",
      `/api/cloud-agents/connections/${id(input.providerId)}/token`,
      { method: "PUT", json: input }
    );
  }

  removeConnection(
    providerId: CloudAgentProviderId
  ): Promise<{ ok: true; settings: CloudAgentSettingsPublic }> {
    return this.transport.request(
      "cloudAgents.connections.remove",
      `/api/cloud-agents/connections/${id(providerId)}`,
      { method: "DELETE" }
    );
  }

  listTasks(options?: {
    workspaceId?: string;
    status?: CloudAgentTaskStatus;
    signal?: AbortSignal;
  }): Promise<{ tasks: CloudAgentTaskRecord[] }> {
    return this.transport.request(
      "cloudAgents.tasks.list",
      "/api/cloud-agents/tasks",
      {
        query: {
          workspaceId: options?.workspaceId,
          status: options?.status,
        },
        signal: options?.signal,
        schema: CloudAgentTasksResponseSchema,
      }
    );
  }

  async getTask(taskId: string): Promise<CloudAgentTaskRecord> {
    const result = await this.transport.request<
      CloudAgentTaskRecord | { task: CloudAgentTaskRecord }
    >("cloudAgents.tasks.get", `/api/cloud-agents/tasks/${id(taskId)}`);
    return CloudAgentTaskSchema.parse(
      "task" in (result as { task?: unknown })
        ? (result as { task: unknown }).task
        : result
    );
  }

  async createTask(input: CreateCloudAgentTaskInput): Promise<CloudAgentTaskRecord> {
    const result = await this.transport.request<{
      ok: boolean;
      task: CloudAgentTaskRecord;
      error?: string;
    }>("cloudAgents.tasks.create", "/api/cloud-agents/tasks", {
      method: "POST",
      json: input,
    });
    return CloudAgentTaskSchema.parse(result.task);
  }

  dispatchTask(
    taskId: string,
    overrides?: {
      workspaceId?: string;
      backendId?: AgentBackendId;
      modelId?: string;
      executionMode?: CloudAgentExecutionMode;
    }
  ): Promise<{ ok: true; task: CloudAgentTaskRecord }> {
    return this.taskAction(taskId, "dispatch", overrides ?? {});
  }

  steerTask(
    taskId: string,
    text: string
  ): Promise<{ ok: true; task: CloudAgentTaskRecord }> {
    return this.taskAction(taskId, "steer", { text });
  }

  cancelTask(taskId: string): Promise<{ ok: true; task: CloudAgentTaskRecord }> {
    return this.taskAction(taskId, "cancel", {});
  }

  completeTask(taskId: string): Promise<{ ok: true; task: CloudAgentTaskRecord }> {
    return this.taskAction(taskId, "complete", {});
  }

  artifacts(taskId: string): Promise<{ artifacts: CloudAgentTaskArtifact[] }> {
    return this.transport.request(
      "cloudAgents.tasks.artifacts",
      `/api/cloud-agents/tasks/${id(taskId)}/artifacts`
    );
  }

  removeTask(taskId: string): Promise<{ ok: true }> {
    return this.transport.request(
      "cloudAgents.tasks.remove",
      `/api/cloud-agents/tasks/${id(taskId)}`,
      { method: "DELETE" }
    );
  }

  private taskAction(
    taskId: string,
    action: "dispatch" | "steer" | "cancel" | "complete",
    body: unknown
  ): Promise<{ ok: true; task: CloudAgentTaskRecord }> {
    return this.transport.request(
      `cloudAgents.tasks.${action}`,
      `/api/cloud-agents/tasks/${id(taskId)}/${action}`,
      { method: "POST", json: body }
    );
  }
}

export class StorageResource {
  constructor(private readonly transport: CesiumTransport) {}

  status(options?: { signal?: AbortSignal }): Promise<StorageStatus> {
    return this.transport.request("storage.status", "/api/storage/status", {
      signal: options?.signal,
    });
  }
}

export function requestOptionsWithWorkspace(
  workspaceId: string,
  options?: CesiumRequestOptions
): CesiumRequestOptions {
  return { ...options, workspaceId };
}
