import type { Context } from "hono";
import { getWorkspaceById, type WorkspaceRecord } from "./workspace-registry.js";

export const WORKSPACE_ID_HEADER = "x-opencursor-workspace-id" as const;

export async function requireWorkspaceFromRequest(c: Context): Promise<WorkspaceRecord> {
  const workspaceId = c.req.header(WORKSPACE_ID_HEADER)?.trim();
  if (!workspaceId) {
    throw new Error("Missing workspace id.");
  }

  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace: ${workspaceId}`);
  }
  return workspace;
}
