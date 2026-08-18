import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR, readJsonFile, writeJsonFile } from "./persistence.js";

/**
 * SpaceXAI / xAI SuperGrok subscription OAuth.
 *
 * Public Grok-CLI client (no secret). Device-code grant is the path xAI
 * documented for third-party harnesses: OpenCode, OpenClaw, Warp, LiteLLM,
 * and others reuse this exact client_id. See https://x.ai/news/grok-opencode
 */
export const XAI_OAUTH_PROVIDER_ID = "xai";
export const XAI_OAUTH_BASE_URL = "https://api.x.ai/v1";

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const DEVICE_AUTHORIZATION_URL = "https://auth.x.ai/oauth2/device/code";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const REFERRER = "cesium";
const USER_AGENT = "cesium/0.1.0";

const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_CODE_MIN_INTERVAL_MS = 1_000;
const DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000;
const DEVICE_CODE_DEFAULT_EXPIRES_MS = 5 * 60 * 1000;
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000;

const CREDENTIALS_FILE = path.join(DATA_DIR, "profile", "xai-oauth.json");

export type XaiOAuthCredentials = {
  schemaVersion: 1;
  access: string;
  refresh: string;
  expires: number;
  updatedAt: number;
};

export type XaiDeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
};

export type XaiTokenResponse = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
};

type DeviceTokenErrorBody = {
  error?: string;
  error_description?: string;
};

export type XaiOAuthHttp = {
  fetch: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const defaultHttp: XaiOAuthHttp = {
  fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveSecondsToMs(value: unknown, defaultMs: number): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : defaultMs;
}

export function accessTokenIsExpiring(
  token: string | undefined,
  skewMs = ACCESS_TOKEN_REFRESH_SKEW_MS,
  now = Date.now()
): boolean {
  if (!token) {
    return false;
  }
  const parts = token.split(".");
  if (parts.length < 2) {
    return false;
  }
  try {
    let payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4 !== 0) {
      payload += "=";
    }
    const claims = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as {
      exp?: unknown;
    };
    if (typeof claims.exp !== "number") {
      return false;
    }
    return claims.exp * 1000 <= now + Math.max(0, skewMs);
  } catch {
    return false;
  }
}

export function credentialsNeedRefresh(
  credentials: XaiOAuthCredentials,
  now = Date.now()
): boolean {
  return (
    credentials.expires - now <= ACCESS_TOKEN_REFRESH_SKEW_MS ||
    accessTokenIsExpiring(credentials.access, ACCESS_TOKEN_REFRESH_SKEW_MS, now)
  );
}

function normalizeCredentials(raw: unknown): XaiOAuthCredentials | null {
  const record = asRecord(raw);
  const access = asString(record?.access);
  const refresh = asString(record?.refresh);
  const expires = asNumber(record?.expires);
  if (!access || !refresh || expires == null) {
    return null;
  }
  return {
    schemaVersion: 1,
    access,
    refresh,
    expires,
    updatedAt: asNumber(record?.updatedAt) ?? Date.now(),
  };
}

export async function readXaiOAuthCredentials(): Promise<XaiOAuthCredentials | null> {
  return normalizeCredentials(await readJsonFile<unknown>(CREDENTIALS_FILE, null));
}

export async function writeXaiOAuthCredentials(input: {
  access: string;
  refresh: string;
  expires: number;
}): Promise<XaiOAuthCredentials> {
  const credentials: XaiOAuthCredentials = {
    schemaVersion: 1,
    access: input.access,
    refresh: input.refresh,
    expires: input.expires,
    updatedAt: Date.now(),
  };
  await writeJsonFile(CREDENTIALS_FILE, credentials);
  return credentials;
}

export async function clearXaiOAuthCredentials(): Promise<void> {
  await fs.unlink(CREDENTIALS_FILE).catch(() => undefined);
}

