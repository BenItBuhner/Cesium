import "./env-bootstrap.js";
import dns from "node:dns";
import { serve } from "@hono/node-server";

/** Prefer IPv4 when connecting upstream (avoids broken IPv6 routes that make `fetch()` fail with "fetch failed"). */
dns.setDefaultResultOrder("ipv4first");
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

const app = new Hono();

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return allowedOrigins[0] ?? "*";
      return allowedOrigins.includes(origin) ? origin : allowedOrigins[0] ?? "*";
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
