import path from "node:path";
import { DATA_DIR } from "../persistence.js";

export function mcpServersConfigPath(workspaceId: string): string {
  return path.join(DATA_DIR, "workspaces", workspaceId, "mcp-servers.json");
}

export function mcpSecretsPath(workspaceId: string): string {
  return path.join(DATA_DIR, "workspaces", workspaceId, "mcp-secrets.json");
}

export function workspaceMcpMirrorRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, "mcp-servers");
}

export function slugifyMcpServerId(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "mcp-server";
}
