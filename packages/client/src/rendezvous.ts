"use client";

export const RENDEZVOUS_FRAGMENT_KEY = "cesiumConnect";
export const CONNECT_SESSION_FRAGMENT_KEY = "cesiumSession";
export const RENDEZVOUS_PROTOCOL_HEADER = "X-Cesium-Rendezvous-Version";
export const RENDEZVOUS_PROTOCOL_VERSION = "2";

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

export type EncryptedRendezvousRecord = {
  version: number;
  serverId: string;
  ciphertext: string;
  updatedAt: number;
  expiresAt: number;
};

type RendezvousRecordResponse = {
  record?: Partial<EncryptedRendezvousRecord> | null;
  error?: string;
};

const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{24,80}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_BATCH_SIZE = 250;

export class RendezvousLookupError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs: number | null
  ) {
    super(message);
    this.name = "RendezvousLookupError";
  }

  /** Deployment/account failures apply to every server using this registry. */
  get isGlobalFailure(): boolean {
    return this.status === 402 || this.status === 429 || this.status >= 500;
  }
}

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

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
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

/**
 * Locators saved before discovery moved to Convex name the account site's
 * `/api/rendezvous`, a legacy shim over the same Convex records. Reading the
 * records from Convex directly keeps those servers discoverable whether or not
 * the site is up.
 */
const LEGACY_HOSTED_REGISTRY_ORIGINS = new Set([
  "https://cesium.techlitnow.com",
  "https://www.cesium.techlitnow.com",
]);
export const CLOUD_RENDEZVOUS_REGISTRY_ORIGIN = "https://insightful-wolverine-140.convex.site";

export function rendezvousLookupOrigin(registryBaseUrl: string): string {
  const origin = normalizeRegistryBaseUrl(registryBaseUrl);
  return LEGACY_HOSTED_REGISTRY_ORIGINS.has(origin) ? CLOUD_RENDEZVOUS_REGISTRY_ORIGIN : origin;
}

function registryRecordUrl(registryBaseUrl: string, serverId: string): string {
  const origin = rendezvousLookupOrigin(registryBaseUrl);
  const hostname = new URL(origin).hostname;
  const path = hostname.endsWith(".convex.site")
    ? `/rendezvous/${encodeURIComponent(serverId)}`
    : `/api/rendezvous/${encodeURIComponent(serverId)}`;
  return new URL(path, origin).toString();
}

function registryBatchUrl(registryBaseUrl: string): string {
  const origin = rendezvousLookupOrigin(registryBaseUrl);
  const hostname = new URL(origin).hostname;
  return new URL(
    hostname.endsWith(".convex.site") ? "/rendezvous/batch" : "/api/rendezvous",
    origin
  ).toString();
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

async function rendezvousError(response: Response, fallback: string): Promise<RendezvousLookupError> {
  const payload = (await response.json().catch(() => ({}))) as { error?: unknown };
  return new RendezvousLookupError(
    typeof payload.error === "string" ? payload.error : `${fallback} (${response.status}).`,
    response.status,
    retryAfterMs(response)
  );
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

export function parseConnectSessionHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const token = new URLSearchParams(raw).get(CONNECT_SESSION_FRAGMENT_KEY)?.trim();
  return token || null;
}

export function attachSessionTokenToConnectUrl(
  connectUrl: string,
  sessionToken: string
): string {
  const token = sessionToken.trim();
  if (!token) {
    throw new Error("Session token is required.");
  }
  const url = new URL(connectUrl);
  const params = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  params.set(CONNECT_SESSION_FRAGMENT_KEY, token);
  url.hash = params.toString();
  return url.toString();
}

export function stripRendezvousBootstrapFromLocation(): void {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  if (!params.has(RENDEZVOUS_FRAGMENT_KEY) && !params.has(CONNECT_SESSION_FRAGMENT_KEY)) {
    return;
  }
  params.delete(RENDEZVOUS_FRAGMENT_KEY);
  params.delete(CONNECT_SESSION_FRAGMENT_KEY);
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
      iv: bytesToArrayBuffer(base64UrlToBytes(ivValue)),
      additionalData: bytesToArrayBuffer(new TextEncoder().encode(locator.serverId)),
    },
    await deriveEncryptionKey(locator.secret),
    bytesToArrayBuffer(base64UrlToBytes(encryptedValue))
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
    registryRecordUrl(locator.registryBaseUrl, locator.serverId),
    {
      method: "GET",
      cache: "no-store",
      headers: { [RENDEZVOUS_PROTOCOL_HEADER]: RENDEZVOUS_PROTOCOL_VERSION },
      signal: options?.signal,
    }
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw await rendezvousError(response, "Rendezvous lookup failed");
  }
  const payload = (await response.json().catch(() => ({}))) as RendezvousRecordResponse;
  return await resolveRendezvousRecord(locator, payload.record ?? null);
}

export async function resolveRendezvousRecord(
  locator: RendezvousLocator,
  record: Partial<EncryptedRendezvousRecord> | null,
  now = Date.now()
): Promise<ResolvedRendezvousEndpoint | null> {
  if (
    !record ||
    record.version !== 1 ||
    record.serverId !== locator.serverId ||
    typeof record.ciphertext !== "string" ||
    typeof record.updatedAt !== "number" ||
    typeof record.expiresAt !== "number" ||
    record.expiresAt <= now
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

/**
 * Resolve every locator using one request per registry, not one request per
 * server. Cesium Cloud locators all share one registry, so a tab performs one
 * lookup regardless of account size.
 */
export async function resolveRendezvousEndpoints(
  locators: RendezvousLocator[],
  options?: { signal?: AbortSignal }
): Promise<Map<string, ResolvedRendezvousEndpoint | null>> {
  const results = new Map<string, ResolvedRendezvousEndpoint | null>();
  const groups = new Map<string, RendezvousLocator[]>();
  for (const locator of locators.slice(0, MAX_BATCH_SIZE)) {
    const origin = rendezvousLookupOrigin(locator.registryBaseUrl);
    const group = groups.get(origin) ?? [];
    if (!group.some((candidate) => candidate.serverId === locator.serverId)) {
      group.push(locator);
    }
    groups.set(origin, group);
  }
  await Promise.all(
    [...groups.entries()].map(async ([origin, group]) => {
      const response = await fetch(registryBatchUrl(origin), {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          [RENDEZVOUS_PROTOCOL_HEADER]: RENDEZVOUS_PROTOCOL_VERSION,
        },
        body: JSON.stringify({ serverIds: group.map((locator) => locator.serverId) }),
        signal: options?.signal,
      });
      if (!response.ok) {
        throw await rendezvousError(response, "Rendezvous batch lookup failed");
      }
      const payload = (await response.json().catch(() => ({}))) as {
        records?: Array<Partial<EncryptedRendezvousRecord> | null>;
      };
      if (!Array.isArray(payload.records) || payload.records.length !== group.length) {
        throw new Error("Rendezvous batch lookup returned an invalid response.");
      }
      await Promise.all(
        group.map(async (locator, index) => {
          results.set(
            locator.serverId,
            await resolveRendezvousRecord(locator, payload.records?.[index] ?? null)
          );
        })
      );
    })
  );
  return results;
}
