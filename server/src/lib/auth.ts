import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Context } from "hono";
import type { MiddlewareHandler } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import {
  consume as consumeRateLimitAsync,
  peek as peekRateLimitAsync,
  resetBucket as resetRateLimitBucket,
} from "../cache/rate-limit.js";
import { del as cacheDel, getJSON as cacheGetJSON, setJSON as cacheSetJSON } from "../cache/kv.js";
import { getStorage } from "../storage/runtime.js";

export const SESSION_COOKIE_NAME = "opencursor_session";
export const SESSION_TOKEN_HEADER = "x-opencursor-session-token";
export const ACCESS_TOKEN_QUERY_PARAM = "access_token";
/**
 * Iframe navigation auth param. Distinct from `access_token` so the browser
 * proxy can strip it before forwarding upstream without clobbering a legitimate
 * `?access_token=` that may appear in the target URL (OAuth callbacks, etc.).
 */
export const IFRAME_ACCESS_TOKEN_QUERY_PARAM = "__ocs_access";

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_REMEMBER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_ROTATION_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_AUTH_STATUS_LIMIT = 60;
const DEFAULT_AUTH_STATUS_WINDOW_MS = 60 * 1000;
/** Failed login attempts per window (successful login clears the bucket). */
const DEFAULT_LOGIN_LIMIT = 15;
const DEFAULT_LOGIN_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_API_READ_LIMIT = 240;
const DEFAULT_API_READ_WINDOW_MS = 60 * 1000;
const DEFAULT_API_WRITE_LIMIT = 180;
const DEFAULT_API_WRITE_WINDOW_MS = 60 * 1000;
const DEFAULT_BROWSER_PROXY_LIMIT = 360;
const DEFAULT_BROWSER_PROXY_WINDOW_MS = 60 * 1000;
const DEFAULT_FS_WRITE_LIMIT = 40;
const DEFAULT_FS_WRITE_WINDOW_MS = 60 * 1000;
const DEFAULT_AGENT_WRITE_LIMIT = 240;
const DEFAULT_AGENT_WRITE_WINDOW_MS = 60 * 1000;
const DEFAULT_WS_FS_LIMIT = 60;
const DEFAULT_WS_FS_WINDOW_MS = 60 * 1000;
const DEFAULT_WS_AGENT_LIMIT = 60;
const DEFAULT_WS_AGENT_WINDOW_MS = 60 * 1000;
const DEFAULT_WS_TERMINAL_LIMIT = 30;
const DEFAULT_WS_TERMINAL_WINDOW_MS = 60 * 1000;
const DEFAULT_WS_BROWSER_DEBUG_LIMIT = 30;
const DEFAULT_WS_BROWSER_DEBUG_WINDOW_MS = 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 30 * 1000;

type RateLimitKind =
  | "auth-status"
  | "login"
  | "api-read"
  | "api-write"
  | "browser-proxy"
  | "fs-write"
  | "agent-write"
  | "ws-fs"
  | "ws-agent"
  | "ws-terminal"
  | "ws-browser-debug";

type RateLimitPolicy = {
  limit: number;
  windowMs: number;
};

type AuthConfig = {
  enabled: boolean;
  username: string | null;
  password: string | null;
  sessionTtlMs: number;
  rememberSessionTtlMs: number;
  rotationIntervalMs: number;
  rateLimits: Record<RateLimitKind, RateLimitPolicy>;
};

type PersistedAuthState = {
  schemaVersion: 1;
  createdAt: number;
  secret: string;
};

export type AuthSessionRecord = {
  id: string;
  username: string;
  createdAt: number;
  lastSeenAt: number;
  lastRotatedAt: number;
  expiresAt: number;
  remember: boolean;
};

type PersistedAuthSessions = {
  schemaVersion: 1;
  sessions: AuthSessionRecord[];
};

type SessionTokenPayload = {
  sid: string;
  username: string;
  iat: number;
  exp: number;
  remember: boolean;
};

export type PublicAuthSession = {
  username: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  remember: boolean;
};

type AuthenticatedRequest = {
  session: AuthSessionRecord;
  token: string;
  rotatedToken: string | null;
  source: "authorization" | "header" | "cookie" | "query";
};

