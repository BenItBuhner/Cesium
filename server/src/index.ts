import "./env-bootstrap.js";
import dns from "node:dns";
import { serve } from "@hono/node-server";

/** Prefer IPv4 when connecting upstream (avoids broken IPv6 routes that make `fetch()` fail with "fetch failed"). */
dns.setDefaultResultOrder("ipv4first");
import {
  authenticateUpgradeRequest,
  buildUpgradeHttpResponse,
} from "./lib/auth.js";
import { createApp } from "./app.js";
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

const app = createApp({ allowedOrigins });

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
