/**
 * JSON / JSONL on-disk layout for agent conversations. Used only by
 * `LegacyJsonStorageDriver` so `session-store.ts` can delegate all hot paths
 * through `getStorage()` without importing the legacy driver (cycle break).
 */
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDir, readJsonFile, writeJsonFile } from "../persistence.js";
import { normalizeConversationRecord } from "./conversation-normalize.js";
import { readConversationEventsSinceEfficient } from "./event-log-read.js";
import type {
  AgentConversationRecord,
  AgentEventInput,
  AgentStoredEvent,
} from "./types.js";

const appendQueues = new Map<string, Promise<void>>();

export function getConversationRoot(workspaceId: string): string {
  return path.join(DATA_DIR, "workspaces", workspaceId, "conversations");
}

export function getConversationDir(workspaceId: string, conversationId: string): string {
  return path.join(getConversationRoot(workspaceId), conversationId);
}

export function getConversationMetaFile(workspaceId: string, conversationId: string): string {
  return path.join(getConversationDir(workspaceId, conversationId), "meta.json");
}

export function getConversationEventsFile(workspaceId: string, conversationId: string): string {
  return path.join(getConversationDir(workspaceId, conversationId), "events.jsonl");
}

function queueKey(workspaceId: string, conversationId: string): string {
  return `${workspaceId}:${conversationId}`;
}

async function withConversationQueue<T>(
  workspaceId: string,
  conversationId: string,
  run: () => Promise<T>
): Promise<T> {
  const key = queueKey(workspaceId, conversationId);
  const previous = appendQueues.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  appendQueues.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    if (release) {
      release();
    }
    if (appendQueues.get(key) === tail) {
      appendQueues.delete(key);
    }
  }
}

export async function legacyFsSaveConversationMeta(
  record: AgentConversationRecord
): Promise<void> {
  await writeJsonFile(
    getConversationMetaFile(record.workspaceId, record.id),
    record
  );
}

export async function legacyFsReadConversationRecord(
  workspaceId: string,
  conversationId: string
): Promise<AgentConversationRecord | null> {
  const fallback = null as AgentConversationRecord | null;
  const record = await readJsonFile(
    getConversationMetaFile(workspaceId, conversationId),
    fallback
  );
  if (!record || record.schemaVersion !== 1) {
    return null;
  }
  return normalizeConversationRecord(record);
}

export async function legacyFsListWorkspaceConversationRecords(
  workspaceId: string
): Promise<AgentConversationRecord[]> {
  const root = getConversationRoot(workspaceId);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const conversations = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => legacyFsReadConversationRecord(workspaceId, entry.name))
  );

  return conversations
    .filter((value): value is AgentConversationRecord => value !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
}

export async function legacyFsAppendConversationEvents(
  workspaceId: string,
  conversationId: string,
  events: AgentEventInput[]
): Promise<AgentStoredEvent[]> {
  if (events.length === 0) {
    return [];
  }

  return withConversationQueue(workspaceId, conversationId, async () => {
    const record = await legacyFsReadConversationRecord(workspaceId, conversationId);
    if (!record) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }

    await ensureDataDir();
    await fs.mkdir(getConversationDir(workspaceId, conversationId), {
      recursive: true,
    });

    let nextSeq = record.lastEventSeq + 1;
    const now = Date.now();
    const appended: AgentStoredEvent[] = events.map((event) => ({
      ...event,
      seq: nextSeq++,
      createdAt: event.createdAt ?? now,
    })) as AgentStoredEvent[];

    const lines = appended.map((event) => JSON.stringify(event)).join("\n");
    if (lines) {
      await fs.appendFile(
        getConversationEventsFile(workspaceId, conversationId),
        `${lines}\n`,
        "utf8"
      );
    }

    const latest = await legacyFsReadConversationRecord(workspaceId, conversationId);
    const base = latest ?? record;
    const bumpListRank = appended.some((e) => e.kind === "user_message");
    const lastUser = bumpListRank
      ? appended.filter((e) => e.kind === "user_message").at(-1)
      : undefined;
    const updatedRecord: AgentConversationRecord = {
      ...base,
      updatedAt: bumpListRank
        ? Math.max(base.updatedAt, lastUser?.createdAt ?? now)
        : base.updatedAt,
      lastEventSeq: appended[appended.length - 1]?.seq ?? record.lastEventSeq,
    };
    await writeJsonFile(
      getConversationMetaFile(workspaceId, conversationId),
      updatedRecord
    );

    return appended;
  });
}

export async function legacyFsReadConversationEvents(
  workspaceId: string,
  conversationId: string
): Promise<AgentStoredEvent[]> {
  try {
    const raw = await fs.readFile(
      getConversationEventsFile(workspaceId, conversationId),
      "utf8"
    );
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AgentStoredEvent)
      .sort((a, b) => a.seq - b.seq);
  } catch {
    return [];
  }
}

export async function legacyFsReadConversationEventsSince(
  workspaceId: string,
  conversationId: string,
  since = 0
): Promise<AgentStoredEvent[]> {
  const filePath = getConversationEventsFile(workspaceId, conversationId);
  return readConversationEventsSinceEfficient(filePath, since);
}

export async function legacyFsUpdateConversationRecord(
  workspaceId: string,
  conversationId: string,
  next: AgentConversationRecord
): Promise<void> {
  await writeJsonFile(
    getConversationMetaFile(workspaceId, conversationId),
    next
  );
}

export async function legacyFsDeleteConversationDir(
  workspaceId: string,
  conversationId: string
): Promise<void> {
  const key = queueKey(workspaceId, conversationId);
  const previous = appendQueues.get(key) ?? Promise.resolve();
  await previous.catch(() => undefined);
  appendQueues.delete(key);
  const dir = getConversationDir(workspaceId, conversationId);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

export async function legacyFsRewriteConversationEvents(
  workspaceId: string,
  conversationId: string,
  events: AgentStoredEvent[]
): Promise<void> {
  return withConversationQueue(workspaceId, conversationId, async () => {
    const lines = events.map((event) => JSON.stringify(event)).join("\n");
    const filePath = getConversationEventsFile(workspaceId, conversationId);
    if (lines) {
      await fs.writeFile(filePath, `${lines}\n`, "utf8");
    } else {
      await fs.writeFile(filePath, "", "utf8");
    }
  });
}
