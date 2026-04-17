import { getStorage } from "../storage/runtime.js";

export type PersistedWorkspaceSession = {
  schemaVersion: 1;
  editor?: unknown;
  chat?: unknown;
  explorer?: unknown;
  layout?: unknown;
  agentView?: unknown;
  settingsView?: unknown;
};

const FRESH_WORKSPACE_WINDOW_HIDDEN_CONVERSATIONS_SENTINEL =
  "__workspace_window_fresh__";

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

export async function getWorkspaceSession(
  workspaceId: string
): Promise<PersistedWorkspaceSession | null> {
  return (await getStorage()).getWorkspaceSession(workspaceId);
}

export async function saveWorkspaceSession(
  workspaceId: string,
  session: PersistedWorkspaceSession
): Promise<void> {
  await (await getStorage()).saveWorkspaceSession(workspaceId, session);
}

export async function listWorkspaceWindows(
  workspaceId: string
): Promise<WorkspaceWindowRecord[]> {
  return (await getStorage()).listWorkspaceWindows(workspaceId);
}

export async function saveWorkspaceWindows(
  workspaceId: string,
  windows: WorkspaceWindowRecord[]
): Promise<void> {
  await (await getStorage()).saveWorkspaceWindows(workspaceId, windows);
}

export async function getWorkspaceWindowSession(
  workspaceId: string,
  windowId: string
): Promise<PersistedWorkspaceSession | null> {
  return (await getStorage()).getWorkspaceWindowSession(workspaceId, windowId);
}

export async function saveWorkspaceWindowSession(
  workspaceId: string,
  windowId: string,
  session: PersistedWorkspaceSession
): Promise<void> {
  await (await getStorage()).saveWorkspaceWindowSession(
    workspaceId,
    windowId,
    session
  );
}

function createWorkspaceWindowLabel(
  existing: WorkspaceWindowRecord[],
  requested?: string
): string {
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
  await saveWorkspaceWindowSession(
    workspaceId,
    windowRecord.id,
    input?.session ?? {
      schemaVersion: 1,
      chat: {
        tabs: [],
        hiddenConversationIds: [FRESH_WORKSPACE_WINDOW_HIDDEN_CONVERSATIONS_SENTINEL],
      },
    }
  );
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
