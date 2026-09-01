/**
 * `/api/agents/*` against the browser conversation store, with turn
 * execution delegated to the in-page Cesium harness (see harness/).
 */
import type {
  AgentBackendInfo,
  AgentConversationConfigPatch,
  AgentConversationCreateInput,
  AgentConversationMetadataPatch,
  AgentConversationRecord,
  AgentConversationSnapshotHead,
  ImageAttachment,
  AgentRailConversationSummary,
  WorkspaceRecord,
} from "@cesium/core";
import { errorResponse, jsonResponse, type EngineRequest, type EngineRouter } from "../http";
import type { ConversationStore } from "../stores/conversations";
import type { SettingsStore } from "../stores/settings";
import type { WorkspaceStore } from "../stores/workspaces";
import { buildBrowserBackendInfo, buildConfigOptions, CESIUM_AGENT_CAPABILITIES } from "../backend-info";
import { resolveSafePath } from "../paths";
import type { Vfs } from "../vfs";

export type PromptInput = {
  text: string;
  attachments?: ImageAttachment[];
  clientEventId?: string;
  clientMessageId?: string;
  clientTimezone?: string;
};

/** Turn execution contract implemented by the browser harness. */
export type BrowserAgentRuntime = {
  promptConversation(
    workspace: WorkspaceRecord,
    conversationId: string,
    input: PromptInput
  ): Promise<AgentConversationSnapshotHead>;
  cancelConversation(
    workspace: WorkspaceRecord,
    conversationId: string
  ): Promise<AgentConversationRecord>;
  answerPermission(
    workspace: WorkspaceRecord,
    conversationId: string,
    input: { requestId: string; optionId?: string; cancelled?: boolean }
  ): Promise<AgentConversationRecord>;
  answerQuestion(
    workspace: WorkspaceRecord,
    conversationId: string,
    input: { questionId: string; answer: string }
  ): Promise<AgentConversationRecord>;
  retryConversation(
    workspace: WorkspaceRecord,
    conversationId: string
  ): Promise<AgentConversationSnapshotHead>;
};

const FILE_UPLOADS_DIR = ".cesium/file-uploads";

function newConversationId(): string {
  return crypto.randomUUID();
}

function toRailSummary(record: AgentConversationRecord): AgentRailConversationSummary {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastEventSeq: record.lastEventSeq,
    status: record.status,
    archivedAt: record.archivedAt,
    backendId: record.config.backendId,
    mode: record.config.mode,
    experimental: record.experimental,
    hasPendingPermission: Boolean(record.pendingPermission),
    hasPendingQuestion: Boolean(record.pendingQuestion),
    settledAt: record.settledAt ?? null,
    settledUntil: record.settledUntil ?? null,
    pendingPermissionTitle: record.pendingPermission?.title ?? null,
    lastErrorSummary: record.lastError ? record.lastError.split("\n")[0]?.slice(0, 200) ?? null : null,
    origin: record.origin ?? null,
    executionTarget: record.config.executionTarget ?? "local",
  };
}

function draftTitleFromText(text: string): string {
  const firstLine = text.trim().split("\n")[0] ?? "";
  const cleaned = firstLine.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Untitled";
  return cleaned.length > 64 ? `${cleaned.slice(0, 61)}…` : cleaned;
}

