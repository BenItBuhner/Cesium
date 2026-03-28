import { Hono } from "hono";
import { requireWorkspaceFromRequest } from "../lib/request-workspace.js";
import { agentRuntimeManager } from "../lib/agents/runtime-manager.js";
import type {
  AgentConversationConfigPatch,
  AgentConversationCreateInput,
} from "../lib/agents/types.js";

export const agentRoutes = new Hono();

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
  const snapshot = await agentRuntimeManager.getConversationSnapshot(workspace, conversationId);
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

agentRoutes.post("/api/agents/conversations/:conversationId/prompt", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const conversationId = c.req.param("conversationId");
  const body = await c.req.json<{ text?: string }>();
  if (!body.text?.trim()) {
    return c.json({ error: "Expected prompt text." }, 400);
  }
  const snapshot = await agentRuntimeManager.promptConversation(
    workspace,
    conversationId,
    body.text
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
