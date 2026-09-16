"use client";

import {
  clientKeyValueStore,
  normalizeRendezvousLocator,
  openCredential,
  parseRendezvousBootstrapHash,
  parseServerUrlSearchParam,
  sealCredential,
  type RendezvousLocator,
} from "@cesium/client";

/**
 * Client side of the one-link engine pairing (`/connect/<code>`).
 *
 * The engine mints a code and registers it with the account site; this
 * module redeems it: it asks the engine for its credential, seals that
 * credential for the account, and remembers a pending code across the
 * sign-in round trip.
 */

export const ENGINE_PAIRING_CODE_PATTERN = /^[a-z0-9]{20,64}$/;
export const ENGINE_AUTH_SECRET_KIND_PREFIX = "engine.auth.";
export const PENDING_ENGINE_CONNECT_STORAGE_KEY = "cesium-pending-engine-connect";
const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{24,80}$/;
const PENDING_CODE_TTL_MS = 30 * 60_000;

export type EnginePairingClaim = {
  serverId: string;
  label: string;
  fingerprint: string;
  publicUrl: string;
  rendezvous: RendezvousLocator;
  auth: { username: string; password: string };
};

export type EngineCredential = {
  version: 1;
  serverId: string;
  username: string;
  password: string;
};

export function isEnginePairingCode(value: string): boolean {
  return ENGINE_PAIRING_CODE_PATTERN.test(value.trim().toLowerCase());
}

export function buildEngineConnectUrl(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, "")}/connect/${code}`;
}

export function engineAuthSecretKind(serverId: string): string {
  return `${ENGINE_AUTH_SECRET_KIND_PREFIX}${serverId}`;
}

export function parseEngineAuthSecretKind(kind: string): string | null {
  if (!kind.startsWith(ENGINE_AUTH_SECRET_KIND_PREFIX)) {
    return null;
  }
  const serverId = kind.slice(ENGINE_AUTH_SECRET_KIND_PREFIX.length);
  return SERVER_ID_PATTERN.test(serverId) ? serverId : null;
}

function engineAuthSealPurpose(serverId: string): string {
  return `engine-auth:${serverId}`;
}

/** Seal an engine's credential for the account (client-side, wrapping key). */
export async function sealEngineCredential(input: {
  serverId: string;
  username: string;
  password: string;
}): Promise<string> {
  const credential: EngineCredential = {
    version: 1,
    serverId: input.serverId,
    username: input.username,
    password: input.password,
  };
  return sealCredential(JSON.stringify(credential), engineAuthSealPurpose(input.serverId));
}

/** Open a sealed engine credential; `null` when this device cannot decrypt it. */
export async function openEngineCredential(
  payload: string,
  serverId: string
): Promise<EngineCredential | null> {
  const opened = await openCredential(payload, engineAuthSealPurpose(serverId));
  if (!opened) {
    return null;
  }
  try {
    const parsed = JSON.parse(opened) as Partial<EngineCredential>;
    if (
      parsed.version !== 1 ||
      parsed.serverId !== serverId ||
      typeof parsed.username !== "string" ||
      typeof parsed.password !== "string" ||
      !parsed.username ||
      !parsed.password
    ) {
      return null;
    }
    return {
      version: 1,
      serverId,
      username: parsed.username,
      password: parsed.password,
    };
  } catch {
    return null;
  }
}

/** Sealed engine credential for a rendezvous server id, from the bootstrap secrets. */
export function findEngineCredentialPayload(
  secrets: ReadonlyArray<{ kind: string; payload: string }>,
  serverId: string
): string | null {
  const kind = engineAuthSecretKind(serverId);
  return secrets.find((secret) => secret.kind === kind)?.payload ?? null;
}

function normalizeClaim(value: unknown): EnginePairingClaim {
  if (!value || typeof value !== "object") {
    throw new Error("The engine returned an unexpected pairing response.");
  }
  const input = value as Record<string, unknown>;
  const auth = input.auth as Record<string, unknown> | undefined;
  if (
    typeof input.serverId !== "string" ||
    !SERVER_ID_PATTERN.test(input.serverId) ||
    typeof input.publicUrl !== "string" ||
    typeof input.fingerprint !== "string" ||
    !auth ||
    typeof auth.username !== "string" ||
    typeof auth.password !== "string" ||
    !auth.username ||
    !auth.password
  ) {
    throw new Error("The engine returned an incomplete pairing response.");
  }
  const rendezvous = normalizeRendezvousLocator(
    (input.rendezvous ?? {}) as Partial<RendezvousLocator>
  );
  if (rendezvous.serverId !== input.serverId) {
    throw new Error("The engine's identity did not match its connection details.");
  }
  const publicUrl = new URL(input.publicUrl);
  publicUrl.hash = "";
  publicUrl.search = "";
  return {
    serverId: input.serverId,
    label: typeof input.label === "string" && input.label.trim() ? input.label.trim() : publicUrl.hostname,
    fingerprint: input.fingerprint,
    publicUrl: publicUrl.toString().replace(/\/+$/, ""),
    rendezvous: {
      version: 1,
      serverId: rendezvous.serverId,
      secret: rendezvous.secret,
      registryBaseUrl: rendezvous.registryBaseUrl,
    },
    auth: { username: auth.username, password: auth.password },
  };
}

/**
 * Redeem the connect code with the engine itself. This is the only hop that
 * carries the engine password, browser <-> engine over TLS; the cloud never
 * sees it.
 */
export async function claimEnginePairing(input: {
  publicUrl: string;
  code: string;
  account?: { email?: string | null; name?: string | null };
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<EnginePairingClaim> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint = `${input.publicUrl.replace(/\/+$/, "")}/api/pairing/claim`;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: input.code,
        ...(input.account?.email || input.account?.name
          ? { account: { email: input.account.email ?? null, name: input.account.name ?? null } }
          : {}),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
    });
  } catch (error) {
    const host = (() => {
      try {
        return new URL(input.publicUrl).host;
      } catch {
        return input.publicUrl;
      }
    })();
    throw new Error(
      `Could not reach the engine at ${host}. Its tunnel may be down - check \`cesium-server status\` on that machine.${
        error instanceof Error && error.name !== "TypeError" ? ` (${error.message})` : ""
      }`
    );
  }
  const payload = (await response.json().catch(() => null)) as
    | { error?: unknown }
    | Record<string, unknown>
    | null;
  if (!response.ok) {
    const message =
      payload && typeof (payload as { error?: unknown }).error === "string"
        ? ((payload as { error: string }).error)
        : `The engine rejected the connect code (${response.status}).`;
    throw new Error(message);
  }
  return normalizeClaim(payload);
}

