import { cors } from "hono/cors";
import { compress } from "hono/compress";
import { Hono } from "hono";
import { fsRoutes } from "./routes/fs.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { pullRequestRoutes } from "./routes/pull-requests.js";
import { settingsRoutes } from "./routes/settings.js";
import { terminalRoutes } from "./routes/terminals.js";
import { browserProxyRoutes } from "./routes/browser-proxy.js";
import { browserDebugRoutes } from "./routes/browser-debug.js";
import { browserControlRoutes } from "./routes/browser-control.js";
import { phoneControlRoutes } from "./routes/phone-control.js";
import { agentRoutes } from "./routes/agents.js";
import { actionsRoutes } from "./routes/actions.js";
import { artifactRoutes } from "./routes/artifacts.js";
import { agentImportRoutes } from "./routes/agent-imports.js";
import { agentInstallRoutes } from "./routes/agent-install.js";
import { cloudContextRoutes } from "./routes/cloud-context.js";
import { audioRoutes } from "./routes/audio.js";
import { voiceRoutes } from "./routes/voice.js";
import { authRoutes } from "./routes/auth.js";
import { mcpRoutes } from "./routes/mcp.js";
import { mcpBridgeRoutes } from "./routes/mcp-bridge.js";
import { oauthRoutes } from "./routes/oauth.js";
import { pluginRoutes } from "./routes/plugins.js";
import { storageRoutes } from "./routes/storage.js";
import { updateRoutes } from "./routes/updates.js";
import { usageRoutes } from "./routes/usage.js";
import { orchestrationRoutes } from "./routes/orchestration.js";
import { cloudAgentRoutes } from "./routes/cloud-agents.js";
import { extensionRoutes } from "./routes/extensions.js";
import { publicAccessRoutes } from "./routes/public-access.js";
import { metaRoutes } from "./routes/meta.js";
import { bootstrapStorage } from "./storage/index.js";
import { AGENT_BACKENDS } from "./lib/agents/providers.js";
import { warmupAgentBackendCaches } from "./lib/agents/provider-cache-store.js";
import { startAgentPromptQueueDrainListener } from "./lib/agents/prompt-queue-drain.js";
import {
  reconcileStaleAgentRunsOnBoot,
  startStaleAgentRunWatchdog,
} from "./lib/agents/stale-run-reconciler.js";
import { startCloudAgentTaskSyncListener } from "./lib/cloud-agents/dispatcher.js";
import { authMiddleware, isAuthEnabled, SESSION_TOKEN_HEADER } from "./lib/auth.js";
import { assertEngineExposureAllowed } from "./lib/engine-exposure-policy.js";
import { getEngineInstanceId } from "./lib/engine-instance.js";
import { startUpdateAutoCheck } from "./lib/updates/update-manager.js";
import { startCesiumTriggerScheduler } from "./lib/agents/trigger-scheduler.js";
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
  const host = process.env.HOST?.trim() || "127.0.0.1";
  return {
    port,
    host,
    publicHost: process.env.PUBLIC_HOST?.trim() || (host === "0.0.0.0" ? "localhost" : host),
  };
})();

export function createCesiumApp(): Hono {
  const allowAndroidFileOrigin =
    process.env.OPENCURSOR_ALLOW_ANDROID_FILE_ORIGIN?.trim() !== "0";
  const defaultAllowedOrigins = [
    `http://${serverConfig.publicHost}:3000`,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://10.0.2.2:5173",
    ...(allowAndroidFileOrigin ? ["null"] : []),
  ];
  const configuredAllowedOrigins = process.env.ALLOWED_ORIGINS
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowedOrigins = [
    ...(configuredAllowedOrigins ?? defaultAllowedOrigins),
    // The production Android app loads the bundled workbench from
    // file:///android_asset/workbench/index.html, whose Origin is "null".
    // Preserve that one native-shell origin when a self-hosted deployment
    // replaces the browser allowlist. It can be explicitly disabled above.
    ...(configuredAllowedOrigins && allowAndroidFileOrigin ? ["null"] : []),
  ].filter((origin, index, origins) => origins.indexOf(origin) === index);
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
        "If-Match",
        "If-None-Match",
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
        "x-cesium-protocol-version",
        "etag",
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
    c.json({
      ok: true,
      instanceId: getEngineInstanceId(),
      transcription: { configured: isTranscriptionConfigured() },
    })
  );
  app.route("/", metaRoutes);
  app.route("/", authRoutes);
  app.route("/", publicAccessRoutes);
  app.route("/", mcpRoutes);
  app.route("/", mcpBridgeRoutes);
  app.route("/", oauthRoutes);
  app.route("/", pluginRoutes);
  app.route("/browser", browserProxyRoutes);
  app.route("/", browserDebugRoutes);
  app.route("/", browserControlRoutes);
  app.route("/", phoneControlRoutes);
  app.route("/", workspaceRoutes);
  app.route("/", pullRequestRoutes);
  app.route("/", settingsRoutes);
  app.route("/", fsRoutes);
  app.route("/", terminalRoutes);
  app.route("/", agentRoutes);
  app.route("/", actionsRoutes);
  app.route("/", agentImportRoutes);
  app.route("/", agentInstallRoutes);
  app.route("/", cloudContextRoutes);
  app.route("/", artifactRoutes);
  app.route("/", orchestrationRoutes);
  app.route("/", cloudAgentRoutes);
  app.route("/", extensionRoutes);
  app.route("/", audioRoutes);
  app.route("/", voiceRoutes);
  app.route("/", storageRoutes);
  app.route("/", updateRoutes);
  app.route("/", usageRoutes);
  return app;
}

let backgroundStarted = false;

export function startCesiumBackgroundServices(): void {
  assertEngineExposureAllowed({
    bindHost: serverConfig.host,
    authEnabled: isAuthEnabled(),
  });
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
  startUpdateAutoCheck();
  if (process.env.NODE_ENV !== "test") {
    startCesiumTriggerScheduler();
  }
  // The reconciler mutates persisted conversations, so it must never run
  // inside test processes that boot the app (NODE_TEST_CONTEXT is set by the
  // node:test runner even when NODE_ENV is not).
  if (process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT) {
    // Conversations persisted as busy by a previous server process are stuck
    // (runtimes are in-memory only); interrupt them so clients stop showing
    // an eternal "Working" state, then keep watching for runs whose provider
    // runtime dies without settling the turn.
    void reconcileStaleAgentRunsOnBoot().catch((error) => {
      console.error("[agent-reconcile] boot sweep failed:", error);
    });
    startStaleAgentRunWatchdog();
  }
}
