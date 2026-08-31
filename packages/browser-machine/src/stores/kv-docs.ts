/**
 * Typed JSON documents in the `kv` object store, with a small in-memory
 * cache so hot documents (registry, records) avoid repeated IDB round-trips.
 */
import { KV_STORE, idbDelete, idbGet, idbPut } from "../idb";

const cache = new Map<string, unknown>();

const idbAvailable = typeof indexedDB !== "undefined";

export async function readDoc<T>(key: string): Promise<T | null> {
  if (cache.has(key)) {
    return (cache.get(key) as T) ?? null;
  }
  if (!idbAvailable) {
    cache.set(key, null);
    return null;
  }
  const stored = await idbGet<T>(KV_STORE, key);
  cache.set(key, stored ?? null);
  return stored ?? null;
}

export async function writeDoc<T>(key: string, value: T): Promise<void> {
  cache.set(key, value);
  if (!idbAvailable) return;
  await idbPut(KV_STORE, value, key);
}

export async function deleteDoc(key: string): Promise<void> {
  cache.set(key, null);
  if (!idbAvailable) return;
  await idbDelete(KV_STORE, key);
}
