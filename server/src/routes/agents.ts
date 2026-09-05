import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { requireWorkspaceFromRequest } from "../lib/request-workspace.js";
import { resolveSafePath } from "../lib/workspace.js";
import { agentRuntimeManager } from "../lib/agents/runtime-manager.js";
import {
  RAIL_ALL_FIRST_PAGE_CACHE_KEY,
  RAIL_ALL_FIRST_PAGE_CACHE_TTL_SEC,
} from "../lib/agents/cache-keys.js";
import {
  type AgentConversationsAllPayload,
  buildAgentConversationsAllPayload,
} from "../lib/agents/rail-payload.js";
import { getJSON, setJSON } from "../cache/kv.js";
import { generateTitleFromText } from "../lib/agents/title-generator.js";
import type {
  AgentBackendId,
  AgentPromptAttachment,
  AgentConversationConfigPatch,
  AgentConversationCreateInput,
  AgentConversationMetadataPatch,
  AgentQueuedChatPrompt,
} from "../lib/agents/types.js";
import { createStandaloneChatWorkspace } from "../lib/standalone-chats.js";
import { expireElapsedSettle } from "../lib/agents/conversation-normalize.js";
import { maybeAutoSyncImportedConversation } from "../lib/agents/import/importer.js";
import { readConversationRecord } from "../lib/agents/session-store.js";
import {
  harnessDiagnosticsFilePaths,
  readHarnessDiagnostics,
  type HarnessDiagnosticLevel,
} from "../lib/agents/harness-diagnostics.js";
import { FILE_UPLOADS_DIR } from "../lib/agents/attachment-reminders.js";
import { ensureCesiumDirGitignored } from "../lib/artifacts/store.js";
import { listWorkspaces } from "../lib/workspace-registry.js";
import {
  deleteCesiumTrigger,
  listCesiumTriggers,
  updateCesiumTrigger,
} from "../lib/agents/cesium-triggers.js";

export const agentRoutes = new Hono();

const HARNESS_DIAGNOSTIC_LEVELS: HarnessDiagnosticLevel[] = [
  "debug",
  "info",
  "warning",
  "error",
];

function parseHarnessDiagnosticsQuery(c: {
  req: { query(name: string): string | undefined };
}): {
  backendId?: string;
  minLevel?: HarnessDiagnosticLevel;
  limit?: number;
  afterSeq?: number;
} {
  const levelRaw = c.req.query("level");
  const limitRaw = Number.parseInt(c.req.query("limit") ?? "", 10);
  const afterSeqRaw = Number.parseInt(c.req.query("afterSeq") ?? "", 10);
  const backendId = c.req.query("backendId")?.trim();
  return {
    ...(backendId ? { backendId } : {}),
    ...(levelRaw && HARNESS_DIAGNOSTIC_LEVELS.includes(levelRaw as HarnessDiagnosticLevel)
      ? { minLevel: levelRaw as HarnessDiagnosticLevel }
      : {}),
    ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: limitRaw } : {}),
    ...(Number.isFinite(afterSeqRaw) && afterSeqRaw >= 0 ? { afterSeq: afterSeqRaw } : {}),
  };
}

function parsePageParams(c: {
  req: { query(name: string): string | undefined };
}): { limit?: number; cursor?: string | null } {
  const limitRaw = c.req.query("limit");
  const cursorRaw = c.req.query("cursor");
  const limitNum = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
  return {
    limit: Number.isFinite(limitNum) && limitNum > 0 ? limitNum : undefined,
    cursor: cursorRaw && cursorRaw.length > 0 ? cursorRaw : undefined,
  };
}

agentRoutes.get("/api/agents/diagnostics/harness", async (c) => {
  const conversationId = c.req.query("conversationId")?.trim();
  const entries = await readHarnessDiagnostics({
    ...(conversationId ? { conversationId } : {}),
    ...parseHarnessDiagnosticsQuery(c),
  });
  return c.json({ entries, files: harnessDiagnosticsFilePaths() });
});

