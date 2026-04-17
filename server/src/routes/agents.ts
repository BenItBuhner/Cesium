import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { requireWorkspaceFromRequest } from "../lib/request-workspace.js";
import { resolveSafePath } from "../lib/workspace.js";
import { agentRuntimeManager } from "../lib/agents/runtime-manager.js";
import { exportOpenCodeSession } from "../lib/agents/opencode-export.js";
import {
  getCursorAgentDeploymentHints,
  listAgentBackendsWithCache,
} from "../lib/agents/providers.js";
import { listWorkspaceConversationRecords } from "../lib/agents/session-store.js";
import { listWorkspaces } from "../lib/workspace-registry.js";
import type {
  AgentBackendId,
  AgentConversationConfigPatch,
  AgentConversationCreateInput,
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
  return c.json(result);
});

agentRoutes.get("/api/agents/conversations/all", async (c) => {
  const { limit: limitRaw, cursor: cursorRaw } = parsePageParams(c);
  const limit = Math.max(1, Math.min(Math.floor(limitRaw ?? 500), 1000));
  const offset = Math.max(
    0,
    cursorRaw ? Number.parseInt(cursorRaw, 10) || 0 : 0
  );
  const [workspaces, backends] = await Promise.all([
    listWorkspaces(),
    listAgentBackendsWithCache(),
  ]);
  // Load per-workspace lists, project to lightweight summaries first, then
  // sort + paginate across the flat list. Keeps payload predictable regardless
  // of how many workspaces the user has pinned.
  const perWorkspace = await Promise.all(
    workspaces.map(async (workspace) => {
      const conversations = await listWorkspaceConversationRecords(workspace.id);
      return conversations.map((conversation) => ({
        workspace,
        summary: {
          id: conversation.id,
          workspaceId: conversation.workspaceId,
          title: conversation.title,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
          lastEventSeq: conversation.lastEventSeq,
          status: conversation.status,
          backendId: conversation.config.backendId,
          mode: conversation.config.mode,
          experimental: conversation.experimental,
          hasPendingPermission: conversation.pendingPermission != null,
        },
      }));
    })
  );
  const flat = perWorkspace
    .flat()
    .sort(
      (a, b) =>
        b.summary.updatedAt - a.summary.updatedAt ||
        a.summary.title.localeCompare(b.summary.title)
    );
  const window = flat.slice(offset, offset + limit);
  const nextCursor =
    offset + window.length < flat.length
      ? String(offset + window.length)
      : null;
  // Re-group the page back by workspace. Workspaces with zero conversations
  // on this page are dropped; the client already tolerates sparse groups.
  const groupMap = new Map<
    string,
    { workspace: (typeof workspaces)[number]; conversations: Array<(typeof window)[number]["summary"]> }
  >();
  for (const workspace of workspaces) {
    // Pre-seed the map on the first page so callers always get every known
    // workspace even when a workspace has zero conversations; saves a second
    // request from the UI to populate the sidebar.
    if (offset === 0) {
      groupMap.set(workspace.id, { workspace, conversations: [] });
    }
  }
  for (const entry of window) {
    const existing = groupMap.get(entry.workspace.id);
    if (existing) {
      existing.conversations.push(entry.summary);
    } else {
      groupMap.set(entry.workspace.id, {
        workspace: entry.workspace,
        conversations: [entry.summary],
      });
    }
  }
  const groups = Array.from(groupMap.values());
  return c.json({ backends, groups, nextCursor });
});

agentRoutes.post("/api/agents/conversations", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const body = await c.req.json<AgentConversationCreateInput>();
  const conversation = await agentRuntimeManager.createConversation(workspace, body);
  return c.json({ conversation }, 201);
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

agentRoutes.get("/api/agents/subagents/:sessionId", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const sessionId = c.req.param("sessionId");
  const session = await exportOpenCodeSession(sessionId);
  const directory =
    session &&
    typeof session === "object" &&
    (session as { info?: { directory?: unknown } }).info &&
    typeof (session as { info?: { directory?: unknown } }).info?.directory === "string"
      ? ((session as { info?: { directory?: string } }).info?.directory as string)
      : "";
  if (!directory || !directory.startsWith(workspace.root)) {
    return c.json({ error: "Subagent session does not belong to the active workspace." }, 404);
  }
  return c.json({ session });
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

agentRoutes.post("/api/agents/conversations/:conversationId/prompt", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const conversationId = c.req.param("conversationId");
  const body = await c.req.json<{ text?: string; attachments?: Array<{ mimeType: string; data: string; name?: string }> }>();
  if (!body.text?.trim() && (!body.attachments || body.attachments.length === 0)) {
    return c.json({ error: "Expected prompt text or attachments." }, 400);
  }
  const snapshot = await agentRuntimeManager.promptConversation(
    workspace,
    conversationId,
    body.text ?? "",
    body.attachments
  );
  return c.json({ snapshot });
});

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
