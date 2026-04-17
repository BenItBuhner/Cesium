import type { WorkspaceRecord } from "./workspace-registry.js";
import { HOME_WORKSPACE_DISPLAY_NAME } from "./workspace-constants.js";

export function sortWorkspaceRecords(workspaces: WorkspaceRecord[]): WorkspaceRecord[] {
  return [...workspaces].sort((a, b) => {
    const aHome = a.name === HOME_WORKSPACE_DISPLAY_NAME ? 0 : 1;
    const bHome = b.name === HOME_WORKSPACE_DISPLAY_NAME ? 0 : 1;
    if (aHome !== bHome) return aHome - bHome;
    return b.lastOpenedAt - a.lastOpenedAt || a.name.localeCompare(b.name);
  });
}