agentRoutes.get(
  "/api/agents/conversations/:conversationId/diagnostics",
  async (c) => {
    const conversationId = c.req.param("conversationId");
    const entries = await readHarnessDiagnostics({
      conversationId,
      ...parseHarnessDiagnosticsQuery(c),
    });
    return c.json({ entries });
  }
);

agentRoutes.get("/api/agents/conversations", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const { limit, cursor } = parsePageParams(c);
  const result = await agentRuntimeManager.listWorkspaceConversations(
    workspace.id,
    { limit, cursor }
  );
  // Agent events stream over WS, so a short browser cache is safe: a fresh
  // page load serves from cache instantly while WS catches it up with any
  // tail events. Do NOT cache the full snapshot endpoint, which changes on
  // every token during a running turn.
  c.header(
    "Cache-Control",
    "private, max-age=5, stale-while-revalidate=30"
  );
  return c.json(result);
});

agentRoutes.get("/api/agents/conversations/all", async (c) => {
  const { limit: limitRaw, cursor: cursorRaw } = parsePageParams(c);
  const limit = Math.max(1, Math.min(Math.floor(limitRaw ?? 500), 1000));
  const isFirstPage = !cursorRaw;
  const railAllCacheOn =
    isFirstPage && process.env.NODE_ENV !== "test";
  if (railAllCacheOn) {
    const cached = await getJSON<AgentConversationsAllPayload>(RAIL_ALL_FIRST_PAGE_CACHE_KEY);
    if (cached) {
      c.header("Cache-Control", "private, max-age=5, stale-while-revalidate=30");
      // Timed settles may have elapsed while the page sat in cache.
      return c.json({
        ...cached,
        groups: cached.groups.map((group) => ({
          ...group,
          conversations: group.conversations.map((conversation) =>
            expireElapsedSettle(conversation)
          ),
        })),
      });
    }
  }
  const offset = Math.max(0, cursorRaw ? Number.parseInt(cursorRaw, 10) || 0 : 0);
  const body: AgentConversationsAllPayload = await buildAgentConversationsAllPayload({
    limit,
    offset,
  });
  c.header("Cache-Control", "private, max-age=5, stale-while-revalidate=30");
  if (railAllCacheOn) {
    await setJSON(
      RAIL_ALL_FIRST_PAGE_CACHE_KEY,
      body,
      RAIL_ALL_FIRST_PAGE_CACHE_TTL_SEC
    );
  }
  return c.json(body);
});

agentRoutes.post("/api/agents/conversations", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const body = await c.req.json<AgentConversationCreateInput>();
  const conversation = await agentRuntimeManager.createConversation(workspace, body);
  return c.json({ conversation }, 201);
});

agentRoutes.post("/api/agents/conversations/create-and-prompt", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const body = await c.req.json<{
    conversation?: AgentConversationCreateInput;
    text?: string;
    attachments?: AgentPromptAttachment[];
    clientEventId?: string;
    clientMessageId?: string;
    configOverride?: AgentQueuedChatPrompt["configOverride"];
  }>();
  if (!body.text?.trim() && (!body.attachments || body.attachments.length === 0)) {
    return c.json({ error: "Expected prompt text or attachments." }, 400);
  }
  const snapshot = await agentRuntimeManager.createConversationWithPrompt(
    workspace,
    body.conversation ?? {},
    {
      text: body.text ?? "",
      ...(body.attachments ? { attachments: body.attachments } : {}),
      ...(body.clientEventId ? { clientEventId: body.clientEventId } : {}),
      ...(body.clientMessageId ? { clientMessageId: body.clientMessageId } : {}),
      ...(body.configOverride ? { configOverride: body.configOverride } : {}),
    }
  );
  return c.json({ snapshot }, 201);
});

/**
 * Persist a new-chat composer as a standalone draft: sandbox workspace +
 * empty conversation with a provisional title. No prompt yet.
 */
