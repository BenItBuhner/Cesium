import path from "node:path";
import { DATA_DIR } from "./persistence.js";
import { isProjectWorkspaceRoot, PROJECT_WORKSPACE_KIND } from "./projects/paths.js";
import type { WorkspaceRecord } from "./workspace-registry.js";

export const STANDALONE_CHAT_KIND = "standalone-chat" as const;
export const STANDALONE_CHAT_DEFAULT_NAME = "Chat";

export function getStandaloneChatsRootDir(): string {
  return path.join(DATA_DIR, "standalone-chats");
}

export function isStandaloneChatRoot(root: string): boolean {
  const normalized = path.resolve(root).replace(/\\/g, "/");
  const base = path.resolve(getStandaloneChatsRootDir()).replace(/\\/g, "/");
  if (normalized === base) {
    return false;
  }
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return normalized.startsWith(prefix);
}

export function isStandaloneChatWorkspace(
  workspace: Pick<WorkspaceRecord, "kind" | "root">
): boolean {
  if (workspace.kind === STANDALONE_CHAT_KIND) {
    return true;
  }
  if (workspace.kind === "workspace" || workspace.kind === PROJECT_WORKSPACE_KIND) {
    return false;
  }
  return isStandaloneChatRoot(workspace.root);
}

/** A Project orchestrator's context folder. Kind is derived from the path. */
export function isProjectWorkspace(workspace: Pick<WorkspaceRecord, "kind" | "root">): boolean {
  return workspace.kind === PROJECT_WORKSPACE_KIND || isProjectWorkspaceRoot(workspace.root);
}

/**
 * Sandboxes the engine creates for itself (standalone chats, Project context
 * folders). They never enter recent/default/startup workspace lists.
 */
export function isEngineManagedWorkspace(
  workspace: Pick<WorkspaceRecord, "kind" | "root">
): boolean {
  return isStandaloneChatWorkspace(workspace) || isProjectWorkspace(workspace);
}

/** Ensure `kind` is set for standalone-chat and Project trees. */
export function annotateWorkspaceKind(workspace: WorkspaceRecord): WorkspaceRecord {
  if (isProjectWorkspaceRoot(workspace.root)) {
    return workspace.kind === PROJECT_WORKSPACE_KIND
      ? workspace
      : { ...workspace, kind: PROJECT_WORKSPACE_KIND };
  }
  if (isStandaloneChatWorkspace(workspace)) {
    return { ...workspace, kind: STANDALONE_CHAT_KIND };
  }
  return workspace.kind ? workspace : { ...workspace, kind: "workspace" };
}