type AuthenticationResult =
  | { status: "disabled" }
  | { status: "missing" }
  | { status: "invalid"; clearCookie: boolean }
  | ({ status: "authenticated" } & AuthenticatedRequest);

type TokenExtractionResult = {
  token: string | null;
  source: "authorization" | "header" | "cookie" | "query" | null;
};

export type RateLimitResult = {
  ok: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSec: number;
};

type UpgradeAuthResult =
  | { ok: true }
  | { ok: false; status: number; message: string; retryAfterSec?: number };

type RequestLike = Request | IncomingMessage;

let authStatePromise: Promise<PersistedAuthState> | null = null;
let sessionStoreQueue: Promise<void> = Promise.resolve();

const AUTH_SESSION_CACHE_PREFIX = "auth:sess:";
/**
 * We cap the session hot-cache TTL at 60s so revocations, rotations, and
 * remember-me changes propagate within a minute even under Redis. The real
 * source of truth is still the active `StorageDriver` (Postgres or legacy JSON).
 */
const AUTH_SESSION_CACHE_TTL_SEC = 60;

function sessionCacheKey(sessionId: string): string {
  return `${AUTH_SESSION_CACHE_PREFIX}${sessionId}`;
}

async function cacheAuthSession(session: AuthSessionRecord): Promise<void> {
  await cacheSetJSON(sessionCacheKey(session.id), session, AUTH_SESSION_CACHE_TTL_SEC);
}

async function invalidateAuthSession(sessionId: string): Promise<void> {
  await cacheDel(sessionCacheKey(sessionId));
}

async function readCachedAuthSession(sessionId: string): Promise<AuthSessionRecord | null> {
  const cached = await cacheGetJSON<AuthSessionRecord>(sessionCacheKey(sessionId));
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    await invalidateAuthSession(sessionId);
    return null;
  }
  return cached;
}

