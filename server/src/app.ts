import { cors } from "hono/cors";
import { Hono } from "hono";
import { authMiddleware, SESSION_TOKEN_HEADER } from "./lib/auth.js";
import { agentRoutes } from "./routes/agents.js";
import { authRoutes } from "./routes/auth.js";
import { audioRoutes } from "./routes/audio.js";
import { browserProxyRoutes } from "./routes/browser-proxy.js";
import { fsRoutes } from "./routes/fs.js";
import { settingsRoutes } from "./routes/settings.js";
import { terminalRoutes } from "./routes/terminals.js";
import { workspaceRoutes } from "./routes/workspaces.js";

export function createApp(input: { allowedOrigins: string[] }): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return input.allowedOrigins[0] ?? "*";
        return input.allowedOrigins.includes(origin)
          ? origin
          : input.allowedOrigins[0] ?? "*";
      },
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "Authorization",
        SESSION_TOKEN_HEADER,
        "x-opencursor-workspace-id",
      ],
      exposeHeaders: [SESSION_TOKEN_HEADER, "x-opencursor-auth-session-expires-at"],
      credentials: true,
    })
  );

  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: error.message }, 500);
  });

  app.use("*", authMiddleware);

  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/", authRoutes);
  app.route("/browser", browserProxyRoutes);
  app.route("/", workspaceRoutes);
  app.route("/", settingsRoutes);
  app.route("/", fsRoutes);
  app.route("/", terminalRoutes);
  app.route("/", agentRoutes);
  app.route("/", audioRoutes);

  return app;
}
