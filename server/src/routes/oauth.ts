import { Hono } from "hono";
import { resolveOAuthPublicOrigin } from "../lib/oauth/public-origin.js";
import {
  getOAuthCoordinatorSession,
  publicOAuthSession,
} from "../lib/oauth/sessions.js";

export const oauthRoutes = new Hono();

oauthRoutes.get("/api/oauth/public-origin", (c) => {
  return c.json({
    publicOrigin: resolveOAuthPublicOrigin(c.req),
    configured: Boolean(
      process.env.OPENCURSOR_OAUTH_PUBLIC_ORIGIN?.trim() ||
        process.env.OPENCURSOR_SERVER_PUBLIC_ORIGIN?.trim()
    ),
  });
});

oauthRoutes.get("/api/oauth/sessions/:sessionId", async (c) => {
  const session = await getOAuthCoordinatorSession(c.req.param("sessionId"));
  if (!session) {
    return c.json({ error: "Unknown OAuth session." }, 404);
  }
  return c.json({ session: publicOAuthSession(session) });
});