agentRoutes.post("/api/agents/conversations/standalone", async (c) => {
  const body = await c.req.json<{
    conversation?: AgentConversationCreateInput;
    title?: string;
  }>();
  const title = body.title?.trim() || body.conversation?.title?.trim();
  const workspace = await createStandaloneChatWorkspace(title, {
    backendId: body.conversation?.backendId,
    mode: body.conversation?.mode,
    modelId: body.conversation?.modelId,
    modelName: body.conversation?.modelName,
  });
  const conversation = await agentRuntimeManager.createConversation(workspace, {
    ...(body.conversation ?? {}),
    ...(title ? { title } : {}),
  });
  return c.json({ conversation, workspace }, 201);
});

/**
 * Create a chat with no project workspace: spins up a temporary directory +
 * ephemeral workspace, then creates and prompts the conversation there.
 * Does not require `x-opencursor-workspace-id`.
 */
agentRoutes.post("/api/agents/conversations/standalone/create-and-prompt", async (c) => {
  const body = await c.req.json<{
    conversation?: AgentConversationCreateInput;
    text?: string;
    attachments?: AgentPromptAttachment[];
    clientEventId?: string;
    clientMessageId?: string;
    title?: string;
  }>();
  if (!body.text?.trim() && (!body.attachments || body.attachments.length === 0)) {
    return c.json({ error: "Expected prompt text or attachments." }, 400);
  }
  const workspace = await createStandaloneChatWorkspace(body.title, {
    backendId: body.conversation?.backendId,
    mode: body.conversation?.mode,
    modelId: body.conversation?.modelId,
    modelName: body.conversation?.modelName,
  });
  const snapshot = await agentRuntimeManager.createConversationWithPrompt(
    workspace,
    body.conversation ?? {},
    {
      text: body.text ?? "",
      ...(body.attachments ? { attachments: body.attachments } : {}),
      ...(body.clientEventId ? { clientEventId: body.clientEventId } : {}),
      ...(body.clientMessageId ? { clientMessageId: body.clientMessageId } : {}),
    }
  );
  return c.json({ snapshot, workspace }, 201);
});

agentRoutes.post("/api/agents/conversations/draft-title", async (c) => {
  await requireWorkspaceFromRequest(c);
  const body = await c.req.json<{ text: string }>();
  if (!body.text || !body.text.trim()) {
    return c.json({ error: "Text is required" }, 400);
  }
  const title = await generateTitleFromText(body.text);
  return c.json({ title: title ?? "Untitled" });
});

agentRoutes.get("/api/agents/conversations/:conversationId/context-usage", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const conversationId = c.req.param("conversationId");
  c.header("Cache-Control", "no-store, max-age=0");
  const usage = await agentRuntimeManager.getConversationContextUsage(
    workspace,
    conversationId
  );
  if (!usage) {
    return c.json({ error: `Unknown conversation: ${conversationId}` }, 404);
  }
  return c.json({ usage });
});

agentRoutes.get("/api/agents/conversations/:conversationId", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const conversationId = c.req.param("conversationId");
  const hydrateRuntime = c.req.query("hydrate") === "1";
  const full = c.req.query("full") === "1";
  const limitTurnsRaw = c.req.query("limitTurns");
  const limitEventsRaw = c.req.query("limitEvents");
  const limitTurns =
    limitTurnsRaw && Number.isFinite(Number(limitTurnsRaw)) ? Number(limitTurnsRaw) : undefined;
  const limitEvents =
    limitEventsRaw && Number.isFinite(Number(limitEventsRaw)) ? Number(limitEventsRaw) : undefined;

  // A running turn changes the snapshot on every streamed event. Never cache.
  c.header("Cache-Control", "no-store, max-age=0");

  // Imported conversations transparently pick up turns the user ran in the
  // source CLI since the last sync - no manual re-sync step exists.
  const record = await readConversationRecord(workspace.id, conversationId);
  if (record?.origin?.kind === "import") {
    await maybeAutoSyncImportedConversation(workspace, record);
  }

  if (full) {
    const snapshot = await agentRuntimeManager.getConversationSnapshot(workspace, conversationId, {
      hydrateRuntime,
    });
    if (!snapshot) {
      return c.json({ error: `Unknown conversation: ${conversationId}` }, 404);
    }
    return c.json({ snapshot });
  }

  const snapshot = await agentRuntimeManager.getConversationSnapshotHead(workspace, conversationId, {
    hydrateRuntime,
    limitTurns,
    limitEvents,
  });
  if (!snapshot) {
    return c.json({ error: `Unknown conversation: ${conversationId}` }, 404);
  }
  return c.json({ snapshot });
});