function readEnvValue(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function parseDurationEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getAuthConfig(): AuthConfig {
  const username = readEnvValue("OPENCURSOR_AUTH_USERNAME");
  const password = readEnvValue("OPENCURSOR_AUTH_PASSWORD");
  return {
    enabled: Boolean(username && password),
    username,
    password,
    sessionTtlMs: parseDurationEnv(
      "OPENCURSOR_AUTH_SESSION_TTL_MS",
      DEFAULT_SESSION_TTL_MS
    ),
    rememberSessionTtlMs: parseDurationEnv(
      "OPENCURSOR_AUTH_REMEMBER_SESSION_TTL_MS",
      DEFAULT_REMEMBER_SESSION_TTL_MS
    ),
    rotationIntervalMs: parseDurationEnv(
      "OPENCURSOR_AUTH_ROTATION_INTERVAL_MS",
      DEFAULT_ROTATION_INTERVAL_MS
    ),
    rateLimits: {
      "auth-status": {
        limit: parseDurationEnv(
          "OPENCURSOR_AUTH_STATUS_RATE_LIMIT",
          DEFAULT_AUTH_STATUS_LIMIT
        ),
        windowMs: parseDurationEnv(
          "OPENCURSOR_AUTH_STATUS_RATE_LIMIT_WINDOW_MS",
          DEFAULT_AUTH_STATUS_WINDOW_MS
        ),
      },
      login: {
        limit: parseDurationEnv("OPENCURSOR_LOGIN_RATE_LIMIT", DEFAULT_LOGIN_LIMIT),
        windowMs: parseDurationEnv(
          "OPENCURSOR_LOGIN_RATE_LIMIT_WINDOW_MS",
          DEFAULT_LOGIN_WINDOW_MS
        ),
      },
      "api-read": {
        limit: parseDurationEnv("OPENCURSOR_API_READ_RATE_LIMIT", DEFAULT_API_READ_LIMIT),
        windowMs: parseDurationEnv(
          "OPENCURSOR_API_READ_RATE_LIMIT_WINDOW_MS",
          DEFAULT_API_READ_WINDOW_MS
        ),
      },
      "api-write": {
        limit: parseDurationEnv("OPENCURSOR_API_WRITE_RATE_LIMIT", DEFAULT_API_WRITE_LIMIT),
        windowMs: parseDurationEnv(
          "OPENCURSOR_API_WRITE_RATE_LIMIT_WINDOW_MS",
          DEFAULT_API_WRITE_WINDOW_MS
        ),
      },
      "browser-proxy": {
        limit: parseDurationEnv(
          "OPENCURSOR_BROWSER_PROXY_RATE_LIMIT",
          DEFAULT_BROWSER_PROXY_LIMIT
        ),
        windowMs: parseDurationEnv(
          "OPENCURSOR_BROWSER_PROXY_RATE_LIMIT_WINDOW_MS",
          DEFAULT_BROWSER_PROXY_WINDOW_MS
        ),
      },
      "fs-write": {
        limit: parseDurationEnv("OPENCURSOR_FS_WRITE_RATE_LIMIT", DEFAULT_FS_WRITE_LIMIT),
        windowMs: parseDurationEnv(
          "OPENCURSOR_FS_WRITE_RATE_LIMIT_WINDOW_MS",
          DEFAULT_FS_WRITE_WINDOW_MS
        ),
      },
      "agent-write": {
        limit: parseDurationEnv(
          "OPENCURSOR_AGENT_WRITE_RATE_LIMIT",
          DEFAULT_AGENT_WRITE_LIMIT
        ),
        windowMs: parseDurationEnv(
          "OPENCURSOR_AGENT_WRITE_RATE_LIMIT_WINDOW_MS",
          DEFAULT_AGENT_WRITE_WINDOW_MS
        ),
      },
      "ws-fs": {
        limit: parseDurationEnv("OPENCURSOR_WS_FS_RATE_LIMIT", DEFAULT_WS_FS_LIMIT),
        windowMs: parseDurationEnv(
          "OPENCURSOR_WS_FS_RATE_LIMIT_WINDOW_MS",
          DEFAULT_WS_FS_WINDOW_MS
        ),
      },
      "ws-agent": {
        limit: parseDurationEnv("OPENCURSOR_WS_AGENT_RATE_LIMIT", DEFAULT_WS_AGENT_LIMIT),
        windowMs: parseDurationEnv(
          "OPENCURSOR_WS_AGENT_RATE_LIMIT_WINDOW_MS",
          DEFAULT_WS_AGENT_WINDOW_MS
        ),
      },
      "ws-terminal": {
        limit: parseDurationEnv(
          "OPENCURSOR_WS_TERMINAL_RATE_LIMIT",
          DEFAULT_WS_TERMINAL_LIMIT
        ),
        windowMs: parseDurationEnv(
          "OPENCURSOR_WS_TERMINAL_RATE_LIMIT_WINDOW_MS",
          DEFAULT_WS_TERMINAL_WINDOW_MS
        ),
      },
      "ws-browser-debug": {
        limit: parseDurationEnv(
          "OPENCURSOR_WS_BROWSER_DEBUG_RATE_LIMIT",
          DEFAULT_WS_BROWSER_DEBUG_LIMIT
        ),
        windowMs: parseDurationEnv(
          "OPENCURSOR_WS_BROWSER_DEBUG_RATE_LIMIT_WINDOW_MS",
          DEFAULT_WS_BROWSER_DEBUG_WINDOW_MS
        ),
      },
    },
  };
}

export function isAuthEnabled(): boolean {
  return getAuthConfig().enabled;
}

function getHeaderValue(request: RequestLike, name: string): string | null {
  if (request instanceof Request) {
    return request.headers.get(name);
  }
  const raw = request.headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0] ?? null;
  }
  return typeof raw === "string" ? raw : null;
}

function parseCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }
  const entries = cookieHeader.split(";");
  for (const entry of entries) {
    const [rawName, ...rawValue] = entry.trim().split("=");
    if (!rawName || rawValue.length === 0) {
      continue;
    }
    if (rawName !== name) {
      continue;
    }
    try {
      return decodeURIComponent(rawValue.join("="));
    } catch {
      return rawValue.join("=");
    }
  }
  return null;
}

