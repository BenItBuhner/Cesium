/**
 * Per-workspace UI session persistence (editor tabs, chat, layout) with the
 * same ETag/revision optimistic-concurrency behavior as the real engine.
 */
import { readDoc, writeDoc } from "./kv-docs";

export type PersistedWorkspaceSession = {
  schemaVersion: 1;
  editor?: unknown;
  chat?: unknown;
  explorer?: unknown;
  layout?: unknown;
  agentView?: unknown;
  settingsView?: unknown;
};

const revisions = new Map<string, number>();

export function sessionRevisionKey(workspaceId: string, windowId: string | null): string {
  return windowId ? `workspace:${workspaceId}:window:${windowId}` : `workspace:${workspaceId}`;
}

export function getRevision(key: string): number {
  return revisions.get(key) ?? 0;
}

export function bumpRevision(key: string): number {
  const next = (revisions.get(key) ?? 0) + 1;
  revisions.set(key, next);
  return next;
}

export function formatEtag(revision: number): string {
  return `W/"${revision}"`;
}

export function parseRevisionHeader(value: string | null | undefined): { value: number } | null {
  if (!value) return null;
  const match = value.trim().match(/^(?:W\/)?"?(\d+)"?$/);
  if (!match) return null;
  const numeric = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(numeric) ? { value: numeric } : null;
}

export class SessionStore {
  private docKey(workspaceId: string, windowId: string | null): string {
    return windowId
      ? `workspace-session:${workspaceId}:window:${windowId}`
      : `workspace-session:${workspaceId}`;
  }

  async get(workspaceId: string, windowId: string | null): Promise<PersistedWorkspaceSession | null> {
    return readDoc<PersistedWorkspaceSession>(this.docKey(workspaceId, windowId));
  }

  async save(
    workspaceId: string,
    windowId: string | null,
    session: PersistedWorkspaceSession
  ): Promise<void> {
    await writeDoc(this.docKey(workspaceId, windowId), session);
  }
}
