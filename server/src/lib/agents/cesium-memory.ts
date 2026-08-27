import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR, readJsonFile, writeJsonFile } from "../persistence.js";

/**
 * Curated agent memory: a small, bounded store of user/workspace facts the
 * agent explicitly saves. This is the Hermes-style curated-facts layer - no
 * embeddings, no index; substring/keyword search over a capped JSON file.
 */

export type CesiumMemoryScope = "user" | "workspace";

export type CesiumMemoryCategory =
  | "preference"
  | "fact"
  | "constraint"
  | "decision";

export type CesiumMemoryEntry = {
  id: string;
  scope: CesiumMemoryScope;
  category: CesiumMemoryCategory;
  content: string;
  createdAt: number;
  updatedAt: number;
  sourceConversationId?: string;
};

type PersistedMemoryFile = {
  schemaVersion: 1;
  updatedAt: number;
  entries: CesiumMemoryEntry[];
};

export const CESIUM_MEMORY_MAX_ENTRIES_PER_SCOPE = 200;
export const CESIUM_MEMORY_MAX_CONTENT_CHARS = 600;
export const CESIUM_MEMORY_SNAPSHOT_MAX_ENTRIES = 20;
export const CESIUM_MEMORY_SNAPSHOT_MAX_CHARS = 3_000;

function userMemoryFile(): string {
  return path.join(DATA_DIR, "profile", "agent-memory.json");
}

function workspaceMemoryFile(workspaceId: string): string {
  return path.join(DATA_DIR, "workspaces", workspaceId, "agent-memory.json");
}

function memoryFileForScope(scope: CesiumMemoryScope, workspaceId: string): string {
  return scope === "user" ? userMemoryFile() : workspaceMemoryFile(workspaceId);
}

function isCategory(value: unknown): value is CesiumMemoryCategory {
  return (
    value === "preference" ||
    value === "fact" ||
    value === "constraint" ||
    value === "decision"
  );
}

function normalizeEntry(raw: unknown, scope: CesiumMemoryScope): CesiumMemoryEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const content =
    typeof record.content === "string" && record.content.trim()
      ? record.content.trim().slice(0, CESIUM_MEMORY_MAX_CONTENT_CHARS)
      : null;
  if (!content) {
    return null;
  }
  const now = Date.now();
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : randomUUID(),
    scope,
    category: isCategory(record.category) ? record.category : "fact",
    content,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : now,
    sourceConversationId:
      typeof record.sourceConversationId === "string" && record.sourceConversationId.trim()
        ? record.sourceConversationId.trim()
        : undefined,
  };
}

async function readMemoryFile(
  scope: CesiumMemoryScope,
  workspaceId: string
): Promise<CesiumMemoryEntry[]> {
  const raw = await readJsonFile<unknown>(memoryFileForScope(scope, workspaceId), null);
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as PersistedMemoryFile).entries)) {
    return [];
  }
  return (raw as PersistedMemoryFile).entries
    .map((entry) => normalizeEntry(entry, scope))
    .filter((entry): entry is CesiumMemoryEntry => entry != null)
    .slice(0, CESIUM_MEMORY_MAX_ENTRIES_PER_SCOPE);
}

async function writeMemoryFile(
  scope: CesiumMemoryScope,
  workspaceId: string,
  entries: CesiumMemoryEntry[]
): Promise<void> {
  const bounded = [...entries]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, CESIUM_MEMORY_MAX_ENTRIES_PER_SCOPE);
  const file: PersistedMemoryFile = {
    schemaVersion: 1,
    updatedAt: Date.now(),
    entries: bounded,
  };
  await writeJsonFile(memoryFileForScope(scope, workspaceId), file);
}

