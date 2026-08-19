import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR, readJsonFile, writeJsonFile } from "../persistence.js";

export type OAuthCoordinatorKind = "mcp" | "pi-agent" | "cloud-agents";

export type OAuthCoordinatorStatus = "pending" | "complete" | "failed";

export type OAuthCoordinatorSession = {
  id: string;
  kind: OAuthCoordinatorKind;
  status: OAuthCoordinatorStatus;
  createdAt: number;
  expiresAt: number;
  label?: string;
  error?: string;
  payload: Record<string, unknown>;
};

type OAuthSessionsFile = {
  schemaVersion: 1;
  updatedAt: number;
  sessions: Record<string, OAuthCoordinatorSession>;
};

const PENDING_TTL_MS = 15 * 60 * 1000;
const COMPLETED_TTL_MS = 30 * 60 * 1000;

function sessionsPath(): string {
  return path.join(DATA_DIR, "oauth-sessions.json");
}

async function readSessionsFile(): Promise<OAuthSessionsFile> {
  const stored = await readJsonFile<OAuthSessionsFile | null>(sessionsPath(), null);
  if (!stored || stored.schemaVersion !== 1 || !stored.sessions) {
    return { schemaVersion: 1, updatedAt: 0, sessions: {} };
  }
  return stored;
}

async function writeSessionsFile(file: OAuthSessionsFile): Promise<void> {
  await writeJsonFile(sessionsPath(), file);
}

function pruneSessions(
  sessions: Record<string, OAuthCoordinatorSession>,
  now = Date.now()
): Record<string, OAuthCoordinatorSession> {
  const next: Record<string, OAuthCoordinatorSession> = {};
  for (const [id, session] of Object.entries(sessions)) {
    const ttl = session.status === "pending" ? PENDING_TTL_MS : COMPLETED_TTL_MS;
    if (now - session.createdAt <= ttl && session.expiresAt > now - COMPLETED_TTL_MS) {
      next[id] = session;
    }
  }
  return next;
}

export async function createOAuthCoordinatorSession(input: {
  kind: OAuthCoordinatorKind;
  id?: string;
  label?: string;
  payload?: Record<string, unknown>;
  ttlMs?: number;
}): Promise<OAuthCoordinatorSession> {
  const now = Date.now();
  const session: OAuthCoordinatorSession = {
    id: input.id?.trim() || randomUUID(),
    kind: input.kind,
    status: "pending",
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? PENDING_TTL_MS),
    ...(input.label ? { label: input.label } : {}),
    payload: input.payload ?? {},
  };
  const file = await readSessionsFile();
  file.sessions = pruneSessions(file.sessions, now);
  file.sessions[session.id] = session;
  file.updatedAt = now;
  await writeSessionsFile(file);
  return session;
}

export async function getOAuthCoordinatorSession(
  sessionId: string
): Promise<OAuthCoordinatorSession | null> {
  const file = await readSessionsFile();
  return file.sessions[sessionId] ?? null;
}

export async function updateOAuthCoordinatorSession(
  sessionId: string,
  patch: Partial<Pick<OAuthCoordinatorSession, "status" | "error" | "label" | "payload">>
): Promise<OAuthCoordinatorSession | null> {
  const file = await readSessionsFile();
  const existing = file.sessions[sessionId];
  if (!existing) {
    return null;
  }
  const next: OAuthCoordinatorSession = {
    ...existing,
    ...patch,
    payload: patch.payload ? { ...existing.payload, ...patch.payload } : existing.payload,
  };
  file.sessions[sessionId] = next;
  file.updatedAt = Date.now();
  await writeSessionsFile(file);
  return next;
}

export function publicOAuthSession(session: OAuthCoordinatorSession): {
  id: string;
  kind: OAuthCoordinatorKind;
  status: OAuthCoordinatorStatus;
  label?: string;
  error?: string;
  createdAt: number;
  expiresAt: number;
} {
  return {
    id: session.id,
    kind: session.kind,
    status: session.status,
    ...(session.label ? { label: session.label } : {}),
    ...(session.error ? { error: session.error } : {}),
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}