function extractTokenFromRequest(
  request: RequestLike,
  options?: { allowQuery?: boolean }
): TokenExtractionResult {
  const sessionHeader = getHeaderValue(request, SESSION_TOKEN_HEADER);
  if (sessionHeader?.trim()) {
    return { token: sessionHeader.trim(), source: "header" };
  }

  const authorization = getHeaderValue(request, "authorization");
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    if (token) {
      return { token, source: "authorization" };
    }
  }

  const cookieToken = parseCookieValue(
    getHeaderValue(request, "cookie"),
    SESSION_COOKIE_NAME
  );
  if (cookieToken) {
    return { token: cookieToken, source: "cookie" };
  }

  if (options?.allowQuery !== false) {
    try {
      const requestUrl =
        request instanceof Request
          ? request.url
          : new URL(
              request.url ?? "/",
              `http://${getHeaderValue(request, "host") ?? "localhost"}`
            ).toString();
      const url = new URL(requestUrl);
      // Prefer the iframe-specific param so we pick up the IDE's auth token
      // even when the target page carries its own `?access_token=…` in the URL.
      const iframeToken =
        url.searchParams.get(IFRAME_ACCESS_TOKEN_QUERY_PARAM)?.trim() ?? "";
      if (iframeToken) {
        return { token: iframeToken, source: "query" };
      }
      const token = url.searchParams.get(ACCESS_TOKEN_QUERY_PARAM)?.trim() ?? "";
      if (token) {
        return { token, source: "query" };
      }
    } catch {
      // Ignore malformed request URLs.
    }
  }

  return { token: null, source: null };
}

function extractClientIp(request: RequestLike): string {
  const forwardedFor = getHeaderValue(request, "x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor
      .split(",")
      .map((value) => value.trim())
      .find(Boolean);
    if (first) {
      return first;
    }
  }

  const realIp = getHeaderValue(request, "x-real-ip");
  if (realIp) {
    return realIp;
  }

  if (!(request instanceof Request)) {
    return request.socket.remoteAddress ?? "unknown";
  }

  return "unknown";
}

function isSecureRequest(request: RequestLike): boolean {
  const forwardedProto = getHeaderValue(request, "x-forwarded-proto");
  if (forwardedProto) {
    return forwardedProto.split(",")[0]?.trim().toLowerCase() === "https";
  }

  try {
    const requestUrl =
      request instanceof Request
        ? request.url
        : new URL(
            request.url ?? "/",
            `http://${getHeaderValue(request, "host") ?? "localhost"}`
          ).toString();
    return new URL(requestUrl).protocol === "https:";
  } catch {
    return false;
  }
}

function createCookieOptions(
  request: RequestLike,
  remember: boolean,
  maxAgeSeconds?: number
): CookieOptions {
  const secure = isSecureRequest(request);
  return {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure,
    maxAge: remember ? maxAgeSeconds : undefined,
  };
}

function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function secureStringEquals(a: string, b: string): boolean {
  return timingSafeEqual(hashSecret(a), hashSecret(b));
}

async function consumeRateLimit(
  kind: RateLimitKind,
  key: string,
  config = getAuthConfig()
): Promise<RateLimitResult> {
  const policy = config.rateLimits[kind];
  const result = await consumeRateLimitAsync(`${kind}:${key}`, {
    max: policy.limit,
    windowMs: policy.windowMs,
  });
  return {
    ok: result.ok,
    limit: result.limit,
    remaining: result.remaining,
    resetAt: result.resetAt,
    retryAfterSec: Math.max(1, result.retryAfterSec),
  };
}

async function peekRateLimit(
  kind: RateLimitKind,
  key: string,
  config = getAuthConfig()
): Promise<RateLimitResult> {
  const policy = config.rateLimits[kind];
  const result = await peekRateLimitAsync(`${kind}:${key}`, {
    max: policy.limit,
    windowMs: policy.windowMs,
  });
  return {
    ok: result.ok,
    limit: result.limit,
    remaining: result.remaining,
    resetAt: result.resetAt,
    retryAfterSec: Math.max(1, result.retryAfterSec),
  };
}

async function resetRateLimitBucketForKind(kind: RateLimitKind, key: string): Promise<void> {
  await resetRateLimitBucket(`${kind}:${key}`);
}

/** True if another login attempt is allowed (failed-attempt budget not exhausted). */
export async function gateLoginRateLimit(request: RequestLike): Promise<RateLimitResult> {
  return peekRateLimit("login", rateLimitKeyForRequest(request));
}

/** Record one failed credential check against the login bucket. */
export async function recordFailedLoginRateLimit(request: RequestLike): Promise<RateLimitResult> {
  return consumeRateLimit("login", rateLimitKeyForRequest(request));
}

