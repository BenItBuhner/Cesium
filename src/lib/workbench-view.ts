import type { WorkbenchShellView } from "@/lib/workspace-session";

/** Primary workbench route (agent shell). Legacy `/workspace` redirects here. */
export const WORKSPACE_ROUTE = "/agent";

/** Query key for workbench layout on the agent route (`?view=settings`). Agent default omits the param. */
export const WORKBENCH_VIEW_SEARCH_PARAM = "view";

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
