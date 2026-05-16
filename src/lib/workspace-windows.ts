import {
  WORKBENCH_VIEW_SEARCH_PARAM,
  WORKSPACE_ROUTE,
} from "@/lib/workbench-view";
import { currentModel } from "@/lib/mock-data";
import {
  createDefaultWorkspaceSession,
  mergeWorkspaceSessionFromImport,
  type WorkspaceSessionState,
} from "@/lib/workspace-session";

export const FRESH_WORKSPACE_WINDOW_HIDDEN_CONVERSATIONS_SENTINEL =
  "__workspace_window_fresh__";

/** Next web workbench lives at `/workspace`; desktop file renderer keeps its current file path. */
export type WorkspaceScopedRoute = string;

function isDesktopFileRenderer(): boolean {
  return (
    typeof window !== "undefined" &&
    window.location.protocol === "file:" &&
    Boolean(
      (
        window as Window & {
          cesiumDesktop?: { isElectron?: boolean };
        }
      ).cesiumDesktop?.isElectron
    )
  );
}

function defaultWorkspaceRoute(): WorkspaceScopedRoute {
  if (isDesktopFileRenderer()) {
    return window.location.pathname || "/";
  }
  return WORKSPACE_ROUTE;
}

export function normalizeWorkspaceScopedRoute(
  pathname: string | null | undefined
): WorkspaceScopedRoute {
  if (isDesktopFileRenderer()) {
    return pathname || window.location.pathname || "/";
  }
  return WORKSPACE_ROUTE;
}

export function buildWorkspaceScopedUrl(
  origin: string,
  route: WorkspaceScopedRoute,
  workspaceId: string,
  windowId: string,
  extraParams?: Record<string, string | null | undefined>
): string {
  const base =
    origin === "null" && typeof window !== "undefined"
      ? window.location.href
      : origin;
  const url = new URL(route, base);
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
  const effectiveRoute = route ?? defaultWorkspaceRoute();
  const extra: Record<string, string> = {};
  if (typeof window !== "undefined") {
    const v = new URL(window.location.href).searchParams.get(WORKBENCH_VIEW_SEARCH_PARAM);
    if (v === "editor") {
      extra[WORKBENCH_VIEW_SEARCH_PARAM] = "editor";
    }
  }
  return buildWorkspaceScopedUrl(origin, effectiveRoute, workspaceId, windowId, extra);
}

export function normalizeWorkspaceWindowSession(
  raw: WorkspaceSessionState | null | undefined
): WorkspaceSessionState {
  return mergeWorkspaceSessionFromImport(
    createDefaultWorkspaceSession([], currentModel),
    raw
  );
}
