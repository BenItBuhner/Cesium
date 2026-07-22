"use client";

export const RENDEZVOUS_FRAGMENT_KEY = "cesiumConnect";

export type RendezvousLocator = {
  version: 1;
  serverId: string;
  secret: string;
  registryBaseUrl: string;
};

export type RendezvousBootstrap = RendezvousLocator & {
  label?: string;
  initialBaseUrl?: string;
};

export type ResolvedRendezvousEndpoint = {
  baseUrl: string;
  label?: string;
  tunnelProvider?: string;
  issuedAt: number;
  recordUpdatedAt: number;
  recordExpiresAt: number;
};

type RendezvousRecordResponse = {
  record?: {
    version?: unknown;
    serverId?: unknown;
    ciphertext?: unknown;
    updatedAt?: unknown;
    expiresAt?: unknown;
  } | null;
  error?: string;
};

const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{24,80}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url value.");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "="
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function normalizeRegistryBaseUrl(value: string): string {
  const url = new URL(value);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("Rendezvous registry must use HTTPS.");
  }
  url.username = "";
  url.password = "";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}

export function normalizeRendezvousLocator(
  input: Partial<RendezvousBootstrap>
): RendezvousBootstrap {
  if (
    input.version !== 1 ||
    typeof input.serverId !== "string" ||
    !SERVER_ID_PATTERN.test(input.serverId) ||
    typeof input.secret !== "string" ||
    !SECRET_PATTERN.test(input.secret) ||
    typeof input.registryBaseUrl !== "string"
  ) {
    throw new Error("Invalid Cesium connection identity.");
  }
  return {
    version: 1,
    serverId: input.serverId,
    secret: input.secret,
    registryBaseUrl: normalizeRegistryBaseUrl(input.registryBaseUrl),
    ...(typeof input.label === "string" && input.label.trim()
      ? { label: input.label.trim().slice(0, 120) }
      : {}),
    ...(typeof input.initialBaseUrl === "string" && input.initialBaseUrl.trim()
      ? {
          initialBaseUrl: (() => {
            const url = new URL(input.initialBaseUrl);
            if (url.protocol !== "https:") {
              throw new Error("Initial rendezvous endpoint must use HTTPS.");
            }
            url.username = "";
            url.password = "";
            url.hash = "";
            return url.toString().replace(/\/+$/, "");
          })(),
        }
      : {}),
  };
}

export function encodeRendezvousBootstrap(input: RendezvousBootstrap): string {
  const value = normalizeRendezvousLocator(input);
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeRendezvousBootstrap(value: string): RendezvousBootstrap {
  const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as
    | Partial<RendezvousBootstrap>
    | null;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid Cesium connection link.");
  }
  return normalizeRendezvousLocator(parsed);
}

export function parseRendezvousBootstrapHash(hash: string): RendezvousBootstrap | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const encoded = new URLSearchParams(raw).get(RENDEZVOUS_FRAGMENT_KEY)?.trim();
  if (!encoded) {
    return null;
  }
  try {
    return decodeRendezvousBootstrap(encoded);
  } catch {
    return null;
  }
}

export function stripRendezvousBootstrapFromLocation(): void {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  if (!params.has(RENDEZVOUS_FRAGMENT_KEY)) {
    return;
  }
  params.delete(RENDEZVOUS_FRAGMENT_KEY);
  url.hash = params.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
}

async function deriveEncryptionKey(secret: string): Promise<CryptoKey> {
  const material = new TextEncoder().encode(`cesium-rendezvous-v1\0${secret}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["decrypt"]);
}

export async function decryptRendezvousCiphertext(
  locator: RendezvousLocator,
  ciphertext: string
): Promise<{ baseUrl: string; label?: string; tunnelProvider?: string; issuedAt: number }> {
  const [ivValue, encryptedValue, ...extra] = ciphertext.split(".");
  if (!ivValue || !encryptedValue || extra.length > 0) {
    throw new Error("Invalid encrypted rendezvous record.");
  }
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(ivValue),
      additionalData: new TextEncoder().encode(locator.serverId),
    },
    await deriveEncryptionKey(locator.secret),
    base64UrlToBytes(encryptedValue)
  );
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as {
    baseUrl?: unknown;
    label?: unknown;
    tunnelProvider?: unknown;
    issuedAt?: unknown;
  };
  if (
    typeof parsed.baseUrl !== "string" ||
    typeof parsed.issuedAt !== "number" ||
    !Number.isFinite(parsed.issuedAt)
  ) {
    throw new Error("Invalid decrypted rendezvous endpoint.");
  }
  const url = new URL(parsed.baseUrl);
  if (url.protocol !== "https:") {
    throw new Error("Rendezvous endpoint must use HTTPS.");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return {
    baseUrl: url.toString().replace(/\/+$/, ""),
    issuedAt: parsed.issuedAt,
    ...(typeof parsed.label === "string" && parsed.label.trim()
      ? { label: parsed.label.trim().slice(0, 120) }
      : {}),
    ...(typeof parsed.tunnelProvider === "string" && parsed.tunnelProvider.trim()
      ? { tunnelProvider: parsed.tunnelProvider.trim().slice(0, 80) }
      : {}),
  };
}

export async function resolveRendezvousEndpoint(
  locator: RendezvousLocator,
  options?: { signal?: AbortSignal }
): Promise<ResolvedRendezvousEndpoint | null> {
  const response = await fetch(
    `${normalizeRegistryBaseUrl(locator.registryBaseUrl)}/api/rendezvous/${encodeURIComponent(locator.serverId)}`,
    {
      method: "GET",
      cache: "no-store",
      signal: options?.signal,
    }
  );
  if (response.status === 404) {
    return null;
  }
  const payload = (await response.json().catch(() => ({}))) as RendezvousRecordResponse;
  if (!response.ok) {
    throw new Error(payload.error || `Rendezvous lookup failed (${response.status}).`);
  }
  const record = payload.record;
  if (
    !record ||
    record.version !== 1 ||
    record.serverId !== locator.serverId ||
    typeof record.ciphertext !== "string" ||
    typeof record.updatedAt !== "number" ||
    typeof record.expiresAt !== "number" ||
    record.expiresAt <= Date.now()
  ) {
    return null;
  }
  const endpoint = await decryptRendezvousCiphertext(locator, record.ciphertext);
  return {
    ...endpoint,
    recordUpdatedAt: record.updatedAt,
    recordExpiresAt: record.expiresAt,
  };
}
