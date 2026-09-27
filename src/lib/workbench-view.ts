import { PROJECT_PAGE_VIEW } from "@cesium/core";
import type { WorkbenchShellView } from "@/lib/workspace-session";

/** Primary workbench route (agent shell). Legacy `/workspace` redirects here. */
export const WORKSPACE_ROUTE = "/agent";

/** Query key for workbench layout on the agent route (`?view=settings`). Agent default omits the param. */
export const WORKBENCH_VIEW_SEARCH_PARAM = "view";

/**
 * `?view=project` is the Project page: the agent shell showing a Project's
 * coordinator, kept in the URL by the Projects provider rather than here.
 */
export function isProjectPageViewParam(raw: string | null): boolean {
  return raw === PROJECT_PAGE_VIEW;
}

/** Resolve `view` search param to a shell view, or `"default"` when absent / unknown. */
export function workbenchViewFromSearchParam(
  raw: string | null
): WorkbenchShellView | "default" {
  if (raw === "agent" || raw === "settings") {
    return raw;
  }
  // Legacy `?view=editor` (classic IDE) maps to the agent shell.
  if (raw === "editor") {
    return "agent";
  }
  return "default";
}

/**
 * One-shot recovery marker set right before an error-boundary reload. The
 * shell view (`settings`) is persisted in the workspace session, so a crash
 * while rendering Settings would otherwise reproduce on every launch. When
 * this marker is present the next boot forces the default agent (new chat)
 * view and persists it, breaking the crash loop.
 */
const FORCE_DEFAULT_SHELL_VIEW_STORAGE_KEY = "cesium.workbench.forceDefaultShellView";

export function requestDefaultShellViewOnNextLaunch(): void {
  try {
    window.localStorage.setItem(FORCE_DEFAULT_SHELL_VIEW_STORAGE_KEY, "1");
  } catch {
    // Storage may be unavailable (private mode, quota); reload still works.
  }
}

/** Read + clear the recovery marker. Returns true when a reset was requested. */
export function consumeDefaultShellViewOnNextLaunch(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    const requested =
      window.localStorage.getItem(FORCE_DEFAULT_SHELL_VIEW_STORAGE_KEY) != null;
    if (requested) {
      window.localStorage.removeItem(FORCE_DEFAULT_SHELL_VIEW_STORAGE_KEY);
    }
    return requested;
  } catch {
    return false;
  }
}