agentRoutes.patch("/api/agents/conversations/:conversationId/config", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const conversationId = c.req.param("conversationId");
  const patch = await c.req.json<AgentConversationConfigPatch>();
  const conversation = await agentRuntimeManager.updateConversationConfig(
    workspace,
    conversationId,
    patch
  );
  return c.json({ conversation });
});

agentRoutes.patch("/api/agents/conversations/:conversationId/metadata", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const conversationId = c.req.param("conversationId");
  const patch = await c.req.json<AgentConversationMetadataPatch>();
  const conversation = await agentRuntimeManager.updateConversationMetadata(
    workspace,
    conversationId,
    patch
  );
  return c.json({ conversation });
});

agentRoutes.post("/api/agents/conversations/:conversationId/prompt", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const conversationId = c.req.param("conversationId");
  const body = await c.req.json<{
    text?: string;
    attachments?: AgentPromptAttachment[];
    configOverride?: AgentQueuedChatPrompt["configOverride"];
    planHandoff?: AgentQueuedChatPrompt["planHandoff"];
    clientEventId?: string;
    clientMessageId?: string;
    clientTimezone?: string;
    delivery?: AgentQueuedChatPrompt["delivery"];
  }>();
  if (!body.text?.trim() && (!body.attachments || body.attachments.length === 0)) {
    return c.json({ error: "Expected prompt text or attachments." }, 400);
  }
  const snapshot = await agentRuntimeManager.promptConversation(
    workspace,
    conversationId,
    body.text ?? "",
    body.attachments,
    {
      ...(body.configOverride ? { configOverride: body.configOverride } : {}),
      ...(body.planHandoff ? { planHandoff: body.planHandoff } : {}),
      ...(body.clientEventId ? { clientEventId: body.clientEventId } : {}),
      ...(body.clientMessageId ? { clientMessageId: body.clientMessageId } : {}),
      ...(body.clientTimezone ? { clientTimezone: body.clientTimezone } : {}),
      ...(body.delivery ? { delivery: body.delivery } : {}),
    }
  );
  return c.json({ snapshot });
});

agentRoutes.post("/api/agents/conversations/:conversationId/relocate", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const conversationId = c.req.param("conversationId");
  const body = await c.req.json<{ workspaceId?: string; branch?: string }>();
  try {
    const result = await agentRuntimeManager.relocateConversation(workspace, conversationId, {
      ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
      ...(body.branch ? { branch: body.branch } : {}),
      initiatedBy: "user",
    });
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Relocate failed.";
    return c.json({ error: message }, 400);
  }
});

agentRoutes.post("/api/agents/conversations/:conversationId/retry", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const conversationId = c.req.param("conversationId");
  const snapshot = await agentRuntimeManager.retryConversationTurn(
    workspace,
    conversationId
  );
  return c.json({ snapshot });
});

agentRoutes.patch(
  "/api/agents/conversations/:conversationId/queue/:itemId",
  async (c) => {
    const workspace = await requireWorkspaceFromRequest(c);
    const conversationId = c.req.param("conversationId");
    const itemId = c.req.param("itemId");
    if (!itemId) {
      return c.json({ error: "Expected itemId." }, 400);
    }
    const body = await c.req.json().catch(() => null);
    const delivery =
      body && typeof body === "object" && "delivery" in body
        ? (body as { delivery?: unknown }).delivery
        : undefined;
    if (delivery !== "normal" && delivery !== "steer") {
      return c.json({ error: "Expected delivery to be normal or steer." }, 400);
    }
    try {
      const conversation = await agentRuntimeManager.updateQueuedPromptDelivery(
        workspace,
        conversationId,
        itemId,
        delivery
      );
      return c.json({ conversation });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update queued prompt.";
      const notFound =
        message.startsWith("Unknown conversation:") ||
        message.startsWith("Unknown queued prompt:");
      return c.json({ error: message }, notFound ? 404 : 400);
    }
  }
);

