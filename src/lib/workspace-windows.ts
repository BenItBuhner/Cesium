import { tryParseUrl } from "@/lib/safe-url";
import {
  WORKBENCH_VIEW_SEARCH_PARAM,
  WORKSPACE_ROUTE,
} from "@/lib/workbench-view";
import { NO_MODEL_PLACEHOLDER } from "@/lib/agent-chat";
import {
  createDefaultWorkspaceSession,
  mergeWorkspaceSessionFromImport,
  type WorkspaceSessionState,
} from "@/lib/workspace-session";

export const FRESH_WORKSPACE_WINDOW_HIDDEN_CONVERSATIONS_SENTINEL =
  "__workspace_window_fresh__";

/** Next web workbench lives at `/agent`; file-based renderers keep their current file path. */
export type WorkspaceScopedRoute = string;

/**
 * Any `file://` document (Electron desktop, the Android WebView bundle, or a
 * dist build opened straight from disk) must never have its pathname rewritten
 * to a server route: `history.replaceState` happily records `file:///agent`,
 * and the next hard reload then fails with `net::ERR_FILE_NOT_FOUND` because
 * no such file exists on disk. Only http(s) documents use `/agent`.
 */
function isFileProtocolRenderer(): boolean {
  return typeof window !== "undefined" && window.location.protocol === "file:";
}

function isElectronRenderer(): boolean {
  return (
    typeof window !== "undefined" &&
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
  if (isFileProtocolRenderer()) {
    const path = window.location.pathname || "/";
    // Before the desktop shim navigates, pathname can still be the packaged
    // `index.html` path - using that as a URL base breaks `new URL(route, base)`.
    // Only Electron remaps `/agent` back to the bundle; other file renderers
    // (Android WebView) must keep the on-disk path or reloads 404.
    if (
      isElectronRenderer() &&
      (path.endsWith(".html") || path.includes("desktop-renderer"))
    ) {
      return WORKSPACE_ROUTE;
    }
    return path;
  }
  return WORKSPACE_ROUTE;
}

export function normalizeWorkspaceScopedRoute(
  pathname: string | null | undefined
): WorkspaceScopedRoute {
  if (isFileProtocolRenderer()) {
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
    !origin || origin === "null"
      ? typeof window !== "undefined"
        ? window.location.href
        : "http://127.0.0.1/"
      : origin;
  const url =
    tryParseUrl(route, base) ??
    tryParseUrl(route, "http://127.0.0.1/") ??
    tryParseUrl(WORKSPACE_ROUTE, base) ??
    new URL(WORKSPACE_ROUTE, "http://127.0.0.1/");
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
    const v = tryParseUrl(window.location.href)?.searchParams.get(
      WORKBENCH_VIEW_SEARCH_PARAM
    );
    if (v === "settings") {
      extra[WORKBENCH_VIEW_SEARCH_PARAM] = "settings";
    }
  }
  return buildWorkspaceScopedUrl(origin, effectiveRoute, workspaceId, windowId, extra);
}

export function normalizeWorkspaceWindowSession(
  raw: WorkspaceSessionState | null | undefined
): WorkspaceSessionState {
  return mergeWorkspaceSessionFromImport(
    createDefaultWorkspaceSession([], NO_MODEL_PLACEHOLDER),
    raw
  );
}
