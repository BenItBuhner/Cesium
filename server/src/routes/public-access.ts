import { Hono } from "hono";
import type { Context } from "hono";
import {
  buildRateLimitedJsonResponse,
  clearLoginRateLimitAfterSuccess,
  gateLoginRateLimit,
  isAuthEnabled,
  recordFailedLoginRateLimit,
} from "../lib/auth.js";
import { enginePairingManager } from "../lib/engine-pairing.js";
import {
  isLoopbackControlRequest,
  PUBLIC_ACCESS_LOCAL_CONTROL_MESSAGE,
} from "../lib/engine-exposure-policy.js";
import {
  publicAccessManager,
  PublicAccessError,
  type PublicAccessConfigInput,
} from "../lib/public-access-manager.js";

export const publicAccessRoutes = new Hono();

publicAccessRoutes.use("/api/public-access/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store, max-age=0");
  c.header("X-Content-Type-Options", "nosniff");
});

publicAccessRoutes.use("/api/pairing/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store, max-age=0");
  c.header("X-Content-Type-Options", "nosniff");
});

function publicAccessInput(body: unknown): PublicAccessConfigInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  const input = body as Record<string, unknown>;
  return {
    ...(Object.prototype.hasOwnProperty.call(input, "webAppUrl")
      ? { webAppUrl: input.webAppUrl }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "provider")
      ? { provider: input.provider }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "customPublicUrl")
      ? { customPublicUrl: input.customPublicUrl }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "label")
      ? { label: input.label }
      : {}),
  };
}

async function readBody(c: Context) {
  return (await c.req.json().catch(() => ({}))) as unknown;
}

function assertLocalControlWhenUnauthenticated(c: Context) {
  if (isAuthEnabled()) {
    return;
  }
  if (!isLoopbackControlRequest(c.req.url)) {
    throw new PublicAccessError(PUBLIC_ACCESS_LOCAL_CONTROL_MESSAGE, 403);
  }
}

function errorResponse(c: Context, error: unknown) {
  if (error instanceof PublicAccessError) {
    return c.json(
      { error: error.message },
      error.status as 400 | 401 | 403 | 404 | 409 | 410 | 502 | 503
    );
  }
  throw error;
}

publicAccessRoutes.get("/api/public-access/status", async (c) => {
  return c.json(await publicAccessManager.getStatus());
});

publicAccessRoutes.put("/api/public-access/config", async (c) => {
  try {
    assertLocalControlWhenUnauthenticated(c);
    const status = await publicAccessManager.updateConfig(publicAccessInput(await readBody(c)));
    return c.json(status);
  } catch (error) {
    return errorResponse(c, error);
  }
});

publicAccessRoutes.post("/api/public-access/enable", async (c) => {
  try {
    assertLocalControlWhenUnauthenticated(c);
    return c.json(await publicAccessManager.enable(publicAccessInput(await readBody(c))));
  } catch (error) {
    return errorResponse(c, error);
  }
});

publicAccessRoutes.post("/api/public-access/disable", async (c) => {
  try {
    assertLocalControlWhenUnauthenticated(c);
    return c.json(await publicAccessManager.disable());
  } catch (error) {
    return errorResponse(c, error);
  }
});

publicAccessRoutes.post("/api/public-access/rotate-auth", async (c) => {
  try {
    assertLocalControlWhenUnauthenticated(c);
    return c.json(await publicAccessManager.rotateAuth());
  } catch (error) {
    return errorResponse(c, error);
  }
});

/* ---- One-link account pairing -------------------------------------- */

/** Engine operator (CLI / settings) mints a fresh `/connect/<code>` link. */
publicAccessRoutes.post("/api/public-access/pairing", async (c) => {
  try {
    assertLocalControlWhenUnauthenticated(c);
    const body = (await readBody(c)) as { ttlMs?: unknown } | null;
    const ttlMs = typeof body?.ttlMs === "number" ? body.ttlMs : undefined;
    return c.json(await enginePairingManager.start({ ttlMs }), 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

/** Engine operator polls whether the link was approved (and by whom). */
publicAccessRoutes.get("/api/public-access/pairing/:code", async (c) => {
  try {
    assertLocalControlWhenUnauthenticated(c);
    return c.json(await enginePairingManager.status(c.req.param("code")));
  } catch (error) {
    return errorResponse(c, error);
  }
});

publicAccessRoutes.delete("/api/public-access/pairing/:code", async (c) => {
  try {
    assertLocalControlWhenUnauthenticated(c);
    return c.json({ ok: enginePairingManager.cancel(c.req.param("code")) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

/**
 * The approving browser redeems the connect code for the engine credential.
 * No engine session (the auth middleware exempts this path); possession of
 * the unexpired, unused code is the proof. Shares the login bucket so code
 * guessing is throttled like password guessing.
 */
publicAccessRoutes.post("/api/pairing/claim", async (c) => {
  const gate = await gateLoginRateLimit(c.req.raw);
  if (!gate.ok) {
    return buildRateLimitedJsonResponse(gate, "Too many connect attempts. Please try again shortly.");
  }
  const body = (await readBody(c)) as { code?: unknown; account?: unknown } | null;
  try {
    const result = await enginePairingManager.claim(body?.code, body?.account);
    await clearLoginRateLimitAfterSuccess(c.req.raw);
    return c.json(result);
  } catch (error) {
    if (error instanceof PublicAccessError) {
      await recordFailedLoginRateLimit(c.req.raw);
    }
    return errorResponse(c, error);
  }
});