export async function listCesiumMemoryEntries(input: {
  workspaceId: string;
  scope?: CesiumMemoryScope;
}): Promise<CesiumMemoryEntry[]> {
  const scopes: CesiumMemoryScope[] = input.scope ? [input.scope] : ["user", "workspace"];
  const all = await Promise.all(
    scopes.map((scope) => readMemoryFile(scope, input.workspaceId))
  );
  return all.flat().sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveCesiumMemoryEntry(input: {
  workspaceId: string;
  scope: CesiumMemoryScope;
  category: CesiumMemoryCategory;
  content: string;
  sourceConversationId?: string;
  /** When set, updates the existing entry in place instead of appending. */
  id?: string;
}): Promise<CesiumMemoryEntry> {
  const content = input.content.trim().slice(0, CESIUM_MEMORY_MAX_CONTENT_CHARS);
  if (!content) {
    throw new Error("Memory content must not be empty.");
  }
  const entries = await readMemoryFile(input.scope, input.workspaceId);
  const now = Date.now();
  const existing = input.id ? entries.find((entry) => entry.id === input.id) : undefined;
  if (input.id && !existing) {
    throw new Error(`No memory entry with id ${input.id} in ${input.scope} scope.`);
  }
  const entry: CesiumMemoryEntry = existing
    ? {
        ...existing,
        category: input.category,
        content,
        updatedAt: now,
        sourceConversationId: input.sourceConversationId ?? existing.sourceConversationId,
      }
    : {
        id: randomUUID(),
        scope: input.scope,
        category: input.category,
        content,
        createdAt: now,
        updatedAt: now,
        sourceConversationId: input.sourceConversationId,
      };
  const next = existing
    ? entries.map((candidate) => (candidate.id === entry.id ? entry : candidate))
    : [...entries, entry];
  await writeMemoryFile(input.scope, input.workspaceId, next);
  return entry;
}

export async function forgetCesiumMemoryEntry(input: {
  workspaceId: string;
  id: string;
}): Promise<CesiumMemoryEntry | null> {
  for (const scope of ["user", "workspace"] as const) {
    const entries = await readMemoryFile(scope, input.workspaceId);
    const match = entries.find((entry) => entry.id === input.id);
    if (match) {
      await writeMemoryFile(
        scope,
        input.workspaceId,
        entries.filter((entry) => entry.id !== input.id)
      );
      return match;
    }
  }
  return null;
}

export async function searchCesiumMemoryEntries(input: {
  workspaceId: string;
  query: string;
  scope?: CesiumMemoryScope;
  limit?: number;
}): Promise<CesiumMemoryEntry[]> {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  const entries = await listCesiumMemoryEntries({
    workspaceId: input.workspaceId,
    scope: input.scope,
  });
  const terms = input.query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  if (terms.length === 0) {
    return entries.slice(0, limit);
  }
  const scored = entries
    .map((entry) => {
      const haystack = `${entry.category} ${entry.content}`.toLowerCase();
      const hits = terms.filter((term) => haystack.includes(term)).length;
      return { entry, hits };
    })
    .filter(({ hits }) => hits > 0)
    .sort((a, b) => b.hits - a.hits || b.entry.updatedAt - a.entry.updatedAt);
  return scored.slice(0, limit).map(({ entry }) => entry);
}

export function formatCesiumMemoryEntry(entry: CesiumMemoryEntry): string {
  return `- [${entry.scope}/${entry.category}] ${entry.content} (id: ${entry.id})`;
}

/**
 * Compact recency-ordered snapshot rendered into the per-turn reminder for
 * profiles that include the memory tool.
 */
export function renderCesiumMemorySnapshot(entries: CesiumMemoryEntry[]): string {
  if (entries.length === 0) {
    return "";
  }
  const lines: string[] = [];
  let used = 0;
  for (const entry of entries.slice(0, CESIUM_MEMORY_SNAPSHOT_MAX_ENTRIES)) {
    const line = formatCesiumMemoryEntry(entry);
    if (used + line.length > CESIUM_MEMORY_SNAPSHOT_MAX_CHARS) {
      break;
    }
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n");
}
