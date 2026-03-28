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
import { handleFsUpgrade } from "./ws/filewatcher.js";
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
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "x-opencursor-workspace-id"],
  })
);

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: error.message }, 500);
});

app.get("/health", (c) => c.json({ ok: true }));
app.route("/browser", browserProxyRoutes);
app.route("/", workspaceRoutes);
app.route("/", settingsRoutes);
app.route("/", fsRoutes);
app.route("/", terminalRoutes);

const server = serve({
  fetch: app.fetch,
  port,
  hostname: host,
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname === "/ws/fs") {
    handleFsUpgrade(request, socket, head);
    return;
  }

  if (url.pathname.startsWith("/ws/terminal/")) {
    const terminalId = url.pathname.slice("/ws/terminal/".length);
    handleTerminalUpgrade(request, socket, head, terminalId);
    return;
  }

  socket.destroy();
});

console.log(`OpenCursor server listening on http://${publicHost}:${port}`);
