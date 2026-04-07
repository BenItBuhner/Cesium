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

export type WorkspaceWindowRecord = {
  id: string;
  workspaceId: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  lastFocusedAt?: number;
  closedAt?: number;
};

type PersistedWorkspaceWindowRegistry = {
  schemaVersion: 1;
  windows: WorkspaceWindowRecord[];
};

function getWorkspaceSessionFile(workspaceId: string): string {
  return path.join(DATA_DIR, "workspaces", workspaceId, "session.json");
}

function getWorkspaceWindowRegistryFile(workspaceId: string): string {
  return path.join(DATA_DIR, "workspaces", workspaceId, "windows.json");
}

function getWorkspaceWindowSessionFile(
  workspaceId: string,
  windowId: string
): string {
  return path.join(DATA_DIR, "workspaces", workspaceId, "windows", `${windowId}.session.json`);
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

function normalizeWorkspaceWindowRecords(raw: unknown): WorkspaceWindowRecord[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((value): value is WorkspaceWindowRecord => {
      if (!value || typeof value !== "object") {
        return false;
      }
      const record = value as Partial<WorkspaceWindowRecord>;
      return (
        typeof record.id === "string" &&
        record.id.length > 0 &&
        typeof record.workspaceId === "string" &&
        record.workspaceId.length > 0 &&
        typeof record.label === "string" &&
        record.label.length > 0 &&
        typeof record.createdAt === "number" &&
        Number.isFinite(record.createdAt) &&
        typeof record.updatedAt === "number" &&
        Number.isFinite(record.updatedAt) &&
        typeof record.lastOpenedAt === "number" &&
        Number.isFinite(record.lastOpenedAt)
      );
    })
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export async function listWorkspaceWindows(
  workspaceId: string
): Promise<WorkspaceWindowRecord[]> {
  const registry = await readJsonFile<PersistedWorkspaceWindowRegistry | null>(
    getWorkspaceWindowRegistryFile(workspaceId),
    null
  );
  if (!registry || registry.schemaVersion !== 1) {
    return [];
  }
  return normalizeWorkspaceWindowRecords(registry.windows);
}

export async function saveWorkspaceWindows(
  workspaceId: string,
  windows: WorkspaceWindowRecord[]
): Promise<void> {
  await writeJsonFile(getWorkspaceWindowRegistryFile(workspaceId), {
    schemaVersion: 1,
    windows,
  } satisfies PersistedWorkspaceWindowRegistry);
}

export async function getWorkspaceWindowSession(
  workspaceId: string,
  windowId: string
): Promise<PersistedWorkspaceSession | null> {
  const session = await readJsonFile<PersistedWorkspaceSession | null>(
    getWorkspaceWindowSessionFile(workspaceId, windowId),
    null
  );
  if (!session || session.schemaVersion !== 1) {
    return null;
  }
  return session;
}

export async function saveWorkspaceWindowSession(
  workspaceId: string,
  windowId: string,
  session: PersistedWorkspaceSession
): Promise<void> {
  await writeJsonFile(getWorkspaceWindowSessionFile(workspaceId, windowId), session);
}

function createWorkspaceWindowLabel(existing: WorkspaceWindowRecord[], requested?: string): string {
  if (requested && requested.trim().length > 0) {
    return requested.trim();
  }
  const existingIndexes = new Set(
    existing
      .map((windowRecord) => windowRecord.label.match(/^Window (\d+)$/)?.[1])
      .filter((value): value is string => Boolean(value))
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isFinite(value) && value > 0)
  );
  let nextIndex = 1;
  while (existingIndexes.has(nextIndex)) {
    nextIndex += 1;
  }
  return `Window ${nextIndex}`;
}

function newWindowId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function getWorkspaceWindow(
  workspaceId: string,
  windowId: string
): Promise<WorkspaceWindowRecord | null> {
  const windows = await listWorkspaceWindows(workspaceId);
  return windows.find((windowRecord) => windowRecord.id === windowId) ?? null;
}

export async function createWorkspaceWindow(
  workspaceId: string,
  input?: {
    name?: string;
    session?: PersistedWorkspaceSession;
  }
): Promise<WorkspaceWindowRecord> {
  const windows = await listWorkspaceWindows(workspaceId);
  const now = Date.now();
  const windowRecord: WorkspaceWindowRecord = {
    id: newWindowId(),
    workspaceId,
    label: createWorkspaceWindowLabel(windows, input?.name),
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    lastFocusedAt: now,
  };
  await saveWorkspaceWindows(workspaceId, [windowRecord, ...windows]);
  if (input?.session) {
    await saveWorkspaceWindowSession(workspaceId, windowRecord.id, input.session);
  }
  return windowRecord;
}

export async function updateWorkspaceWindow(
  workspaceId: string,
  windowId: string,
  patch: {
    name?: string;
    lastOpenedAt?: number;
    lastFocusedAt?: number;
    markClosed?: boolean;
  }
): Promise<WorkspaceWindowRecord | null> {
  const windows = await listWorkspaceWindows(workspaceId);
  const target = windows.find((windowRecord) => windowRecord.id === windowId);
  if (!target) {
    return null;
  }
  const now = Date.now();
  const nextWindow: WorkspaceWindowRecord = {
    ...target,
    label:
      typeof patch.name === "string" && patch.name.trim().length > 0
        ? patch.name.trim()
        : target.label,
    lastOpenedAt:
      typeof patch.lastOpenedAt === "number" && Number.isFinite(patch.lastOpenedAt)
        ? patch.lastOpenedAt
        : target.lastOpenedAt,
    lastFocusedAt:
      typeof patch.lastFocusedAt === "number" && Number.isFinite(patch.lastFocusedAt)
        ? patch.lastFocusedAt
        : target.lastFocusedAt,
    updatedAt: now,
    closedAt: patch.markClosed ? now : target.closedAt,
  };
  const nextWindows = windows
    .map((windowRecord) => (windowRecord.id === windowId ? nextWindow : windowRecord))
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  await saveWorkspaceWindows(workspaceId, nextWindows);
  return nextWindow;
}
