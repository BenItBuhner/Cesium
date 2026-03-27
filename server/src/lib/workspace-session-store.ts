import path from "node:path";
import { DATA_DIR, readJsonFile, writeJsonFile } from "./persistence.js";

export type PersistedWorkspaceSession = {
  schemaVersion: 1;
  editor?: unknown;
  chat?: unknown;
  explorer?: unknown;
  layout?: unknown;
  settingsView?: unknown;
};

function getWorkspaceSessionFile(workspaceId: string): string {
  return path.join(DATA_DIR, "workspaces", workspaceId, "session.json");
}

export async function getWorkspaceSession(
  workspaceId: string
): Promise<PersistedWorkspaceSession | null> {
  const session = await readJsonFile<PersistedWorkspaceSession | null>(
    getWorkspaceSessionFile(workspaceId),
    null
  );
  if (!session || session.schemaVersion !== 1) {
    return null;
  }
  return session;
}

export async function saveWorkspaceSession(
  workspaceId: string,
  session: PersistedWorkspaceSession
): Promise<void> {
  await writeJsonFile(getWorkspaceSessionFile(workspaceId), session);
}