/** Clear failed-login counter after a successful sign-in. */
export async function clearLoginRateLimitAfterSuccess(request: RequestLike): Promise<void> {
  await resetRateLimitBucketForKind("login", rateLimitKeyForRequest(request));
}

export function applyRateLimitHeaders(headers: Headers, result: RateLimitResult): void {
  headers.set("x-ratelimit-limit", String(result.limit));
  headers.set("x-ratelimit-remaining", String(result.remaining));
  headers.set("x-ratelimit-reset", String(result.resetAt));
  if (!result.ok) {
    headers.set("retry-after", String(result.retryAfterSec));
  }
}

function rateLimitKeyForRequest(request: RequestLike): string {
  return extractClientIp(request);
}

function classifyProtectedHttpRateLimit(pathname: string, method: string): RateLimitKind {
  if (pathname.startsWith("/browser/")) {
    return "browser-proxy";
  }
  // The Chromium DevTools frontend pulls hundreds of JS / CSS / image assets
  // on first paint; classify all of `/browser-debug/…` under the browser-proxy
  // bucket (same semantics: a single user session exploring web content).
  if (pathname.startsWith("/browser-debug/")) {
    return "browser-proxy";
  }
  if (pathname.startsWith("/api/fs/") && method !== "GET" && method !== "HEAD") {
    return "fs-write";
  }
  if (pathname.startsWith("/api/agents/") && method !== "GET" && method !== "HEAD") {
    return "agent-write";
  }
  return method === "GET" || method === "HEAD" ? "api-read" : "api-write";
}

async function getAuthState(): Promise<PersistedAuthState> {
  if (!authStatePromise) {
    authStatePromise = (async (): Promise<PersistedAuthState> => {
      const storage = await getStorage();
      const row = await storage.getAuthState();
      if (
        row &&
        row.schemaVersion === 1 &&
        typeof row.secret === "string" &&
        row.secret.length > 0
      ) {
        return {
          schemaVersion: 1,
          createdAt: row.createdAt,
          secret: row.secret,
        };
      }

      const now = Date.now();
      const created: PersistedAuthState = {
        schemaVersion: 1,
        createdAt: now,
        secret: randomBytes(32).toString("base64url"),
      };
      await storage.saveAuthState({
        schemaVersion: 1,
        secret: created.secret,
        createdAt: created.createdAt,
        updatedAt: now,
      });
      return created;
    })().catch((error): Promise<never> => {
      authStatePromise = null;
      throw error;
    });
  }
  return authStatePromise;
}

export async function rotateAuthSecurityState(): Promise<void> {
  const storage = await getStorage();
  const now = Date.now();
  const next: PersistedAuthState = {
    schemaVersion: 1,
    createdAt: now,
    secret: randomBytes(32).toString("base64url"),
  };
  await storage.saveAuthState({
    schemaVersion: 1,
    secret: next.secret,
    createdAt: next.createdAt,
    updatedAt: now,
  });
  await storage.saveAuthSessions([]);
  authStatePromise = Promise.resolve(next);
}

async function loadSessionStore(): Promise<PersistedAuthSessions> {
  const sessions = await (await getStorage()).listAuthSessions();
  const now = Date.now();
  return {
    schemaVersion: 1,
    sessions: sessions.filter(
      (session) =>
        session &&
        typeof session.id === "string" &&
        typeof session.username === "string" &&
        typeof session.expiresAt === "number" &&
        session.expiresAt > now
    ),
  };
}

async function saveSessionStore(store: PersistedAuthSessions): Promise<void> {
  await (await getStorage()).saveAuthSessions(store.sessions);
}

async function withSessionStoreLock<T>(run: () => Promise<T>): Promise<T> {
  const previous = sessionStoreQueue;
  let release: (() => void) | undefined;
  sessionStoreQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release?.();
  }
}

function serializeToken(payload: SessionTokenPayload, secret: string): string {
  const key = hashSecret(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    authTag.toString("base64url"),
  ].join(".");
}

