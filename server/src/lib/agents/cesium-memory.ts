import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR, readJsonFile, writeJsonFile } from "../persistence.js";

/**
 * Curated agent memory: a small, bounded store of user/workspace facts the
 * agent explicitly saves. This is the Hermes-style curated-facts layer - no
 * embeddings, no index; substring/keyword search over a capped JSON file.
 * Saves consolidate instead of piling up: a repeated key or (near-)duplicate
 * text updates the existing entry, and entries evicted by the per-scope cap
 * are returned to the caller so the agent is told what was dropped.
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
  /** Optional stable slug; saving with an existing key updates that entry. */
  key?: string;
  createdAt: number;
  updatedAt: number;
  sourceConversationId?: string;
};

type PersistedMemoryFile = {
  schemaVersion: 1;
  updatedAt: number;
  entries: CesiumMemoryEntry[];
};

/**
 * Store caps only bound search/list coverage and the JSON read each turn; the
 * prompt sees at most the snapshot below (20 entries / 3,000 chars, each line
 * clipped), so raising them does not grow the reminder.
 */
export const CESIUM_MEMORY_MAX_ENTRIES_PER_SCOPE = 500;
export const CESIUM_MEMORY_MAX_CONTENT_CHARS = 1_000;
export const CESIUM_MEMORY_SNAPSHOT_MAX_ENTRIES = 20;
export const CESIUM_MEMORY_SNAPSHOT_MAX_CHARS = 3_000;
export const CESIUM_MEMORY_SNAPSHOT_MAX_LINE_CHARS = 400;
/** Word-set Jaccard similarity at or above which two entries count as the same fact. */
export const CESIUM_MEMORY_NEAR_DUPLICATE_SIMILARITY = 0.85;
const CESIUM_MEMORY_KEY_MAX_CHARS = 64;

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

export function normalizeCesiumMemoryKey(raw: string | undefined): string | undefined {
  const key = raw
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CESIUM_MEMORY_KEY_MAX_CHARS);
  return key || undefined;
}

/** Case, punctuation, and whitespace-insensitive form used for duplicate detection. */
export function normalizeCesiumMemoryText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function memoryTextSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const left = new Set(a.split(" ").filter(Boolean));
  const right = new Set(b.split(" ").filter(Boolean));
  // Very short entries only merge on an exact match; one shared word is not the same fact.
  if (left.size < 3 || right.size < 3) return 0;
  let shared = 0;
  for (const word of left) {
    if (right.has(word)) shared += 1;
  }
  return shared / (left.size + right.size - shared);
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
    key: typeof record.key === "string" ? normalizeCesiumMemoryKey(record.key) : undefined,
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

export type CesiumMemorySaveResult = {
  entry: CesiumMemoryEntry;
  /** Why an existing entry was updated instead of a new one appended; absent when created. */
  mergedBy?: "id" | "key" | "duplicate" | "near-duplicate";
  /** The updated entry's content before this save. */
  previousContent?: string;
  /** Other entries whose text duplicated the saved content, folded into it and removed. */
  foldedDuplicates: CesiumMemoryEntry[];
  /** Least recently updated entries dropped because the scope exceeded its cap. */
  evicted: CesiumMemoryEntry[];
  /** True when the content was clipped to CESIUM_MEMORY_MAX_CONTENT_CHARS. */
  truncated: boolean;
};

