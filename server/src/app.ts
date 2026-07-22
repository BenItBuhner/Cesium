import { cors } from "hono/cors";
import { compress } from "hono/compress";
import { Hono } from "hono";
import { fsRoutes } from "./routes/fs.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { settingsRoutes } from "./routes/settings.js";
import { terminalRoutes } from "./routes/terminals.js";
import { browserProxyRoutes } from "./routes/browser-proxy.js";
import { browserDebugRoutes } from "./routes/browser-debug.js";
import { browserControlRoutes } from "./routes/browser-control.js";
import { agentRoutes } from "./routes/agents.js";
import { audioRoutes } from "./routes/audio.js";
import { authRoutes } from "./routes/auth.js";
import { mcpRoutes } from "./routes/mcp.js";
import { pluginRoutes } from "./routes/plugins.js";
import { storageRoutes } from "./routes/storage.js";
import { orchestrationRoutes } from "./routes/orchestration.js";
import { cloudAgentRoutes } from "./routes/cloud-agents.js";
import { extensionRoutes } from "./routes/extensions.js";
import { publicAccessRoutes } from "./routes/public-access.js";
import { bootstrapStorage } from "./storage/index.js";
import { AGENT_BACKENDS } from "./lib/agents/providers.js";
import { warmupAgentBackendCaches } from "./lib/agents/provider-cache-store.js";
import { startAgentPromptQueueDrainListener } from "./lib/agents/prompt-queue-drain.js";
import { startCloudAgentTaskSyncListener } from "./lib/cloud-agents/dispatcher.js";
import { authMiddleware, SESSION_TOKEN_HEADER } from "./lib/auth.js";
import { publicAccessManager, startPublicAccessManager } from "./lib/public-access-manager.js";
import { isTranscriptionConfigured } from "./lib/transcription-env.js";
import {
  isPrivateLanBrowserOrigin,
  shouldRelaxPrivateLanCors,
} from "./lib/cors-origins.js";
import {
  recordServerPerfSpan,
  serverPerfEnabled,
  startServerPerfSpan,
} from "./lib/perf.js";

export type CesiumServerConfig = {
  port: number;
  host: string;
  publicHost: string;
};

export const serverConfig: CesiumServerConfig = (() => {
  const port = Number.parseInt(process.env.PORT ?? "9100", 10);
  const host = process.env.HOST?.trim() || "0.0.0.0";
  return {
    port,
    host,
    publicHost: process.env.PUBLIC_HOST?.trim() || (host === "0.0.0.0" ? "localhost" : host),
  };
})();

export function createCesiumApp(): Hono {
  const defaultAllowedOrigins = [
    `http://${serverConfig.publicHost}:3000`,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ];
  const allowedOrigins = (
    process.env.ALLOWED_ORIGINS ?? defaultAllowedOrigins.join(",")
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const relaxPrivateLanCors = shouldRelaxPrivateLanCors(
    serverConfig.publicHost,
    allowedOrigins
  );

  const app = new Hono();
  app.use("*", compress());
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return allowedOrigins[0] ?? "";
        if (allowedOrigins.includes(origin)) return origin;
        if (relaxPrivateLanCors && isPrivateLanBrowserOrigin(origin)) return origin;
        if (publicAccessManager.getCorsOriginSync() === origin) return origin;
        return "";
      },
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "x-opencursor-workspace-id",
        SESSION_TOKEN_HEADER,
      ],
      exposeHeaders: [
        SESSION_TOKEN_HEADER,
        "x-opencursor-auth-enabled",
        "x-opencursor-auth-session-expires-at",
        "x-ratelimit-limit",
        "x-ratelimit-remaining",
        "x-ratelimit-reset",
        "retry-after",
        "server-timing",
        "x-opencursor-perf-ms",
      ],
    })
  );
  app.use("*", async (c, next) => {
    const startedAt = startServerPerfSpan();
    await next();
    const pathname = new URL(c.req.url).pathname;
    const ms = recordServerPerfSpan("http.request", startedAt, {
      method: c.req.method,
      path: pathname,
      status: c.res.status,
    });
    if (serverPerfEnabled()) {
      c.header("Server-Timing", `cesium;dur=${ms.toFixed(1)}`);
      c.header("x-opencursor-perf-ms", ms.toFixed(1));
    }
  });

  app.use("*", authMiddleware);
  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: error.message }, 500);
  });

  app.get("/health", (c) =>
    c.json({ ok: true, transcription: { configured: isTranscriptionConfigured() } })
  );
  app.route("/", authRoutes);
  app.route("/", publicAccessRoutes);
  app.route("/", mcpRoutes);
  app.route("/", pluginRoutes);
  app.route("/browser", browserProxyRoutes);
  app.route("/", browserDebugRoutes);
  app.route("/", browserControlRoutes);
  app.route("/", workspaceRoutes);
  app.route("/", settingsRoutes);
  app.route("/", fsRoutes);
  app.route("/", terminalRoutes);
  app.route("/", agentRoutes);
  app.route("/", orchestrationRoutes);
  app.route("/", cloudAgentRoutes);
  app.route("/", extensionRoutes);
  app.route("/", audioRoutes);
  app.route("/", storageRoutes);
  return app;
}

let backgroundStarted = false;

export function startCesiumBackgroundServices(): void {
  if (backgroundStarted) {
    return;
  }
  backgroundStarted = true;
  void bootstrapStorage().catch((error) => {
    console.error("[storage] bootstrap failed:", error);
  });
  void startPublicAccessManager().catch((error) => {
    console.error("[public-access] startup failed:", error);
  });
  if (process.env.NODE_ENV !== "test") {
    void warmupAgentBackendCaches(
      Object.keys(AGENT_BACKENDS) as Array<keyof typeof AGENT_BACKENDS>
    ).catch((error) => {
      console.warn("[agents] provider cache warmup failed:", error);
    });
  }
  startAgentPromptQueueDrainListener();
  startCloudAgentTaskSyncListener();
}