function deserializeToken(token: string, secret: string): SessionTokenPayload | null {
  const [version, ivPart, ciphertextPart, authTagPart] = token.split(".");
  if (version !== "v1" || !ivPart || !ciphertextPart || !authTagPart) {
    return null;
  }

  try {
    const key = hashSecret(secret);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivPart, "base64url")
    );
    decipher.setAuthTag(Buffer.from(authTagPart, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as Partial<SessionTokenPayload> | null;
    if (
      !parsed ||
      typeof parsed.sid !== "string" ||
      typeof parsed.username !== "string" ||
      typeof parsed.iat !== "number" ||
      typeof parsed.exp !== "number" ||
      typeof parsed.remember !== "boolean"
    ) {
      return null;
    }
    return {
      sid: parsed.sid,
      username: parsed.username,
      iat: parsed.iat,
      exp: parsed.exp,
      remember: parsed.remember,
    };
  } catch {
    return null;
  }
}

function issueSessionToken(session: AuthSessionRecord, secret: string): string {
  const ttlMs = Math.max(1, session.expiresAt - Date.now());
  const issuedAt = Date.now();
  return serializeToken(
    {
      sid: session.id,
      username: session.username,
      iat: issuedAt,
      exp: issuedAt + ttlMs,
      remember: session.remember,
    },
    secret
  );
}

function shouldRotateSession(
  session: AuthSessionRecord,
  payload: SessionTokenPayload,
  config: AuthConfig
): boolean {
  const now = Date.now();
  return (
    now - session.lastRotatedAt >= config.rotationIntervalMs ||
    payload.exp - now <= config.rotationIntervalMs
  );
}

function shouldTouchSession(session: AuthSessionRecord): boolean {
  return Date.now() - session.lastSeenAt >= SESSION_TOUCH_INTERVAL_MS;
}

async function writeSessionUpdate(
  sessionId: string,
  updater: (current: AuthSessionRecord) => AuthSessionRecord | null
): Promise<AuthSessionRecord | null> {
  const result = await withSessionStoreLock(async () => {
    const store = await loadSessionStore();
    const index = store.sessions.findIndex((session) => session.id === sessionId);
    if (index === -1) {
      return null;
    }
    const current = store.sessions[index]!;
    const next = updater(current);
    if (!next) {
      store.sessions.splice(index, 1);
      await saveSessionStore(store);
      return null;
    }
    store.sessions[index] = next;
    await saveSessionStore(store);
    return next;
  });
  if (result) {
    await cacheAuthSession(result);
  } else {
    await invalidateAuthSession(sessionId);
  }
  return result;
}

async function createSessionRecord(input: {
  username: string;
  remember: boolean;
}): Promise<AuthSessionRecord> {
  const config = getAuthConfig();
  const now = Date.now();
  const session: AuthSessionRecord = {
    id: randomBytes(18).toString("base64url"),
    username: input.username,
    createdAt: now,
    lastSeenAt: now,
    lastRotatedAt: now,
    expiresAt:
      now + (input.remember ? config.rememberSessionTtlMs : config.sessionTtlMs),
    remember: input.remember,
  };
  await withSessionStoreLock(async () => {
    const store = await loadSessionStore();
    store.sessions.push(session);
    await saveSessionStore(store);
  });
  await cacheAuthSession(session);
  return session;
}

async function revokeSessionRecord(sessionId: string): Promise<void> {
  await withSessionStoreLock(async () => {
    const store = await loadSessionStore();
    store.sessions = store.sessions.filter((session) => session.id !== sessionId);
    await saveSessionStore(store);
  });
  await invalidateAuthSession(sessionId);
}

function toPublicSession(session: AuthSessionRecord): PublicAuthSession {
  return {
    username: session.username,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt,
    remember: session.remember,
  };
}