export async function saveCesiumMemoryEntry(input: {
  workspaceId: string;
  scope: CesiumMemoryScope;
  category: CesiumMemoryCategory;
  content: string;
  key?: string;
  sourceConversationId?: string;
  /** When set, updates the existing entry in place instead of appending. */
  id?: string;
}): Promise<CesiumMemorySaveResult> {
  const trimmed = input.content.trim();
  const content = trimmed.slice(0, CESIUM_MEMORY_MAX_CONTENT_CHARS);
  if (!content) {
    throw new Error("Memory content must not be empty.");
  }
  const key = normalizeCesiumMemoryKey(input.key);
  const entries = await readMemoryFile(input.scope, input.workspaceId);
  const now = Date.now();
  const normalized = normalizeCesiumMemoryText(content);

  let existing: CesiumMemoryEntry | undefined;
  let mergedBy: CesiumMemorySaveResult["mergedBy"];
  if (input.id) {
    existing = entries.find((entry) => entry.id === input.id);
    if (!existing) {
      throw new Error(`No memory entry with id ${input.id} in ${input.scope} scope.`);
    }
    mergedBy = "id";
  } else if (key && (existing = entries.find((entry) => entry.key === key))) {
    mergedBy = "key";
  } else {
    let best: { entry: CesiumMemoryEntry; similarity: number } | null = null;
    for (const entry of entries) {
      const similarity = memoryTextSimilarity(normalized, normalizeCesiumMemoryText(entry.content));
      if (similarity >= CESIUM_MEMORY_NEAR_DUPLICATE_SIMILARITY && (!best || similarity > best.similarity)) {
        best = { entry, similarity };
      }
    }
    if (best) {
      existing = best.entry;
      mergedBy = best.similarity === 1 ? "duplicate" : "near-duplicate";
    }
  }

  const entry: CesiumMemoryEntry = existing
    ? {
        ...existing,
        category: input.category,
        content,
        key: key ?? existing.key,
        updatedAt: now,
        sourceConversationId: input.sourceConversationId ?? existing.sourceConversationId,
      }
    : {
        id: randomUUID(),
        scope: input.scope,
        category: input.category,
        content,
        key,
        createdAt: now,
        updatedAt: now,
        sourceConversationId: input.sourceConversationId,
      };
  const foldedDuplicates = entries.filter(
    (candidate) =>
      candidate.id !== entry.id && normalizeCesiumMemoryText(candidate.content) === normalized
  );
  const folded = new Set(foldedDuplicates.map((candidate) => candidate.id));
  let next = entries.filter((candidate) => candidate.id !== entry.id && !folded.has(candidate.id));
  next.push(entry);
  let evicted: CesiumMemoryEntry[] = [];
  if (next.length > CESIUM_MEMORY_MAX_ENTRIES_PER_SCOPE) {
    const byAge = next
      .filter((candidate) => candidate.id !== entry.id)
      .sort((a, b) => a.updatedAt - b.updatedAt);
    evicted = byAge.slice(0, next.length - CESIUM_MEMORY_MAX_ENTRIES_PER_SCOPE);
    const dropped = new Set(evicted.map((candidate) => candidate.id));
    next = next.filter((candidate) => !dropped.has(candidate.id));
  }
  await writeMemoryFile(input.scope, input.workspaceId, next);
  return {
    entry,
    mergedBy,
    previousContent: existing?.content,
    foldedDuplicates,
    evicted,
    truncated: trimmed.length > content.length,
  };
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
      const haystack = `${entry.category} ${entry.key ?? ""} ${entry.content}`.toLowerCase();
      const hits = terms.filter((term) => haystack.includes(term)).length;
      return { entry, hits };
    })
    .filter(({ hits }) => hits > 0)
    .sort((a, b) => b.hits - a.hits || b.entry.updatedAt - a.entry.updatedAt);
  return scored.slice(0, limit).map(({ entry }) => entry);
}

export function formatCesiumMemoryEntry(entry: CesiumMemoryEntry, maxContentChars?: number): string {
  const content =
    maxContentChars && entry.content.length > maxContentChars
      ? `${entry.content.slice(0, maxContentChars)}... [${entry.content.length - maxContentChars} more chars]`
      : entry.content;
  return `- [${entry.scope}/${entry.category}] ${content} (id: ${entry.id}${entry.key ? `, key: ${entry.key}` : ""})`;
}

/**
 * Compact recency-ordered snapshot rendered into the per-turn reminder.
 */
export function renderCesiumMemorySnapshot(entries: CesiumMemoryEntry[]): string {
  if (entries.length === 0) {
    return "";
  }
  const lines: string[] = [];
  let used = 0;
  for (const entry of entries.slice(0, CESIUM_MEMORY_SNAPSHOT_MAX_ENTRIES)) {
    const line = formatCesiumMemoryEntry(entry, CESIUM_MEMORY_SNAPSHOT_MAX_LINE_CHARS);
    if (used + line.length > CESIUM_MEMORY_SNAPSHOT_MAX_CHARS) {
      break;
    }
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n");
}

const MERGE_REASONS: Record<NonNullable<CesiumMemorySaveResult["mergedBy"]>, string> = {
  id: "by id",
  key: "same key",
  duplicate: "same text as an existing entry",
  "near-duplicate": "near-duplicate of an existing entry",
};

/** Tool result for a save: every merge, fold, truncation, and eviction is spelled out. */
export function formatCesiumMemorySaveResult(result: CesiumMemorySaveResult): string {
  const { entry } = result;
  const lines = [
    result.mergedBy
      ? `Updated memory entry ${entry.id} (${MERGE_REASONS[result.mergedBy]}) instead of adding a new one.`
      : "Saved memory entry.",
    formatCesiumMemoryEntry(entry),
  ];
  if (result.mergedBy && result.previousContent !== undefined && result.previousContent !== entry.content) {
    lines.push(`Previous text: ${result.previousContent}`);
  }
  if (result.truncated) {
    lines.push(`Content was cut to ${CESIUM_MEMORY_MAX_CONTENT_CHARS} characters.`);
  }
  if (result.foldedDuplicates.length > 0) {
    lines.push(
      `Removed ${result.foldedDuplicates.length} duplicate entr${result.foldedDuplicates.length === 1 ? "y" : "ies"} with the same text:`,
      ...result.foldedDuplicates.map((duplicate) => formatCesiumMemoryEntry(duplicate))
    );
  }
  if (result.evicted.length > 0) {
    lines.push(
      `Evicted ${result.evicted.length} least recently updated entr${result.evicted.length === 1 ? "y" : "ies"} because the ${entry.scope} scope is at its ${CESIUM_MEMORY_MAX_ENTRIES_PER_SCOPE}-entry cap (re-save any that still matter, or forget stale entries to make room):`,
      ...result.evicted.map((evicted) => formatCesiumMemoryEntry(evicted))
    );
  }
  return lines.join("\n");
}
