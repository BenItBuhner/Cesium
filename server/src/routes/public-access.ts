import { Hono } from "hono";
import type { Context } from "hono";
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

function errorResponse(c: Context, error: unknown) {
  if (error instanceof PublicAccessError) {
    return c.json({ error: error.message }, error.status as 400 | 401 | 403 | 404 | 409 | 502 | 503);
  }
  throw error;
}

publicAccessRoutes.get("/api/public-access/status", async (c) => {
  return c.json(await publicAccessManager.getStatus());
});

publicAccessRoutes.put("/api/public-access/config", async (c) => {
  try {
    const status = await publicAccessManager.updateConfig(publicAccessInput(await readBody(c)));
    return c.json(status);
  } catch (error) {
    return errorResponse(c, error);
  }
});

publicAccessRoutes.post("/api/public-access/enable", async (c) => {
  try {
    return c.json(await publicAccessManager.enable(publicAccessInput(await readBody(c))));
  } catch (error) {
    return errorResponse(c, error);
  }
});

publicAccessRoutes.post("/api/public-access/disable", async (c) => {
  try {
    return c.json(await publicAccessManager.disable());
  } catch (error) {
    return errorResponse(c, error);
  }
});

publicAccessRoutes.post("/api/public-access/rotate-auth", async (c) => {
  try {
    return c.json(await publicAccessManager.rotateAuth());
  } catch (error) {
    return errorResponse(c, error);
  }
});