agentRoutes.delete(
  "/api/agents/conversations/:conversationId/queue/:itemId",
  async (c) => {
    const workspace = await requireWorkspaceFromRequest(c);
    const conversationId = c.req.param("conversationId");
    const itemId = c.req.param("itemId");
    if (!itemId) {
      return c.json({ error: "Expected itemId." }, 400);
    }
    const conversation = await agentRuntimeManager.removeQueuedPrompt(
      workspace,
      conversationId,
      itemId
    );
    return c.json({ conversation });
  }
);

agentRoutes.post(
  "/api/agents/conversations/:conversationId/queue/:itemId/send",
  async (c) => {
    const workspace = await requireWorkspaceFromRequest(c);
    const conversationId = c.req.param("conversationId");
    const itemId = c.req.param("itemId");
    if (!itemId) {
      return c.json({ error: "Expected itemId." }, 400);
    }
    try {
      const snapshot = await agentRuntimeManager.sendQueuedPromptNow(
        workspace,
        conversationId,
        itemId
      );
      return c.json({ snapshot });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to send queued prompt.";
      const notFound =
        message.startsWith("Unknown conversation:") ||
        message.startsWith("Unknown queued prompt:");
      return c.json({ error: message }, notFound ? 404 : 400);
    }
  }
);

agentRoutes.post("/api/agents/conversations/:conversationId/cancel", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const conversationId = c.req.param("conversationId");
  const conversation = await agentRuntimeManager.cancelConversation(
    workspace,
    conversationId
  );
  return c.json({ conversation });
});

agentRoutes.post("/api/agents/conversations/:conversationId/pause", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const conversationId = c.req.param("conversationId");
  try {
    const conversation = await agentRuntimeManager.pauseConversation(
      workspace,
      conversationId
    );
    return c.json({ conversation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pause failed.";
    return c.json({ error: message }, 400);
  }
});

agentRoutes.post("/api/agents/conversations/:conversationId/resume", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const conversationId = c.req.param("conversationId");
  try {
    const conversation = await agentRuntimeManager.resumeConversation(
      workspace,
      conversationId
    );
    return c.json({ conversation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Resume failed.";
    return c.json({ error: message }, 400);
  }
});

agentRoutes.post("/api/agents/conversations/:conversationId/question", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const conversationId = c.req.param("conversationId");
  const body = await c.req.json<{
    questionId?: string;
    answer?: string;
  }>();
  if (!body.questionId?.trim()) {
    return c.json({ error: "Expected questionId." }, 400);
  }
  if (!body.answer?.trim()) {
    return c.json({ error: "Expected answer." }, 400);
  }
  const conversation = await agentRuntimeManager.answerQuestion(workspace, conversationId, {
    questionId: body.questionId.trim(),
    answer: body.answer.trim(),
  });
  return c.json({ conversation });
});

agentRoutes.post("/api/agents/conversations/:conversationId/permission", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const conversationId = c.req.param("conversationId");
  const body = await c.req.json<{
    requestId?: string;
    optionId?: string;
    cancelled?: boolean;
  }>();
  if (!body.requestId) {
    return c.json({ error: "Expected requestId." }, 400);
  }
  const conversation = await agentRuntimeManager.answerPermission(
    workspace,
    conversationId,
    {
      requestId: body.requestId,
      optionId: body.optionId,
      cancelled: body.cancelled,
    }
  );
  return c.json({ conversation });
});

