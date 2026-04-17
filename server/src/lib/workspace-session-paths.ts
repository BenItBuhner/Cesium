import path from "node:path";
import { DATA_DIR } from "./persistence.js";

export function getWorkspaceSessionFile(workspaceId: string): string {
  return path.join(DATA_DIR, "workspaces", workspaceId, "session.json");
}

export function getWorkspaceWindowRegistryFile(workspaceId: string): string {
  return path.join(DATA_DIR, "workspaces", workspaceId, "windows.json");
}

export function getWorkspaceWindowSessionFile(
  workspaceId: string,
  windowId: string
): string {
  return path.join(
    DATA_DIR,
    "workspaces",
    workspaceId,
    "windows",
    `${windowId}.session.json`
  );
}