export async function requestXaiDeviceCode(
  http: XaiOAuthHttp = defaultHttp
): Promise<XaiDeviceCodeResponse> {
  const response = await http.fetch(DEVICE_AUTHORIZATION_URL, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      scope: SCOPE,
      referrer: REFERRER,
    }).toString(),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `SpaceXAI device code request failed (${response.status})${detail ? `: ${detail}` : ""}`
    );
  }
  const json = (await response.json()) as XaiDeviceCodeResponse;
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error("SpaceXAI device code response is missing required fields.");
  }
  return json;
}

export async function pollXaiDeviceCodeToken(
  device: XaiDeviceCodeResponse,
  http: XaiOAuthHttp = defaultHttp
): Promise<XaiTokenResponse> {
  const sleep = http.sleep ?? defaultHttp.sleep!;
  const now = http.now ?? defaultHttp.now!;
  const expiresInMs = positiveSecondsToMs(device.expires_in, DEVICE_CODE_DEFAULT_EXPIRES_MS);
  const deadline = now() + expiresInMs;
  let intervalMs = Math.max(
    positiveSecondsToMs(device.interval, DEVICE_CODE_DEFAULT_INTERVAL_MS),
    DEVICE_CODE_MIN_INTERVAL_MS
  );

  while (now() < deadline) {
    const response = await http.fetch(TOKEN_URL, {
      method: "POST",
      headers: authHeaders(),
      body: new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        client_id: CLIENT_ID,
        device_code: device.device_code,
      }).toString(),
    });
    if (response.ok) {
      return (await response.json()) as XaiTokenResponse;
    }
    const body = (await response.json().catch(() => ({}))) as DeviceTokenErrorBody;
    const remaining = Math.max(0, deadline - now());
    if (body.error === "authorization_pending") {
      await sleep(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining));
      continue;
    }
    if (body.error === "slow_down") {
      intervalMs += DEVICE_CODE_SLOW_DOWN_INCREMENT_MS;
      await sleep(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining));
      continue;
    }
    if (body.error === "access_denied" || body.error === "authorization_denied") {
      throw new Error("SpaceXAI device authorization was denied.");
    }
    if (body.error === "expired_token") {
      throw new Error("SpaceXAI device code expired. Start sign-in again.");
    }
    const detail = body.error_description ?? body.error ?? "";
    throw new Error(
      `SpaceXAI device token exchange failed (${response.status})${detail ? `: ${detail}` : ""}`
    );
  }
  throw new Error("SpaceXAI device authorization timed out.");
}

export async function refreshXaiAccessToken(
  refreshToken: string,
  http: XaiOAuthHttp = defaultHttp
): Promise<XaiTokenResponse> {
  const response = await http.fetch(TOKEN_URL, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `SpaceXAI token refresh failed (${response.status})${detail ? `: ${detail}` : ""}`
    );
  }
  return (await response.json()) as XaiTokenResponse;
}

export function credentialsFromTokenResponse(
  tokens: XaiTokenResponse,
  previousRefresh?: string,
  now = Date.now()
): { access: string; refresh: string; expires: number } {
  const refresh = tokens.refresh_token || previousRefresh;
  if (!tokens.access_token || !refresh) {
    throw new Error("SpaceXAI token response is missing access or refresh token.");
  }
  return {
    access: tokens.access_token,
    refresh,
    expires: now + (tokens.expires_in ?? 3600) * 1000,
  };
}

export async function persistXaiTokenResponse(
  tokens: XaiTokenResponse,
  previousRefresh?: string
): Promise<XaiOAuthCredentials> {
  return writeXaiOAuthCredentials(credentialsFromTokenResponse(tokens, previousRefresh));
}

export async function getValidXaiAccessToken(
  http: XaiOAuthHttp = defaultHttp
): Promise<string | null> {
  const stored = await readXaiOAuthCredentials();
  if (!stored) {
    return null;
  }
  if (!credentialsNeedRefresh(stored, http.now?.() ?? Date.now())) {
    return stored.access;
  }
  const tokens = await refreshXaiAccessToken(stored.refresh, http);
  const next = await persistXaiTokenResponse(tokens, stored.refresh);
  return next.access;
}

export async function hasXaiOAuthCredentials(): Promise<boolean> {
  return (await readXaiOAuthCredentials()) != null;
}
