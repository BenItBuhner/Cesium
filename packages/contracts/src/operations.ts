export type CesiumHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type CesiumOperation = {
  id: string;
  method: CesiumHttpMethod;
  path: string;
  scope: "server" | "workspace";
  stability: "stable" | "experimental";
};

function operation(
  id: string,
  method: CesiumHttpMethod,
  path: string,
  scope: CesiumOperation["scope"] = "server",
  stability: CesiumOperation["stability"] = "stable"
): CesiumOperation {
  return { id, method, path, scope, stability };
}

/**
 * Public HTTP surface covered by the standalone SDK. This manifest is checked
 * against Hono's registered routes so client paths cannot silently drift.
 */
export const CESIUM_SDK_OPERATIONS = [
  operation("system.meta", "GET", "/api/meta"),
  operation("system.health", "GET", "/health"),
  operation("auth.status", "GET", "/api/auth/status"),
  operation("auth.login", "POST", "/api/auth/login"),
  operation("auth.logout", "POST", "/api/auth/logout"),
  operation("workspaces.bootstrap", "GET", "/api/workspaces/bootstrap"),
  operation("workspaces.list", "GET", "/api/workspaces"),
  operation("workspaces.open", "POST", "/api/workspaces/open"),
  operation("workspaces.create", "POST", "/api/workspaces/create"),
  operation("workspaces.remove", "DELETE", "/api/workspaces/:workspaceId"),
  operation("workspaces.git.status", "GET", "/api/workspaces/:workspaceId/git/status", "workspace"),
  operation("workspaces.git.init", "POST", "/api/workspaces/:workspaceId/git/init", "workspace"),
  operation("workspaces.git.switch", "POST", "/api/workspaces/:workspaceId/git/switch", "workspace"),
  operation("workspaces.git.worktrees.create", "POST", "/api/workspaces/:workspaceId/git/worktrees", "workspace"),
  operation("workspaces.git.worktrees.remove", "DELETE", "/api/workspaces/:workspaceId/git/worktrees", "workspace"),
  operation("files.tree", "GET", "/api/fs/tree", "workspace"),
  operation("files.children", "GET", "/api/fs/tree/children", "workspace"),
  operation("files.read", "GET", "/api/fs/read", "workspace"),
  operation("files.write", "POST", "/api/fs/write", "workspace"),
  operation("files.stat", "GET", "/api/fs/stat", "workspace"),
  operation("files.mkdir", "POST", "/api/fs/mkdir", "workspace"),
  operation("files.remove", "POST", "/api/fs/delete", "workspace"),
  operation("files.rename", "POST", "/api/fs/rename", "workspace"),
  operation("files.upload", "POST", "/api/fs/upload", "workspace"),
  operation("files.search", "GET", "/api/fs/search", "workspace"),
  operation("terminals.list", "GET", "/api/terminals", "workspace"),
  operation("terminals.create", "POST", "/api/terminals", "workspace"),
  operation("terminals.remove", "DELETE", "/api/terminals/:id", "workspace"),
  operation("conversations.list", "GET", "/api/agents/conversations", "workspace"),
  operation("conversations.listAll", "GET", "/api/agents/conversations/all"),
  operation("conversations.create", "POST", "/api/agents/conversations", "workspace"),
  operation("conversations.createAndPrompt", "POST", "/api/agents/conversations/create-and-prompt", "workspace"),
  operation("conversations.createStandalone", "POST", "/api/agents/conversations/standalone/create-and-prompt"),
  operation("conversations.get", "GET", "/api/agents/conversations/:conversationId", "workspace"),
  operation("conversations.prompt", "POST", "/api/agents/conversations/:conversationId/prompt", "workspace"),
  operation("conversations.retry", "POST", "/api/agents/conversations/:conversationId/retry", "workspace"),
  operation("conversations.cancel", "POST", "/api/agents/conversations/:conversationId/cancel", "workspace"),
  operation("conversations.pause", "POST", "/api/agents/conversations/:conversationId/pause", "workspace"),
  operation("conversations.resume", "POST", "/api/agents/conversations/:conversationId/resume", "workspace"),
  operation("conversations.config", "PATCH", "/api/agents/conversations/:conversationId/config", "workspace"),
  operation("conversations.metadata", "PATCH", "/api/agents/conversations/:conversationId/metadata", "workspace"),
  operation("conversations.permission", "POST", "/api/agents/conversations/:conversationId/permission", "workspace"),
  operation("conversations.question", "POST", "/api/agents/conversations/:conversationId/question", "workspace"),
  operation("conversations.fork", "POST", "/api/agents/conversations/:conversationId/fork", "workspace"),
  operation("settings.global.get", "GET", "/api/settings/global"),
  operation("settings.global.update", "PUT", "/api/settings/global"),
  operation("settings.models.list", "GET", "/api/settings/models"),
  operation("settings.models.refresh", "POST", "/api/settings/models/refresh"),
  operation("settings.models.update", "PUT", "/api/settings/models/toggles"),
  operation("settings.cesiumAgent.get", "GET", "/api/settings/cesium-agent"),
  operation("settings.cesiumAgent.update", "PATCH", "/api/settings/cesium-agent"),
  operation("settings.cesiumAgent.models", "GET", "/api/settings/cesium-agent/models"),
  operation("mcp.presets", "GET", "/api/mcp/presets"),
  operation("mcp.servers.list", "GET", "/api/workspaces/:workspaceId/mcp/servers", "workspace"),
  operation("mcp.servers.upsert", "PUT", "/api/workspaces/:workspaceId/mcp/servers", "workspace"),
  operation("mcp.servers.remove", "DELETE", "/api/workspaces/:workspaceId/mcp/servers/:serverId", "workspace"),
  operation("mcp.servers.test", "POST", "/api/workspaces/:workspaceId/mcp/servers/:serverId/test", "workspace"),
  operation("orchestration.boards.list", "GET", "/api/orchestration/boards", "workspace"),
  operation("orchestration.boards.create", "POST", "/api/orchestration/boards", "workspace"),
  operation("orchestration.boards.get", "GET", "/api/orchestration/boards/:boardId", "workspace"),
  operation("orchestration.boards.update", "PATCH", "/api/orchestration/boards/:boardId", "workspace"),
  operation("orchestration.boards.remove", "DELETE", "/api/orchestration/boards/:boardId", "workspace"),
  operation("orchestration.issues.create", "POST", "/api/orchestration/boards/:boardId/issues", "workspace"),
  operation("cloudAgents.settings.get", "GET", "/api/cloud-agents/settings"),
  operation("cloudAgents.settings.update", "PATCH", "/api/cloud-agents/settings"),
  operation("cloudAgents.tasks.list", "GET", "/api/cloud-agents/tasks"),
  operation("cloudAgents.tasks.create", "POST", "/api/cloud-agents/tasks"),
  operation("cloudAgents.tasks.get", "GET", "/api/cloud-agents/tasks/:taskId"),
  operation("cloudAgents.tasks.dispatch", "POST", "/api/cloud-agents/tasks/:taskId/dispatch"),
  operation("cloudAgents.tasks.steer", "POST", "/api/cloud-agents/tasks/:taskId/steer"),
  operation("cloudAgents.tasks.cancel", "POST", "/api/cloud-agents/tasks/:taskId/cancel"),
  operation("cloudAgents.tasks.complete", "POST", "/api/cloud-agents/tasks/:taskId/complete"),
  operation("cloudAgents.tasks.artifacts", "GET", "/api/cloud-agents/tasks/:taskId/artifacts"),
  operation("cloudAgents.tasks.remove", "DELETE", "/api/cloud-agents/tasks/:taskId"),
  operation("storage.status", "GET", "/api/storage/status", "server", "experimental"),
] as const satisfies readonly CesiumOperation[];
