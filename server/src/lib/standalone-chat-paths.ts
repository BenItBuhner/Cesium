import path from "node:path";
import { DATA_DIR } from "./persistence.js";
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
  if (workspace.kind === "workspace") {
    return false;
  }
  return isStandaloneChatRoot(workspace.root);
}

/** Ensure `kind` is set when the record lives under the standalone-chats tree. */
export function annotateWorkspaceKind(workspace: WorkspaceRecord): WorkspaceRecord {
  if (isStandaloneChatWorkspace(workspace)) {
    return { ...workspace, kind: STANDALONE_CHAT_KIND };
  }
  return workspace.kind ? workspace : { ...workspace, kind: "workspace" };
}
