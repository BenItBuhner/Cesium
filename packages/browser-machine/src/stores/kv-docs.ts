/**
 * Typed JSON documents in the `kv` object store, with a small in-memory
 * cache so hot documents (registry, records) avoid repeated IDB round-trips.
 */
import { KV_STORE, idbDelete, idbGet, idbPut } from "../idb";

const cache = new Map<string, unknown>();

export async function readDoc<T>(key: string): Promise<T | null> {
  if (cache.has(key)) {
    return (cache.get(key) as T) ?? null;
  }
  const stored = await idbGet<T>(KV_STORE, key);
  cache.set(key, stored ?? null);
  return stored ?? null;
}

export async function writeDoc<T>(key: string, value: T): Promise<void> {
  cache.set(key, value);
  await idbPut(KV_STORE, value, key);
}

export async function deleteDoc(key: string): Promise<void> {
  cache.set(key, null);
  await idbDelete(KV_STORE, key);
}
