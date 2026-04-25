import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { requireWorkspaceFromRequest } from "../lib/request-workspace.js";
import { resolveSafePath } from "../lib/workspace.js";
import { agentRuntimeManager } from "../lib/agents/runtime-manager.js";
import {
  getCursorAgentDeploymentHints,
  listAgentBackendsWithCache,
} from "../lib/agents/providers.js";
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
  AgentConversationConfigPatch,
  AgentConversationCreateInput,
  AgentConversationMetadataPatch,
  AgentQueuedChatPrompt,
} from "../lib/agents/types.js";

export const agentRoutes = new Hono();

agentRoutes.get("/api/agents/deployment-hints", async (c) => {
  await requireWorkspaceFromRequest(c);
  return c.json({ cursorAgent: getCursorAgentDeploymentHints() });
});

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
      return c.json(cached);
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

agentRoutes.post("/api/agents/conversations/draft-title", async (c) => {
  await requireWorkspaceFromRequest(c);
  const body = await c.req.json<{ text: string }>();
  if (!body.text || !body.text.trim()) {
    return c.json({ error: "Text is required" }, 400);
  }
  const title = await generateTitleFromText(body.text);
  return c.json({ title: title ?? "Untitled" });
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
    attachments?: Array<{ mimeType: string; data: string; name?: string }>;
    configOverride?: AgentQueuedChatPrompt["configOverride"];
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
    }
  );
  return c.json({ snapshot });
});

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

agentRoutes.post("/api/agents/conversations/:conversationId/cancel", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const conversationId = c.req.param("conversationId");
  const conversation = await agentRuntimeManager.cancelConversation(
    workspace,
    conversationId
  );
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
  const body = await c.req.json<{ targetAgentBackend: string; messageLimit?: number }>();
  if (!body.targetAgentBackend) {
    return c.json({ error: "Expected targetAgentBackend." }, 400);
  }
  try {
    const result = await agentRuntimeManager.handoffConversation(
      workspace,
      conversationId,
      body.targetAgentBackend as AgentBackendId,
      body.messageLimit
    );
    return c.json(result, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Handoff failed.";
    return c.json({ error: message }, 400);
  }
});

agentRoutes.post("/api/agents/conversations/:conversationId/fork", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const conversationId = c.req.param("conversationId");
  const body = await c.req.json<{ upToMessageId?: string }>();
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

const ATTACHMENTS_FOLDER = ".attachments";

function getExtensionFromMime(mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
  };
  return mimeToExt[mimeType] ?? ".bin";
}

agentRoutes.post("/api/agents/attachments", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  let body: Record<string, string | File | (string | File)[]>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: "Invalid multipart body" }, 400);
  }
  const files = body.files;
  const fileArray = Array.isArray(files) ? files : files ? [files] : [];
  if (fileArray.length === 0) {
    return c.json({ error: "Expected files field with at least one file" }, 400);
  }
  const attachments: { id: string; path: string }[] = [];
  const attachmentsDir = path.join(workspace.root, ATTACHMENTS_FOLDER);
  try {
    await fs.mkdir(attachmentsDir, { recursive: true });
  } catch {
    // Directory may already exist
  }
  for (const file of fileArray) {
    if (typeof file === "string") {
      continue;
    }
    const id = randomUUID();
    const ext = getExtensionFromMime(file.type);
    const fileName = `${id}${ext}`;
    const filePath = path.join(ATTACHMENTS_FOLDER, fileName);
    const absolutePath = resolveSafePath(workspace.root, filePath);
    const buf = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(absolutePath, buf);
    attachments.push({ id, path: filePath });
  }
  return c.json({ attachments });
});
