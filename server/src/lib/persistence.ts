import path from "node:path";
import { promises as fs } from "node:fs";
import {
  DATA_DIR,
  createWorkspaceId,
  ensureDataDir,
  getAllowedWorkspaceRoots,
  isWithinAllowedRoots,
  normalizeWorkspaceRoot,
  resolveRepoRootFromProcessCwd,
} from "./data-dir.js";
import { readStoredDocument, writeStoredDocument } from "./storage.js";

const writeQueues = new Map<string, Promise<void>>();

export type PersistedEnvelope<T> = {
  schemaVersion: number;
  updatedAt: number;
  data: T;
};

export async function readJsonFile<T>(
  filePath: string,
  fallback: T
): Promise<T> {
  const normalizedPath = path.resolve(filePath);
  try {
    const stored = await readStoredDocument(normalizedPath);
    if (stored) {
      return JSON.parse(stored.payload) as T;
    }
  } catch {
    // Fall through to legacy JSON files if the DB row is malformed.
  }

  try {
    const raw = await fs.readFile(normalizedPath, "utf8");
    const parsed = JSON.parse(raw) as T;
    await writeStoredDocument({
      key: normalizedPath,
      payload: JSON.stringify(parsed),
      updatedAt: Date.now(),
    }).catch(() => undefined);
    return parsed;
  } catch {
    return fallback;
  }
}

export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  const normalizedPath = path.resolve(filePath);
  const previousWrite = writeQueues.get(normalizedPath) ?? Promise.resolve();
  const nextWrite = previousWrite.catch(() => undefined).then(async () => {
    await ensureDataDir();
    await writeStoredDocument({
      key: normalizedPath,
      payload: JSON.stringify(data),
      updatedAt: Date.now(),
    });
  });

  writeQueues.set(normalizedPath, nextWrite);

  try {
    await nextWrite;
  } finally {
    if (writeQueues.get(normalizedPath) === nextWrite) {
      writeQueues.delete(normalizedPath);
    }
  }
}

export {
  DATA_DIR,
  createWorkspaceId,
  ensureDataDir,
  getAllowedWorkspaceRoots,
  isWithinAllowedRoots,
  normalizeWorkspaceRoot,
  resolveRepoRootFromProcessCwd,
};