export async function authenticateRequest(
  request: RequestLike,
  options?: { allowQuery?: boolean; rotate?: boolean }
): Promise<AuthenticationResult> {
  const config = getAuthConfig();
  if (!config.enabled) {
    return { status: "disabled" };
  }

  const extracted = extractTokenFromRequest(request, {
    allowQuery: options?.allowQuery,
  });
  if (!extracted.token || !extracted.source) {
    return { status: "missing" };
  }

  const authState = await getAuthState();
  const payload = deserializeToken(extracted.token, authState.secret);
  if (!payload) {
    return { status: "invalid", clearCookie: extracted.source === "cookie" };
  }

  const now = Date.now();
  if (payload.exp <= now) {
    await revokeSessionRecord(payload.sid).catch(() => undefined);
    return { status: "invalid", clearCookie: true };
  }

  // Hot-cache read: avoid re-parsing the full sessions JSON on every request.
  // TTL is capped so revocation elsewhere propagates within a minute; direct
  // write paths invalidate the cache immediately to keep the common case exact.
  let session = await readCachedAuthSession(payload.sid);
  if (!session) {
    const store = await loadSessionStore();
    session = store.sessions.find((entry) => entry.id === payload.sid) ?? null;
    if (session) {
      await cacheAuthSession(session);
    }
  }
  if (
    !session ||
    session.username !== payload.username ||
    session.expiresAt <= now
  ) {
    if (session?.expiresAt && session.expiresAt <= now) {
      await revokeSessionRecord(payload.sid).catch(() => undefined);
    }
    return { status: "invalid", clearCookie: true };
  }

  let nextSession = session;
  let rotatedToken: string | null = null;

  if (options?.rotate !== false && shouldRotateSession(session, payload, config)) {
    const updated = await writeSessionUpdate(session.id, (current) => ({
      ...current,
      lastSeenAt: now,
      lastRotatedAt: now,
      expiresAt:
        now +
        (current.remember ? config.rememberSessionTtlMs : config.sessionTtlMs),
    }));
    if (!updated) {
      return { status: "invalid", clearCookie: true };
    }
    nextSession = updated;
    rotatedToken = issueSessionToken(updated, authState.secret);
  } else if (shouldTouchSession(session)) {
    const updated = await writeSessionUpdate(session.id, (current) => ({
      ...current,
      lastSeenAt: now,
    }));
    if (updated) {
      nextSession = updated;
    }
  }

  return {
    status: "authenticated",
    session: nextSession,
    token: rotatedToken ?? extracted.token,
    rotatedToken,
    source: extracted.source,
  };
}

export async function loginWithCredentials(input: {
  username: string;
  password: string;
  remember: boolean;
}): Promise<{ ok: true; token: string; session: AuthSessionRecord } | { ok: false }> {
  const config = getAuthConfig();
  if (!config.enabled || !config.username || !config.password) {
    return { ok: false };
  }

  const usernameMatches = secureStringEquals(input.username, config.username);
  const passwordMatches = secureStringEquals(input.password, config.password);
  if (!usernameMatches || !passwordMatches) {
    return { ok: false };
  }

  const session = await createSessionRecord({
    username: config.username,
    remember: input.remember,
  });
  const authState = await getAuthState();
  return {
    ok: true,
    session,
    token: issueSessionToken(session, authState.secret),
  };
}

export function applySessionToHonoResponse(
  c: Context,
  token: string,
  session: AuthSessionRecord
): void {
  c.header(SESSION_TOKEN_HEADER, token);
  c.header("cache-control", "no-store");
  c.header("x-opencursor-auth-enabled", "1");
  c.header("x-opencursor-auth-session-expires-at", String(session.expiresAt));
  const maxAgeSeconds = Math.max(1, Math.ceil((session.expiresAt - Date.now()) / 1000));
  setCookie(
    c,
    SESSION_COOKIE_NAME,
    token,
    createCookieOptions(c.req.raw, session.remember, maxAgeSeconds)
  );
}

export function clearSessionFromHonoResponse(c: Context): void {
  c.header("cache-control", "no-store");
  c.header(SESSION_TOKEN_HEADER, "");
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
}

export function buildRateLimitedJsonResponse(
  result: RateLimitResult,
  message: string
): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  applyRateLimitHeaders(headers, result);
  return new Response(JSON.stringify({ error: message }), {
    status: 429,
    headers,
  });
}

export async function checkRequestRateLimit(
  request: RequestLike,
  kind: RateLimitKind
): Promise<RateLimitResult> {
  return consumeRateLimit(kind, rateLimitKeyForRequest(request));
}