export function registerAgentRoutes(
  router: EngineRouter,
  deps: {
    vfs: Vfs;
    workspaces: WorkspaceStore;
    conversations: ConversationStore;
    settings: SettingsStore;
    runtime: () => BrowserAgentRuntime;
  }
): void {
  const { vfs, workspaces, conversations, settings } = deps;

  async function requireWorkspace(request: EngineRequest): Promise<WorkspaceRecord> {
    if (!request.workspaceId) {
      throw new Error("Missing x-opencursor-workspace-id header");
    }
    const workspace = await workspaces.getById(request.workspaceId);
    if (!workspace) {
      throw new Error(`Unknown workspace: ${request.workspaceId}`);
    }
    return workspace;
  }

  async function backendCatalog(): Promise<AgentBackendInfo[]> {
    const defaults = await settings.resolveDefaultModel();
    return [
      buildBrowserBackendInfo({ modelId: defaults.modelId, modelName: defaults.modelName }),
    ];
  }

  async function createConversation(
    workspace: WorkspaceRecord,
    input: AgentConversationCreateInput
  ): Promise<AgentConversationRecord> {
    const defaults = await settings.resolveDefaultModel();
    const models = await settings.listModels();
    const now = Date.now();
    const mode = input.mode ?? "agent";
    const modelId = input.modelId || defaults.modelId;
    const modelName = input.modelName || defaults.modelName;
    const record: AgentConversationRecord = {
      schemaVersion: 1,
      id: newConversationId(),
      workspaceId: workspace.id,
      title: input.title?.trim() || "New chat",
      createdAt: now,
      updatedAt: now,
      lastEventSeq: 0,
      status: "idle",
      config: {
        backendId: "cesium-agent",
        mode,
        modelId,
        modelName,
        ...(input.profileId ? { profileId: input.profileId } : {}),
        executionTarget: "local",
      },
      providerSessionId: null,
      configOptions: buildConfigOptions({
        mode,
        modelId,
        models: models.map((model) => ({
          id: `${model.providerId}/${model.modelId}`,
          name: model.modelName,
        })),
      }),
      capabilities: CESIUM_AGENT_CAPABILITIES,
      pendingPermission: null,
      pendingQuestion: null,
      lastError: null,
      experimental: false,
      archivedAt: input.archived ? now : null,
      settledAt: null,
      settledUntil: null,
      lastReadSeq: 0,
      origin: input.origin ?? null,
      queuedPrompts: [],
    };
    await conversations.put(record);
    return record;
  }

  router.get("/api/agents/backends", async () => {
    const defaults = await settings.resolveDefaultModel();
    const backend = buildBrowserBackendInfo({
      modelId: defaults.modelId,
      modelName: defaults.modelName,
    });
    return jsonResponse({
      backends: [
        {
          id: backend.id,
          label: backend.label,
          description: backend.description,
          available: backend.available,
          experimental: backend.experimental ?? false,
          commandPreview: null,
          defaultModelId: backend.defaultModelId,
          defaultModelName: backend.defaultModelName,
          installer: null,
        },
      ],
      platform: "browser",
    });
  });

  router.get("/api/agents/conversations", async (request) => {
    const workspace = await requireWorkspace(request);
    const list = await conversations.listForWorkspace(workspace.id);
    return jsonResponse({
      backends: await backendCatalog(),
      conversations: list,
      nextCursor: null,
    });
  });

  router.get("/api/agents/conversations/all", async () => {
    const [allWorkspaces, backends] = await Promise.all([
      workspaces.list(),
      backendCatalog(),
    ]);
    const groups = [];
    for (const workspace of allWorkspaces) {
      const list = await conversations.listForWorkspace(workspace.id);
      if (list.length === 0) continue;
      groups.push({
        workspace,
        conversations: list.map(toRailSummary),
      });
    }
    groups.sort((a, b) => {
      const aLatest = a.conversations[0]?.updatedAt ?? 0;
      const bLatest = b.conversations[0]?.updatedAt ?? 0;
      return bLatest - aLatest;
    });
    return jsonResponse({ backends, groups, nextCursor: null });
  });

  router.post("/api/agents/conversations", async (request) => {
    const workspace = await requireWorkspace(request);
    const body = await request.json<AgentConversationCreateInput>();
    const conversation = await createConversation(workspace, body);
    return jsonResponse({ conversation }, 201);
  });

  router.post("/api/agents/conversations/create-and-prompt", async (request) => {
    const workspace = await requireWorkspace(request);
    const body = await request.json<{
      conversation?: AgentConversationCreateInput;
      text?: string;
      attachments?: ImageAttachment[];
      clientEventId?: string;
      clientMessageId?: string;
    }>();
    if (!body.text?.trim() && (!body.attachments || body.attachments.length === 0)) {
      return errorResponse("Expected prompt text or attachments.");
    }
    const conversation = await createConversation(workspace, {
      ...(body.conversation ?? {}),
      title: body.conversation?.title ?? draftTitleFromText(body.text ?? ""),
    });
    const snapshot = await deps.runtime().promptConversation(workspace, conversation.id, {
      text: body.text ?? "",
      attachments: body.attachments,
      clientEventId: body.clientEventId,
      clientMessageId: body.clientMessageId,
    });
    return jsonResponse({ snapshot }, 201);
  });

  async function createStandaloneWorkspace(title?: string): Promise<WorkspaceRecord> {
    const id = crypto.randomUUID().slice(0, 8);
    return workspaces.create({
      name: title?.trim() || `Chat ${id}`,
      root: `/workspaces/standalone-chats/${id}`,
      kind: "standalone-chat",
    });
  }

  router.post("/api/agents/conversations/standalone", async (request) => {
    const body = await request.json<{
      conversation?: AgentConversationCreateInput;
      title?: string;
    }>();
    const title = body.title?.trim() || body.conversation?.title?.trim();
    const workspace = await createStandaloneWorkspace(title);
    const conversation = await createConversation(workspace, {
      ...(body.conversation ?? {}),
      ...(title ? { title } : {}),
    });
    return jsonResponse({ conversation, workspace }, 201);
  });

  router.post("/api/agents/conversations/standalone/create-and-prompt", async (request) => {
    const body = await request.json<{
      conversation?: AgentConversationCreateInput;
      text?: string;
      attachments?: ImageAttachment[];
      clientEventId?: string;
      clientMessageId?: string;
      title?: string;
    }>();
    if (!body.text?.trim() && (!body.attachments || body.attachments.length === 0)) {
      return errorResponse("Expected prompt text or attachments.");
    }
    const workspace = await createStandaloneWorkspace(
      body.title ?? draftTitleFromText(body.text ?? "")
    );
    const conversation = await createConversation(workspace, {
      ...(body.conversation ?? {}),
      title: body.title ?? draftTitleFromText(body.text ?? ""),
    });
    const snapshot = await deps.runtime().promptConversation(workspace, conversation.id, {
      text: body.text ?? "",
      attachments: body.attachments,
      clientEventId: body.clientEventId,
      clientMessageId: body.clientMessageId,
    });
    return jsonResponse({ snapshot, workspace }, 201);
  });

  router.post("/api/agents/conversations/draft-title", async (request) => {
    const body = await request.json<{ text?: string }>();
    if (!body.text?.trim()) {
      return errorResponse("Text is required");
    }
    return jsonResponse({ title: draftTitleFromText(body.text) });
  });

  router.get("/api/agents/conversations/:conversationId/context-usage", async (request) => {
    const workspace = await requireWorkspace(request);
    const conversationId = request.params.conversationId ?? "";
    const record = await conversations.get(workspace.id, conversationId);
    if (!record) {
      return errorResponse(`Unknown conversation: ${conversationId}`, 404);
    }
    const events = await conversations.readEvents(conversationId);
    const approxChars = events.reduce((total, event) => {
      if (event.kind === "user_message") return total + event.content.length;
      if (event.kind === "assistant_message_chunk") return total + event.text.length;
      if (event.kind === "tool_call" || event.kind === "tool_call_update") {
        return total + (event.detail?.length ?? 0);
      }
      return total;
    }, 0);
    const usedTokens = Math.ceil(approxChars / 4);
    const limitTokens = 200_000;
    return jsonResponse({
      usage: {
        supported: true,
        limitTokens,
        usedTokens,
        percentFull: Math.min(100, Math.round((usedTokens / limitTokens) * 100)),
        categories: [
          {
            id: "conversation",
            label: "Conversation",
            tokens: usedTokens,
            colorKey: "conversation",
          },
        ],
        approximate: true,
      },
    });
  });

  router.get("/api/agents/conversations/:conversationId", async (request) => {
    const workspace = await requireWorkspace(request);
    const conversationId = request.params.conversationId ?? "";
    const full = request.url.searchParams.get("full") === "1";
    const limitTurnsRaw = request.url.searchParams.get("limitTurns");
    const limitEventsRaw = request.url.searchParams.get("limitEvents");
    if (full) {
      const snapshot = await conversations.readSnapshot(workspace.id, conversationId);
      if (!snapshot) {
        return errorResponse(`Unknown conversation: ${conversationId}`, 404);
      }
      return jsonResponse({ snapshot });
    }
    const snapshot = await conversations.readSnapshotHead(workspace.id, conversationId, {
      limitTurns: limitTurnsRaw ? Number(limitTurnsRaw) : undefined,
      limitEvents: limitEventsRaw ? Number(limitEventsRaw) : undefined,
    });
    if (!snapshot) {
      return errorResponse(`Unknown conversation: ${conversationId}`, 404);
    }
    return jsonResponse({ snapshot });
  });

  router.patch("/api/agents/conversations/:conversationId/config", async (request) => {
    const workspace = await requireWorkspace(request);
    const conversationId = request.params.conversationId ?? "";
    const patch = await request.json<AgentConversationConfigPatch>();
    const conversation = await conversations.update(workspace.id, conversationId, (current) => {
      const nextConfig = { ...current.config };
      if (patch.mode) nextConfig.mode = patch.mode;
      if (patch.modelId) nextConfig.modelId = patch.modelId;
      if (patch.modelName) nextConfig.modelName = patch.modelName;
      if (patch.profileId) nextConfig.profileId = patch.profileId;
      let configOptions = current.configOptions;
      const applyOption = (configId: string, value: string): void => {
        configOptions = configOptions.map((option) =>
          option.id === configId ? { ...option, currentValue: value } : option
        );
        if (configId === "mode") nextConfig.mode = value;
        if (configId === "model") {
          nextConfig.modelId = value;
          const modelOption = configOptions.find((option) => option.id === "model");
          const chosen = modelOption?.options.find((entry) => entry.value === value);
          nextConfig.modelName = chosen?.name ?? value;
        }
      };
      if (patch.setConfigOption) {
        applyOption(patch.setConfigOption.configId, patch.setConfigOption.value);
      }
      for (const entry of patch.setConfigOptions ?? []) {
        applyOption(entry.configId, entry.value);
      }
      return {
        ...current,
        title: patch.title?.trim() ? patch.title.trim() : current.title,
        config: nextConfig,
        configOptions,
        updatedAt: Date.now(),
      };
    });
    return jsonResponse({ conversation });
  });

  router.patch("/api/agents/conversations/:conversationId/metadata", async (request) => {
    const workspace = await requireWorkspace(request);
    const conversationId = request.params.conversationId ?? "";
    const patch = await request.json<AgentConversationMetadataPatch>();
    const conversation = await conversations.update(workspace.id, conversationId, (current) => ({
      ...current,
      archivedAt:
        patch.archived === undefined ? current.archivedAt : patch.archived ? Date.now() : null,
      settledAt:
        patch.settled === undefined ? (current.settledAt ?? null) : patch.settled ? Date.now() : null,
      settledUntil:
        patch.settled && typeof patch.settledForMs === "number"
          ? Date.now() + patch.settledForMs
          : patch.settled === false
            ? null
            : (current.settledUntil ?? null),
      lastReadSeq:
        typeof patch.lastReadSeq === "number" ? patch.lastReadSeq : current.lastReadSeq,
      updatedAt: Date.now(),
    }));
    return jsonResponse({ conversation });
  });

  router.post("/api/agents/conversations/:conversationId/prompt", async (request) => {
    const workspace = await requireWorkspace(request);
    const conversationId = request.params.conversationId ?? "";
    const body = await request.json<{
      text?: string;
      attachments?: ImageAttachment[];
      clientEventId?: string;
      clientMessageId?: string;
      clientTimezone?: string;
    }>();
    if (!body.text?.trim() && (!body.attachments || body.attachments.length === 0)) {
      return errorResponse("Expected prompt text or attachments.");
    }
    const snapshot = await deps.runtime().promptConversation(workspace, conversationId, {
      text: body.text ?? "",
      attachments: body.attachments,
      clientEventId: body.clientEventId,
      clientMessageId: body.clientMessageId,
      clientTimezone: body.clientTimezone,
    });
    return jsonResponse({ snapshot });
  });

  router.post("/api/agents/conversations/:conversationId/cancel", async (request) => {
    const workspace = await requireWorkspace(request);
    const conversationId = request.params.conversationId ?? "";
    const conversation = await deps.runtime().cancelConversation(workspace, conversationId);
    return jsonResponse({ conversation });
  });

  router.post("/api/agents/conversations/:conversationId/retry", async (request) => {
    const workspace = await requireWorkspace(request);
    const conversationId = request.params.conversationId ?? "";
    const snapshot = await deps.runtime().retryConversation(workspace, conversationId);
    return jsonResponse({ snapshot });
  });

  router.post("/api/agents/conversations/:conversationId/permission", async (request) => {
    const workspace = await requireWorkspace(request);
    const conversationId = request.params.conversationId ?? "";
    const body = await request.json<{
      requestId?: string;
      optionId?: string;
      cancelled?: boolean;
    }>();
    if (!body.requestId) {
      return errorResponse("Expected requestId.");
    }
    const conversation = await deps.runtime().answerPermission(workspace, conversationId, {
      requestId: body.requestId,
      optionId: body.optionId,
      cancelled: body.cancelled,
    });
    return jsonResponse({ conversation });
  });

  router.post("/api/agents/conversations/:conversationId/question", async (request) => {
    const workspace = await requireWorkspace(request);
    const conversationId = request.params.conversationId ?? "";
    const body = await request.json<{ questionId?: string; answer?: string }>();
    if (!body.questionId?.trim()) {
      return errorResponse("Expected questionId.");
    }
    if (!body.answer?.trim()) {
      return errorResponse("Expected answer.");
    }
    const conversation = await deps.runtime().answerQuestion(workspace, conversationId, {
      questionId: body.questionId.trim(),
      answer: body.answer.trim(),
    });
    return jsonResponse({ conversation });
  });

  for (const unsupported of ["pause", "resume", "redo", "fork", "handoff", "relocate"] as const) {
    router.post(`/api/agents/conversations/:conversationId/${unsupported}`, async () =>
      errorResponse(`${unsupported} is not supported on the browser machine yet.`)
    );
  }

  router.delete("/api/agents/conversations/:conversationId/queue/:itemId", async (request) => {
    const workspace = await requireWorkspace(request);
    const conversationId = request.params.conversationId ?? "";
    const itemId = request.params.itemId ?? "";
    const conversation = await conversations.update(workspace.id, conversationId, (current) => ({
      ...current,
      queuedPrompts: current.queuedPrompts.filter((item) => item.id !== itemId),
    }));
    return jsonResponse({ conversation });
  });

  router.post("/api/agents/attachments", async (request) => {
    const workspace = await requireWorkspace(request);
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return errorResponse("Invalid multipart body");
    }
    const files = form.getAll("files");
    if (files.length === 0) {
      return errorResponse("Expected files field with at least one file");
    }
    const uploadsDir = resolveSafePath(workspace.root, FILE_UPLOADS_DIR);
    if (!vfs.exists(uploadsDir)) {
      vfs.mkdir(uploadsDir, { recursive: true });
    }
    const attachments: Array<{
      id: string;
      path: string;
      name: string;
      size: number;
      mimeType: string;
    }> = [];
    for (const file of files) {
      if (typeof file === "string") continue;
      const id = crypto.randomUUID();
      const mimeType = file.type || "application/octet-stream";
      const base = (file.name ?? "").split(/[\\/]/).pop()?.trim() || `upload-${id.slice(0, 8)}`;
      const cleaned = base.replace(/[<>:"|?*]/g, "_").replace(/^\.+/, "").slice(0, 128) || `upload-${id.slice(0, 8)}`;
      let fileName = cleaned;
      let attempt = 2;
      while (vfs.exists(`${uploadsDir}/${fileName}`) && attempt < 1000) {
        const dot = cleaned.lastIndexOf(".");
        fileName =
          dot > 0
            ? `${cleaned.slice(0, dot)}-${attempt}${cleaned.slice(dot)}`
            : `${cleaned}-${attempt}`;
        attempt += 1;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      vfs.writeFile(`${uploadsDir}/${fileName}`, bytes);
      attachments.push({
        id,
        path: `${FILE_UPLOADS_DIR}/${fileName}`,
        name: fileName,
        size: bytes.byteLength,
        mimeType,
      });
    }
    return jsonResponse({ attachments });
  });

  router.get("/api/agents/triggers", async () => jsonResponse({ triggers: [] }));
  router.get("/api/agents/diagnostics/harness", async () =>
    jsonResponse({ entries: [], files: [] })
  );
}