agentRoutes.post("/api/agents/conversations/:conversationId/handoff", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const conversationId = c.req.param("conversationId");
  const body = await c.req.json<{
    targetAgentBackend: string;
    messageLimit?: number;
    resumeNative?: boolean;
  }>();
  if (!body.targetAgentBackend) {
    return c.json({ error: "Expected targetAgentBackend." }, 400);
  }
  try {
    const result = await agentRuntimeManager.handoffConversation(
      workspace,
      conversationId,
      body.targetAgentBackend as AgentBackendId,
      body.messageLimit,
      { ...(typeof body.resumeNative === "boolean" ? { resumeNative: body.resumeNative } : {}) }
    );
    return c.json(result, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Handoff failed.";
    return c.json({ error: message }, 400);
  }
});

agentRoutes.post("/api/agents/conversations/:conversationId/redo", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const conversationId = c.req.param("conversationId");
  const body = await c.req.json<{ beforeMessageId?: string }>();
  if (!body.beforeMessageId) {
    return c.json({ error: "Expected beforeMessageId." }, 400);
  }
  try {
    const conversation = await agentRuntimeManager.prepareRedoConversation(
      workspace,
      conversationId,
      body.beforeMessageId
    );
    return c.json({ conversation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Redo failed.";
    return c.json({ error: message }, 400);
  }
});

/**
 * Open a side chat attached to `:conversationId` (the primary). The child
 * inherits the parent's backend/mode/model/profile and is seeded with the
 * parent's recent transcript as hidden model context. Works while the parent
 * is running. With `text`/`attachments`, the first prompt is sent immediately
 * (`/side <question>`); otherwise the side chat opens empty (`/side`).
 */
agentRoutes.post("/api/agents/conversations/:conversationId/side-chats", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const parentConversationId = c.req.param("conversationId");
  const body = await c.req
    .json<{
      text?: string;
      attachments?: AgentPromptAttachment[];
      clientEventId?: string;
      clientMessageId?: string;
      clientTimezone?: string;
    }>()
    .catch(() => ({}) as Record<string, never>);
  let created: Awaited<ReturnType<typeof agentRuntimeManager.createSideChat>>;
  try {
    created = await agentRuntimeManager.createSideChat(workspace, parentConversationId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not open a side chat.";
    const status = /^Unknown parent conversation/.test(message) ? 404 : 400;
    return c.json({ error: message }, status);
  }
  const text = body.text?.trim() ?? "";
  if (!text && (!body.attachments || body.attachments.length === 0)) {
    const snapshot = await agentRuntimeManager.getConversationSnapshotHead(
      workspace,
      created.conversation.id
    );
    return c.json(
      {
        snapshot: snapshot ?? {
          conversation: created.conversation,
          events: [],
          window: { oldestSeq: 0, newestSeq: 0, hasOlder: false },
        },
      },
      201
    );
  }
  const snapshot = await agentRuntimeManager.promptConversation(
    workspace,
    created.conversation.id,
    text,
    body.attachments,
    {
      ...(body.clientEventId ? { clientEventId: body.clientEventId } : {}),
      ...(body.clientMessageId ? { clientMessageId: body.clientMessageId } : {}),
      ...(body.clientTimezone ? { clientTimezone: body.clientTimezone } : {}),
    }
  );
  return c.json({ snapshot }, 201);
});

agentRoutes.get("/api/agents/conversations/:conversationId/side-chats", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const parentConversationId = c.req.param("conversationId");
  c.header("Cache-Control", "no-store, max-age=0");
  const conversations = await agentRuntimeManager.listSideChats(workspace, parentConversationId);
  return c.json({ conversations });
});

agentRoutes.post("/api/agents/conversations/:conversationId/fork", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const conversationId = c.req.param("conversationId");
  const body = await c.req.json<{ upToMessageId?: string; beforeMessageId?: string }>();
  try {
    const result = await agentRuntimeManager.forkConversation(
      workspace,
      conversationId,
      body
    );
    return c.json(result, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Fork failed.";
    return c.json({ error: message }, 400);
  }
});

function getExtensionFromMime(mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/csv": ".csv",
    "application/json": ".json",
    "application/zip": ".zip",
  };
  return mimeToExt[mimeType] ?? ".bin";
}

/**
 * Keep the user's original filename (so agents see `budget.xlsx`, not a UUID)
 * while stripping directory components and shell-hostile characters.
 */
