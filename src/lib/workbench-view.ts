import type { WorkbenchShellView } from "@/lib/workspace-session";

export const WORKSPACE_ROUTE = "/workspace";

/** Query key for workbench layout on the `/workspace` route (`?view=agent|editor|settings`). Agent default omits the param. */
export const WORKBENCH_VIEW_SEARCH_PARAM = "view";

/** Resolve `view` search param to a shell view, or `"default"` when absent / unknown. */
export function workbenchViewFromSearchParam(
  raw: string | null
): WorkbenchShellView | "default" {
  if (raw === "agent" || raw === "editor" || raw === "settings") {
    return raw;
  }
  return "default";
}
