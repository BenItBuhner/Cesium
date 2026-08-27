import { isSecretEnvelope, openSecret, sealSecret } from "@cesium/core";
import { clientKeyValueStore } from "./platform";

export const SECRET_WRAPPING_KEY_STORAGE_KEY = "cesium.secrets.wrapping-key";
export const SECRET_WRAPPING_KEY_CLOUD_KIND = "wrapping-key";

function randomWrappingKey(): string {
  const bytes = new Uint8Array(32);
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random generation is required for secret wrapping keys.");
  }
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function readLocalWrappingKey(): string | null {
  const value = clientKeyValueStore().getItem(SECRET_WRAPPING_KEY_STORAGE_KEY)?.trim();
  return value || null;
}

export function getOrCreateLocalWrappingKey(): string {
  const existing = readLocalWrappingKey();
  if (existing) {
    return existing;
  }
  const generated = randomWrappingKey();
  clientKeyValueStore().setItem(SECRET_WRAPPING_KEY_STORAGE_KEY, generated);
  return generated;
}

export function adoptCloudWrappingKey(key: string): void {
  const trimmed = key.trim();
  if (!trimmed) {
    return;
  }
  clientKeyValueStore().setItem(SECRET_WRAPPING_KEY_STORAGE_KEY, trimmed);
}

export async function sealCredential(
  plaintext: string,
  purpose: string
): Promise<string> {
  return sealSecret(plaintext, getOrCreateLocalWrappingKey(), purpose);
}

export async function openCredential(
  value: string | undefined,
  purpose: string
): Promise<string | undefined> {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!isSecretEnvelope(trimmed)) {
    return trimmed;
  }
  const key = readLocalWrappingKey();
  if (!key) {
    return undefined;
  }
  return (await openSecret(trimmed, key, purpose)) ?? undefined;
}
