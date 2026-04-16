import { Hono } from "hono";
import {
  applySessionToHonoResponse,
  buildRateLimitedJsonResponse,
  checkRequestRateLimit,
  clearSessionFromHonoResponse,
  getAuthStatusPayload,
  isAuthEnabled,
  loginWithCredentials,
  logoutRequest,
  authenticateRequest,
} from "../lib/auth.js";

export const authRoutes = new Hono();

function applyRateLimitContextHeaders(
  c: {
    header: (name: string, value: string) => void;
  },
  input: {
    limit: number;
    remaining: number;
    resetAt: number;
    retryAfterSec: number;
    ok: boolean;
  }
): void {
  c.header("x-ratelimit-limit", String(input.limit));
  c.header("x-ratelimit-remaining", String(input.remaining));
  c.header("x-ratelimit-reset", String(input.resetAt));
  if (!input.ok) {
    c.header("retry-after", String(input.retryAfterSec));
  }
}

authRoutes.get("/api/auth/status", async (c) => {
  const rateLimit = await checkRequestRateLimit(c.req.raw, "auth-status");
  applyRateLimitContextHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return buildRateLimitedJsonResponse(
      rateLimit,
      "Too many auth status checks. Please try again shortly."
    );
  }

  const auth = await authenticateRequest(c.req.raw, {
    allowQuery: false,
    rotate: true,
  });
  const payload = getAuthStatusPayload(auth);

  const response = c.json(payload);
  c.res = response;
  c.header("cache-control", "no-store");
  c.header("x-opencursor-auth-enabled", payload.enabled ? "1" : "0");

  if (auth.status === "authenticated" && auth.rotatedToken) {
    applySessionToHonoResponse(c, auth.rotatedToken, auth.session);
  } else if (auth.status === "invalid" && auth.clearCookie) {
    clearSessionFromHonoResponse(c);
  }

  return c.res;
});

authRoutes.post("/api/auth/login", async (c) => {
  const rateLimit = await checkRequestRateLimit(c.req.raw, "login");
  applyRateLimitContextHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return buildRateLimitedJsonResponse(
      rateLimit,
      "Too many login attempts. Please try again shortly."
    );
  }

  if (!isAuthEnabled()) {
    const response = c.json({ error: "Authentication is not enabled." }, 404);
    c.res = response;
    c.header("cache-control", "no-store");
    c.header("x-opencursor-auth-enabled", "0");
    return c.res;
  }

  const body =
    (await c.req
      .json<{ username?: string; password?: string; remember?: boolean }>()
      .catch(() => null)) ?? {};
  if (!body.username || !body.password) {
    const response = c.json({ error: "Expected username and password." }, 400);
    c.res = response;
    c.header("cache-control", "no-store");
    c.header("x-opencursor-auth-enabled", "1");
    return c.res;
  }

  const result = await loginWithCredentials({
    username: body.username,
    password: body.password,
    remember: body.remember === true,
  });
  if (!result.ok) {
    const response = c.json({ error: "Invalid username or password." }, 401);
    c.res = response;
    c.header("cache-control", "no-store");
    c.header("x-opencursor-auth-enabled", "1");
    return c.res;
  }

  const response = c.json({
    ok: true,
    authenticated: true,
    session: {
      username: result.session.username,
      createdAt: result.session.createdAt,
      expiresAt: result.session.expiresAt,
      lastSeenAt: result.session.lastSeenAt,
      remember: result.session.remember,
    },
  });
  c.res = response;
  c.header("cache-control", "no-store");
  c.header("x-opencursor-auth-enabled", "1");
  applySessionToHonoResponse(c, result.token, result.session);
  return c.res;
});

authRoutes.post("/api/auth/logout", async (c) => {
  await logoutRequest(c.req.raw);
  const response = c.json({ ok: true });
  c.res = response;
  c.header("cache-control", "no-store");
  c.header("x-opencursor-auth-enabled", isAuthEnabled() ? "1" : "0");
  clearSessionFromHonoResponse(c);
  return c.res;
});
