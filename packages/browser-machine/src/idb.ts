/**
 * Thin IndexedDB promise wrappers for the browser machine's persistence.
 *
 * Layout (single database):
 *   - `files`  - VFS records keyed by absolute path (see vfs.ts)
 *   - `kv`     - engine JSON documents (workspace registry, settings, records)
 *   - `events` - agent conversation events keyed by `${conversationId}\u0000${seq}`
 */

export const BROWSER_MACHINE_DB_NAME = "cesium-browser-machine";
export const BROWSER_MACHINE_DB_VERSION = 1;

export const FILES_STORE = "files";
export const KV_STORE = "kv";
export const EVENTS_STORE = "events";

export type IdbDatabase = IDBDatabase;

let openPromise: Promise<IDBDatabase> | null = null;

export function openBrowserMachineDb(): Promise<IDBDatabase> {
  if (openPromise) return openPromise;
  openPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this environment."));
      return;
    }
    const request = indexedDB.open(BROWSER_MACHINE_DB_NAME, BROWSER_MACHINE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FILES_STORE)) {
        const files = db.createObjectStore(FILES_STORE, { keyPath: "path" });
        files.createIndex("by_parent", "parent", { unique: false });
      }
      if (!db.objectStoreNames.contains(KV_STORE)) {
        db.createObjectStore(KV_STORE);
      }
      if (!db.objectStoreNames.contains(EVENTS_STORE)) {
        const events = db.createObjectStore(EVENTS_STORE, { keyPath: "key" });
        events.createIndex("by_conversation", "conversationId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
  return openPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
  const db = await openBrowserMachineDb();
  const tx = db.transaction(store, "readonly");
  const result = await requestToPromise(tx.objectStore(store).getAll() as IDBRequest<T[]>);
  await txDone(tx);
  return result;
}

export async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openBrowserMachineDb();
  const tx = db.transaction(store, "readonly");
  const result = await requestToPromise(
    tx.objectStore(store).get(key) as IDBRequest<T | undefined>
  );
  await txDone(tx);
  return result;
}

export async function idbPut(store: string, value: unknown, key?: IDBValidKey): Promise<void> {
  const db = await openBrowserMachineDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value as never, key as never);
  await txDone(tx);
}

export async function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  const db = await openBrowserMachineDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  await txDone(tx);
}

/** Batched writes/deletes in a single transaction (used by the VFS flush). */
export async function idbBulk(
  store: string,
  puts: unknown[],
  deletes: IDBValidKey[]
): Promise<void> {
  if (puts.length === 0 && deletes.length === 0) return;
  const db = await openBrowserMachineDb();
  const tx = db.transaction(store, "readwrite");
  const objectStore = tx.objectStore(store);
  for (const value of puts) {
    objectStore.put(value as never);
  }
  for (const key of deletes) {
    objectStore.delete(key);
  }
  await txDone(tx);
}

export async function idbGetRange<T>(
  store: string,
  range: IDBKeyRange,
  limit?: number
): Promise<T[]> {
  const db = await openBrowserMachineDb();
  const tx = db.transaction(store, "readonly");
  const request = tx.objectStore(store).getAll(range, limit) as IDBRequest<T[]>;
  const result = await requestToPromise(request);
  await txDone(tx);
  return result;
}

export async function idbDeleteRange(store: string, range: IDBKeyRange): Promise<void> {
  const db = await openBrowserMachineDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(range);
  await txDone(tx);
}
