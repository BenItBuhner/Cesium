import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { invalidate } from "../cache/read-through.js";
import { getStorage } from "../storage/runtime.js";
import { createWorkspaceId, normalizeWorkspaceRoot } from "./persistence.js";
import {
  STANDALONE_CHAT_DEFAULT_NAME,
  STANDALONE_CHAT_KIND,
  getStandaloneChatsRootDir,
  isStandaloneChatWorkspace,
} from "./standalone-chat-paths.js";
import {
  getWorkspaceById,
  removeWorkspace,
  type WorkspaceRecord,
} from "./workspace-registry.js";

const KEY_WORKSPACE_LIST = "opencursor:ws:list";
const KEY_WORKSPACE_PROFILE = "opencursor:ws:profile";
const keyWorkspaceById = (id: string) => `opencursor:ws:id:${id}`;

export {
  STANDALONE_CHAT_DEFAULT_NAME,
  STANDALONE_CHAT_KIND,
  annotateWorkspaceKind,
  getStandaloneChatsRootDir,
  isStandaloneChatRoot,
  isStandaloneChatWorkspace,
} from "./standalone-chat-paths.js";

/**
 * Creates a fresh temporary directory and registers it as a standalone-chat
 * workspace. Does not touch recent/default workspace profile entries.
 */
export async function createStandaloneChatWorkspace(
  preferredName?: string
): Promise<WorkspaceRecord> {
  const base = getStandaloneChatsRootDir();
  await fs.mkdir(base, { recursive: true });
  const dirName = `chat-${randomUUID()}`;
  const root = path.join(base, dirName);
  await fs.mkdir(root, { recursive: false });

  const normalizedRoot = await normalizeWorkspaceRoot(root);
  const now = Date.now();
  const name = preferredName?.trim() || STANDALONE_CHAT_DEFAULT_NAME;
  const workspace: WorkspaceRecord = {
    id: createWorkspaceId(normalizedRoot),
    name,
    root: normalizedRoot,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    kind: STANDALONE_CHAT_KIND,
  };

  const storage = await getStorage();
  await storage.upsertWorkspace(workspace);
  await invalidate(KEY_WORKSPACE_LIST, KEY_WORKSPACE_PROFILE, keyWorkspaceById(workspace.id));
  return workspace;
}

/**
 * Removes a standalone-chat workspace from the registry and deletes its temp
 * directory. No-ops for normal workspaces.
 */
export async function removeStandaloneChatWorkspace(workspaceId: string): Promise<void> {
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace || !isStandaloneChatWorkspace(workspace)) {
    return;
  }
  const root = workspace.root;
  await removeWorkspace(workspaceId);
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
}
