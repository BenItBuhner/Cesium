import "./env-bootstrap.js";
import dns from "node:dns";
import { serve } from "@hono/node-server";

/** Prefer IPv4 when connecting upstream (avoids broken IPv6 routes that make `fetch()` fail with "fetch failed"). */
dns.setDefaultResultOrder("ipv4first");

// Single place to swallow transient async failures from WS handlers,
// `postgres` pool blips, `ioredis` reconnects, etc. Without these, one
// unhandled Promise rejection (e.g. a CONNECT_TIMEOUT while a user is typing
// in a chat) terminates the whole server. We log loudly instead.
process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandledRejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[process] uncaughtException:", error);
});
import { cors } from "hono/cors";
import { Hono } from "hono";
import { fsRoutes } from "./routes/fs.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { settingsRoutes } from "./routes/settings.js";
import { terminalRoutes } from "./routes/terminals.js";
import { browserProxyRoutes } from "./routes/browser-proxy.js";
import { agentRoutes } from "./routes/agents.js";
import { audioRoutes } from "./routes/audio.js";
import { authRoutes } from "./routes/auth.js";
import { storageRoutes } from "./routes/storage.js";
import { bootstrapStorage } from "./storage/index.js";
import { AGENT_BACKENDS } from "./lib/agents/providers.js";
import { warmupAgentBackendCaches } from "./lib/agents/provider-cache-store.js";
import {
  authMiddleware,
  authenticateUpgradeRequest,
  buildUpgradeHttpResponse,
  SESSION_TOKEN_HEADER,
} from "./lib/auth.js";
import { isTranscriptionConfigured } from "./lib/transcription-env.js";
import { handleFsUpgrade } from "./ws/filewatcher.js";
import { handleAgentUpgrade } from "./ws/agent.js";
import { handleTerminalUpgrade } from "./ws/terminal.js";
import {
  isPrivateLanBrowserOrigin,
  shouldRelaxPrivateLanCors,
} from "./lib/cors-origins.js";

const port = Number.parseInt(process.env.PORT ?? "9100", 10);
const host = process.env.HOST?.trim() || "0.0.0.0";
const publicHost =
  process.env.PUBLIC_HOST?.trim() || (host === "0.0.0.0" ? "localhost" : host);
const defaultAllowedOrigins = [
  `http://${publicHost}:3000`,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];
const allowedOrigins = (
  process.env.ALLOWED_ORIGINS ?? defaultAllowedOrigins.join(",")
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const relaxPrivateLanCors = shouldRelaxPrivateLanCors(publicHost);

const app = new Hono();

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return allowedOrigins[0] ?? "*";
      if (allowedOrigins.includes(origin)) return origin;
      if (relaxPrivateLanCors && isPrivateLanBrowserOrigin(origin)) return origin;
      // Do not echo a different origin — browsers reject credentialed responses
      // when Access-Control-Allow-Origin does not match the request's Origin.
      // Hono omits the header when the value is falsy (empty string is fine).
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
    ],
  })
);

app.use("*", authMiddleware);

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: error.message }, 500);
});

app.get("/health", (c) =>
  c.json({ ok: true, transcription: { configured: isTranscriptionConfigured() } })
);
app.route("/", authRoutes);
app.route("/browser", browserProxyRoutes);
app.route("/", workspaceRoutes);
app.route("/", settingsRoutes);
app.route("/", fsRoutes);
app.route("/", terminalRoutes);
app.route("/", agentRoutes);
app.route("/", audioRoutes);
app.route("/", storageRoutes);

void bootstrapStorage().catch((error) => {
  console.error("[storage] bootstrap failed:", error);
});

// Fire-and-forget: refresh every backend's config cache in the background so
// the first conversation-list request doesn't eat the CLI probe latency on
// the hot path. Skipped in test/NODE_ENV to keep fixtures deterministic.
if (process.env.NODE_ENV !== "test") {
  void warmupAgentBackendCaches(
    Object.keys(AGENT_BACKENDS) as Array<keyof typeof AGENT_BACKENDS>
  ).catch((error) => {
    console.warn("[agents] provider cache warmup failed:", error);
  });
}

const server = serve({
  fetch: app.fetch,
  port,
  hostname: host,
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname === "/ws/fs") {
    void authenticateUpgradeRequest(request, "ws-fs").then((result) => {
      if (!result.ok) {
        socket.write(buildUpgradeHttpResponse(result));
        socket.destroy();
        return;
      }
      handleFsUpgrade(request, socket, head);
    });
    return;
  }

  if (url.pathname === "/ws/agent") {
    void authenticateUpgradeRequest(request, "ws-agent").then((result) => {
      if (!result.ok) {
        socket.write(buildUpgradeHttpResponse(result));
        socket.destroy();
        return;
      }
      handleAgentUpgrade(request, socket, head);
    });
    return;
  }

  if (url.pathname.startsWith("/ws/terminal/")) {
    const terminalId = url.pathname.slice("/ws/terminal/".length);
    void authenticateUpgradeRequest(request, "ws-terminal").then((result) => {
      if (!result.ok) {
        socket.write(buildUpgradeHttpResponse(result));
        socket.destroy();
        return;
      }
      handleTerminalUpgrade(request, socket, head, terminalId);
    });
    return;
  }

  socket.destroy();
});

console.log(`OpenCursor server listening on http://${publicHost}:${port}`);