/* ------------------------------------------------------------------------ */
/* Pending code across sign-in                                              */
/* ------------------------------------------------------------------------ */

export function setPendingEngineConnect(code: string | null): void {
  const store = clientKeyValueStore();
  if (code && isEnginePairingCode(code)) {
    store.setItem(
      PENDING_ENGINE_CONNECT_STORAGE_KEY,
      JSON.stringify({ code: code.trim().toLowerCase(), savedAt: Date.now() })
    );
  } else {
    store.removeItem(PENDING_ENGINE_CONNECT_STORAGE_KEY);
  }
}

export function getPendingEngineConnect(now = Date.now()): string | null {
  const raw = clientKeyValueStore().getItem(PENDING_ENGINE_CONNECT_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { code?: unknown; savedAt?: unknown };
    if (
      typeof parsed.code !== "string" ||
      !isEnginePairingCode(parsed.code) ||
      typeof parsed.savedAt !== "number" ||
      now - parsed.savedAt > PENDING_CODE_TTL_MS
    ) {
      clientKeyValueStore().removeItem(PENDING_ENGINE_CONNECT_STORAGE_KEY);
      return null;
    }
    return parsed.code;
  } catch {
    clientKeyValueStore().removeItem(PENDING_ENGINE_CONNECT_STORAGE_KEY);
    return null;
  }
}

/* ------------------------------------------------------------------------ */
/* Pasted-input interpretation                                              */
/* ------------------------------------------------------------------------ */

export type EngineConnectInput =
  | { kind: "engine-url"; baseUrl: string; rendezvous?: RendezvousLocator; label?: string }
  | { kind: "pairing-link"; code: string; url: string }
  | { kind: "invalid"; message: string };

/**
 * Interpret whatever the user pasted into "Connect a device": a bare engine
 * URL, the legacy connect link (`.../agent?serverUrl=...` or
 * `.../agent#cesiumConnect=...`), or a one-link pairing URL (`/connect/<code>`).
 */
export function parseEngineConnectInput(raw: string): EngineConnectInput {
  const value = raw.trim();
  if (!value) {
    return { kind: "invalid", message: "Paste the engine URL or the connect link." };
  }
  if (isEnginePairingCode(value)) {
    return { kind: "pairing-link", code: value.toLowerCase(), url: "" };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "invalid", message: "Server URL must be an absolute http(s) URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "invalid", message: "Server URL must use http or https." };
  }
  const pairing = url.pathname.match(/^\/connect\/([a-z0-9]{20,64})\/?$/i);
  if (pairing) {
    return { kind: "pairing-link", code: pairing[1]!.toLowerCase(), url: url.toString() };
  }
  const fromSearch = parseServerUrlSearchParam(url.search);
  if (fromSearch) {
    return { kind: "engine-url", baseUrl: fromSearch };
  }
  const bootstrap = parseRendezvousBootstrapHash(url.hash);
  if (bootstrap) {
    if (!bootstrap.initialBaseUrl) {
      return {
        kind: "invalid",
        message: "That connect link has no engine address; open it in the browser instead.",
      };
    }
    return {
      kind: "engine-url",
      baseUrl: bootstrap.initialBaseUrl,
      rendezvous: {
        version: 1,
        serverId: bootstrap.serverId,
        secret: bootstrap.secret,
        registryBaseUrl: bootstrap.registryBaseUrl,
      },
      ...(bootstrap.label ? { label: bootstrap.label } : {}),
    };
  }
  url.hash = "";
  url.username = "";
  url.password = "";
  return { kind: "engine-url", baseUrl: url.toString().replace(/\/+$/, "") };
}
