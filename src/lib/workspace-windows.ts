import { currentModel } from "@/lib/mock-data";
import {
  createDefaultWorkspaceSession,
  mergeWorkspaceSessionFromImport,
  type WorkspaceSessionState,
} from "@/lib/workspace-session";

export const FRESH_WORKSPACE_WINDOW_HIDDEN_CONVERSATIONS_SENTINEL =
  "__workspace_window_fresh__";

export type WorkspaceScopedRoute = "/editor" | "/agent";

export function normalizeWorkspaceScopedRoute(
  pathname: string | null | undefined
): WorkspaceScopedRoute {
  return pathname === "/agent" ? "/agent" : "/editor";
}

export function buildWorkspaceScopedUrl(
  origin: string,
  route: WorkspaceScopedRoute,
  workspaceId: string,
  windowId: string,
  extraParams?: Record<string, string | null | undefined>
): string {
  const url = new URL(route, origin);
  url.searchParams.set("workspaceId", workspaceId);
  url.searchParams.set("windowId", windowId);
  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams)) {
      if (value == null || value.length === 0) {
        url.searchParams.delete(key);
      } else {
        url.searchParams.set(key, value);
      }
    }
  }
  return url.toString();
}

export function buildWorkspaceWindowUrl(
  origin: string,
  workspaceId: string,
  windowId: string,
  route?: WorkspaceScopedRoute
): string {
  const effectiveRoute =
    route ??
    (typeof window === "undefined"
      ? "/editor"
      : normalizeWorkspaceScopedRoute(window.location.pathname));
  return buildWorkspaceScopedUrl(origin, effectiveRoute, workspaceId, windowId);
}

export function normalizeWorkspaceWindowSession(
  raw: WorkspaceSessionState | null | undefined
): WorkspaceSessionState {
  return mergeWorkspaceSessionFromImport(
    createDefaultWorkspaceSession([], currentModel),
    raw
  );
}