export const authMiddleware: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "OPTIONS" || !isAuthEnabled()) {
    await next();
    return;
  }

  const pathname = new URL(c.req.url).pathname;
  if (
    pathname === "/health" ||
    pathname === "/api/auth/status" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/logout" ||
    pathname === "/api/mcp/oauth/callback" ||
    pathname === "/api/settings/pi-agent/oauth/callback"
  ) {
    await next();
    return;
  }

  const rateLimit = await checkRequestRateLimit(
    c.req.raw,
    classifyProtectedHttpRateLimit(pathname, c.req.method)
  );
  c.header("x-ratelimit-limit", String(rateLimit.limit));
  c.header("x-ratelimit-remaining", String(rateLimit.remaining));
  c.header("x-ratelimit-reset", String(rateLimit.resetAt));
  if (!rateLimit.ok) {
    c.header("retry-after", String(rateLimit.retryAfterSec));
    c.res = buildRateLimitedJsonResponse(
      rateLimit,
      "Too many requests. Please slow down and try again shortly."
    );
    return;
  }

  // Iframe navigations to `/browser/*` and `/browser-debug/*` cannot attach the
  // `x-opencursor-session-token` header (only fetch/XHR can). SameSite=Lax
  // cookies don't reliably flow across ports on localhost for sub-document
  // navigation either — Chromium partitions some flows that Chrome docs call
  // "same-site" in theory. So for these two surfaces we accept the session
  // token from `?access_token=…` (same mechanism WebSocket upgrades use) and
  // bootstrap the session cookie on success so every subsequent same-origin
  // sub-resource fetch from inside the iframe authenticates via cookie.
  const isBrowserSurfacePath =
    pathname.startsWith("/browser/") || pathname.startsWith("/browser-debug/");
  const auth = await authenticateRequest(c.req.raw, {
    allowQuery: isBrowserSurfacePath,
    rotate: true,
  });
  if (auth.status !== "authenticated") {
    c.res = new Response(JSON.stringify({ error: "Authentication required." }), {
      status: 401,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
    if (auth.status === "invalid" && auth.clearCookie) {
      clearSessionFromHonoResponse(c);
    }
    return;
  }

  await next();
  if (auth.rotatedToken) {
    applySessionToHonoResponse(c, auth.rotatedToken, auth.session);
  } else if (isBrowserSurfacePath && auth.source === "query") {
    applySessionToHonoResponse(c, auth.token, auth.session);
  }
};

export function getAuthStatusPayload(
  auth: AuthenticationResult
):
  | {
      enabled: false;
      authenticated: true;
      session: null;
      rotationIntervalMs: number;
    }
  | {
      enabled: true;
      authenticated: boolean;
      session: PublicAuthSession | null;
      rotationIntervalMs: number;
    } {
  const config = getAuthConfig();
  if (!config.enabled) {
    return {
      enabled: false,
      authenticated: true,
      session: null,
      rotationIntervalMs: config.rotationIntervalMs,
    };
  }
  return {
    enabled: true,
    authenticated: auth.status === "authenticated",
    session: auth.status === "authenticated" ? toPublicSession(auth.session) : null,
    rotationIntervalMs: config.rotationIntervalMs,
  };
}

export async function logoutRequest(request: RequestLike): Promise<void> {
  const auth = await authenticateRequest(request, {
    allowQuery: true,
    rotate: false,
  });
  if (auth.status === "authenticated") {
    await revokeSessionRecord(auth.session.id).catch(() => undefined);
  }
}

export async function authenticateUpgradeRequest(
  request: RequestLike,
  kind: "ws-fs" | "ws-agent" | "ws-terminal" | "ws-browser-debug"
): Promise<UpgradeAuthResult> {
  if (!isAuthEnabled()) {
    return { ok: true };
  }

  const rateLimit = await checkRequestRateLimit(request, kind);
  if (!rateLimit.ok) {
    return {
      ok: false,
      status: 429,
      message: "Too many upgrade attempts.",
      retryAfterSec: rateLimit.retryAfterSec,
    };
  }

  const auth = await authenticateRequest(request, {
    allowQuery: true,
    rotate: false,
  });
  if (auth.status === "authenticated") {
    return { ok: true };
  }
  return {
    ok: false,
    status: 401,
    message: "Authentication required.",
  };
}

export function buildUpgradeHttpResponse(
  result: Exclude<UpgradeAuthResult, { ok: true }>
): string {
  const lines = [
    `HTTP/1.1 ${result.status} ${
      result.status === 401 ? "Unauthorized" : "Too Many Requests"
    }`,
    "Cache-Control: no-store",
    "Content-Type: text/plain; charset=utf-8",
  ];
  if (result.retryAfterSec) {
    lines.push(`Retry-After: ${result.retryAfterSec}`);
  }
  lines.push("", result.message);
  return lines.join("\r\n");
}
