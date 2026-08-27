/**
 * Standardized secret envelope for API keys and other credentials.
 *
 * Format: `cesium-secret.v1.<iv>.<ciphertext>.<tag>` (base64url parts).
 * Algorithm: AES-256-GCM, key = SHA-256(wrapping secret), 12-byte IV,
 * 128-bit tag. Optional `purpose` is bound as AAD so a sealed value cannot
 * be swapped into a different field.
 *
 * Works in browsers and Node/Bun via `crypto.subtle`. Server code that must
 * stay synchronous can use the matching Node helpers in the engine.
 */

export const SECRET_ENVELOPE_PREFIX = "cesium-secret";
export const SECRET_ENVELOPE_VERSION = "v1";

const AES_GCM = "AES-GCM";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type SecretEnvelopeParts = {
  iv: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

function requireSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto is required to seal or open secrets.");
  }
  return subtle;
}

function asBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function isSecretEnvelope(value: string | null | undefined): boolean {
  if (!value || typeof value !== "string") {
    return false;
  }
  const parts = value.split(".");
  return (
    parts.length === 5 &&
    parts[0] === SECRET_ENVELOPE_PREFIX &&
    parts[1] === SECRET_ENVELOPE_VERSION &&
    Boolean(parts[2] && parts[3] && parts[4])
  );
}

export function parseSecretEnvelope(value: string): SecretEnvelopeParts | null {
  const parts = value.split(".");
  if (
    parts.length !== 5 ||
    parts[0] !== SECRET_ENVELOPE_PREFIX ||
    parts[1] !== SECRET_ENVELOPE_VERSION ||
    !parts[2] ||
    !parts[3] ||
    !parts[4]
  ) {
    return null;
  }
  try {
    return {
      iv: base64UrlToBytes(parts[2]),
      ciphertext: base64UrlToBytes(parts[3]),
      tag: base64UrlToBytes(parts[4]),
    };
  } catch {
    return null;
  }
}

export function serializeSecretEnvelope(parts: SecretEnvelopeParts): string {
  return [
    SECRET_ENVELOPE_PREFIX,
    SECRET_ENVELOPE_VERSION,
    bytesToBase64Url(parts.iv),
    bytesToBase64Url(parts.ciphertext),
    bytesToBase64Url(parts.tag),
  ].join(".");
}

export async function digestWrappingSecret(secret: string): Promise<Uint8Array> {
  const subtle = requireSubtle();
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return new Uint8Array(digest);
}

export async function sealSecret(
  plaintext: string,
  wrappingSecret: string,
  purpose = "secret"
): Promise<string> {
  const subtle = requireSubtle();
  const keyBytes = await digestWrappingSecret(wrappingSecret);
  const key = await subtle.importKey("raw", asBufferSource(keyBytes), { name: AES_GCM }, false, ["encrypt"]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const additionalData = new TextEncoder().encode(purpose);
  const encrypted = new Uint8Array(
    await subtle.encrypt(
      { name: AES_GCM, iv, additionalData, tagLength: TAG_BYTES * 8 },
      key,
      new TextEncoder().encode(plaintext)
    )
  );
  const ciphertext = encrypted.slice(0, Math.max(0, encrypted.length - TAG_BYTES));
  const tag = encrypted.slice(encrypted.length - TAG_BYTES);
  return serializeSecretEnvelope({ iv, ciphertext, tag });
}

export async function openSecret(
  envelope: string,
  wrappingSecret: string,
  purpose = "secret"
): Promise<string | null> {
  const parts = parseSecretEnvelope(envelope);
  if (!parts || parts.iv.length !== IV_BYTES || parts.tag.length !== TAG_BYTES) {
    return null;
  }
  try {
    const subtle = requireSubtle();
    const keyBytes = await digestWrappingSecret(wrappingSecret);
    const key = await subtle.importKey("raw", asBufferSource(keyBytes), { name: AES_GCM }, false, ["decrypt"]);
    const combined = new Uint8Array(parts.ciphertext.length + parts.tag.length);
    combined.set(parts.ciphertext, 0);
    combined.set(parts.tag, parts.ciphertext.length);
    const additionalData = new TextEncoder().encode(purpose);
    const decrypted = await subtle.decrypt(
      { name: AES_GCM, iv: asBufferSource(parts.iv), additionalData, tagLength: TAG_BYTES * 8 },
      key,
      asBufferSource(combined)
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}

export function secretLastFour(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(-4);
}
