import type { WorkspaceSessionState } from "@/lib/workspace-session";

export const IPAD_RESUME_CACHE_DB_NAME = "opencursor-ipad-resume-cache";
export const IPAD_RESUME_CACHE_DB_VERSION = 1;
export const IPAD_RESUME_CACHE_STORE_NAME = "snapshots";
export const IPAD_RESUME_CACHE_LAST_KEY = "opencursor:ipad-resume-cache:lastSnapshotKey";
export const IPAD_RESUME_CACHE_SCHEMA_VERSION = 1;

export type IpadResumeSnapshotRoute = {
  pathname: string;
  search: string;
  hash: string;
};

export type IpadResumeSnapshot = {
  schemaVersion: 1;
  key: string;
  savedAt: number;
  serverKey: string;
  workspaceId: string;
  windowId: string | null;
  sessionScopeId: string;
  route: IpadResumeSnapshotRoute;
  workspaceSession: WorkspaceSessionState;
};

export function buildIpadResumeSnapshotKey(input: {
  serverKey: string;
  sessionScopeId: string;
}): string {
  return `${input.serverKey}::${input.sessionScopeId}`;
}

export function isValidIpadResumeSnapshot(
  value: unknown
): value is IpadResumeSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<IpadResumeSnapshot>;
  return (
    record.schemaVersion === IPAD_RESUME_CACHE_SCHEMA_VERSION &&
    typeof record.key === "string" &&
    typeof record.savedAt === "number" &&
    typeof record.serverKey === "string" &&
    typeof record.workspaceId === "string" &&
    (typeof record.windowId === "string" || record.windowId === null) &&
    typeof record.sessionScopeId === "string" &&
    Boolean(record.route) &&
    typeof record.workspaceSession === "object" &&
    record.workspaceSession != null
  );
}

function canUseIndexedDb(): boolean {
  return typeof window !== "undefined" && "indexedDB" in window;
}

function openIpadResumeCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!canUseIndexedDb()) {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }

    const request = window.indexedDB.open(
      IPAD_RESUME_CACHE_DB_NAME,
      IPAD_RESUME_CACHE_DB_VERSION
    );
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IPAD_RESUME_CACHE_STORE_NAME)) {
        db.createObjectStore(IPAD_RESUME_CACHE_STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open IndexedDB."));
    request.onblocked = () =>
      reject(new Error("IndexedDB open was blocked by another tab."));
  });
}

function withSnapshotStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openIpadResumeCacheDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(IPAD_RESUME_CACHE_STORE_NAME, mode);
        const store = tx.objectStore(IPAD_RESUME_CACHE_STORE_NAME);
        const request = run(store);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(request.error ?? new Error("IndexedDB request failed."));
        tx.oncomplete = () => db.close();
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error("IndexedDB transaction aborted."));
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error("IndexedDB transaction failed."));
        };
      })
  );
}

export async function saveIpadResumeSnapshot(
  snapshot: IpadResumeSnapshot
): Promise<void> {
  await withSnapshotStore("readwrite", (store) => store.put(snapshot));
  try {
    window.localStorage.setItem(IPAD_RESUME_CACHE_LAST_KEY, snapshot.key);
  } catch {
    // IndexedDB has the actual payload; the pointer is just a fast boot hint.
  }
}

export async function loadIpadResumeSnapshot(
  key: string
): Promise<IpadResumeSnapshot | null> {
  const value = await withSnapshotStore<unknown>("readonly", (store) =>
    store.get(key)
  );
  return isValidIpadResumeSnapshot(value) ? value : null;
}

export function readLastIpadResumeSnapshotKey(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage.getItem(IPAD_RESUME_CACHE_LAST_KEY);
  } catch {
    return null;
  }
}

export function clearLastIpadResumeSnapshotKey(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(IPAD_RESUME_CACHE_LAST_KEY);
  } catch {
    // ignore
  }
}
