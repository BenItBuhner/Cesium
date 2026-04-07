import { currentModel } from "@/lib/mock-data";
import {
  createDefaultWorkspaceSession,
  mergeWorkspaceSessionFromImport,
  type WorkspaceSessionState,
} from "@/lib/workspace-session";

export const FRESH_WORKSPACE_WINDOW_HIDDEN_CONVERSATIONS_SENTINEL =
  "__workspace_window_fresh__";

export function buildWorkspaceWindowUrl(
  origin: string,
  workspaceId: string,
  windowId: string
): string {
  const url = new URL("/editor", origin);
  url.searchParams.set("workspaceId", workspaceId);
  url.searchParams.set("windowId", windowId);
  return url.toString();
}

export function normalizeWorkspaceWindowSession(
  raw: WorkspaceSessionState | null | undefined
): WorkspaceSessionState {
  return mergeWorkspaceSessionFromImport(
    createDefaultWorkspaceSession([], currentModel),
    raw
  );
}