function sanitizeUploadFileName(rawName: string | undefined, mimeType: string): string {
  const base = (rawName ?? "").split(/[\\/]/).pop()?.trim() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 128);
  if (!cleaned) {
    return `upload-${randomUUID().slice(0, 8)}${getExtensionFromMime(mimeType)}`;
  }
  return cleaned;
}

/** `budget.xlsx` → `budget-2.xlsx` when the name is already taken. */
async function dedupeUploadPath(uploadsDir: string, fileName: string): Promise<string> {
  const parsed = path.parse(fileName);
  let candidate = fileName;
  for (let attempt = 2; attempt < 1000; attempt += 1) {
    try {
      await fs.access(path.join(uploadsDir, candidate));
    } catch {
      return candidate;
    }
    candidate = `${parsed.name}-${attempt}${parsed.ext}`;
  }
  return `${parsed.name}-${randomUUID().slice(0, 8)}${parsed.ext}`;
}

agentRoutes.post("/api/agents/attachments", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  let body: Record<string, string | File | (string | File)[]>;
  try {
    // `all: true` keeps every repeated `files` field; the default silently
    // drops all but the last file of a multi-file upload.
    body = await c.req.parseBody({ all: true });
  } catch {
    return c.json({ error: "Invalid multipart body" }, 400);
  }
  const files = body.files;
  const fileArray = Array.isArray(files) ? files : files ? [files] : [];
  if (fileArray.length === 0) {
    return c.json({ error: "Expected files field with at least one file" }, 400);
  }
  const attachments: {
    id: string;
    path: string;
    name: string;
    size: number;
    mimeType: string;
  }[] = [];
  const uploadsDir = path.join(workspace.root, FILE_UPLOADS_DIR);
  await fs.mkdir(uploadsDir, { recursive: true });
  await ensureCesiumDirGitignored(workspace.root).catch(() => undefined);
  for (const file of fileArray) {
    if (typeof file === "string") {
      continue;
    }
    const id = randomUUID();
    const mimeType = file.type || "application/octet-stream";
    const fileName = await dedupeUploadPath(
      uploadsDir,
      sanitizeUploadFileName(file.name, mimeType)
    );
    const filePath = path.posix.join(FILE_UPLOADS_DIR, fileName);
    const absolutePath = resolveSafePath(workspace.root, filePath);
    const buf = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(absolutePath, buf);
    attachments.push({ id, path: filePath, name: fileName, size: buf.byteLength, mimeType });
  }
  return c.json({ attachments });
});

/** All scheduled triggers across workspaces (for the settings management UI). */
agentRoutes.get("/api/agents/triggers", async (c) => {
  const workspaces = await listWorkspaces();
  const triggers = (
    await Promise.all(
      workspaces.map(async (workspace) =>
        (await listCesiumTriggers(workspace.id)).map((trigger) => ({
          ...trigger,
          workspaceName: workspace.name,
        }))
      )
    )
  ).flat();
  return c.json({ triggers });
});

agentRoutes.patch("/api/agents/triggers/:triggerId", async (c) => {
  const triggerId = c.req.param("triggerId");
  const body = await c.req.json<{ workspaceId?: string; enabled?: boolean }>();
  const workspaceId = body.workspaceId?.trim();
  if (!workspaceId) {
    return c.json({ error: "Missing workspace id." }, 400);
  }
  try {
    const trigger = await updateCesiumTrigger({
      workspaceId,
      id: triggerId,
      patch: { ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}) },
    });
    return c.json({ trigger });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 404);
  }
});

agentRoutes.delete("/api/agents/triggers/:triggerId", async (c) => {
  const triggerId = c.req.param("triggerId");
  const workspaceId = c.req.query("workspaceId")?.trim();
  if (!workspaceId) {
    return c.json({ error: "Missing workspace id." }, 400);
  }
  const removed = await deleteCesiumTrigger({ workspaceId, id: triggerId });
  if (!removed) {
    return c.json({ error: `No trigger with id ${triggerId}.` }, 404);
  }
  return c.json({ trigger: removed });
});
