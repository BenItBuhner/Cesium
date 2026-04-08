import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { requireWorkspaceFromRequest } from "../lib/request-workspace.js";
import { resolveSafePath } from "../lib/workspace.js";
import { agentRuntimeManager } from "../lib/agents/runtime-manager.js";
import { exportOpenCodeSession } from "../lib/agents/opencode-export.js";
import { getCursorAgentDeploymentHints } from "../lib/agents/providers.js";
import type {
  AgentConversationConfigPatch,
  AgentConversationCreateInput,
} from "../lib/agents/types.js";

export const agentRoutes = new Hono();

agentRoutes.get("/api/agents/deployment-hints", async (c) => {
  await requireWorkspaceFromRequest(c);
  return c.json({ cursorAgent: getCursorAgentDeploymentHints() });
});

agentRoutes.get("/api/agents/conversations", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const result = await agentRuntimeManager.listWorkspaceConversations(workspace.id);
  return c.json(result);
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
  const snapshot = await agentRuntimeManager.getConversationSnapshot(workspace, conversationId, {
    hydrateRuntime,
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
