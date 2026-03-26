import "dotenv/config";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { Hono } from "hono";
import { fsRoutes } from "./routes/fs.js";
import { terminalRoutes } from "./routes/terminals.js";
import { initializeFileWatcher, handleFsUpgrade } from "./ws/filewatcher.js";
import { handleTerminalUpgrade } from "./ws/terminal.js";

const port = Number.parseInt(process.env.PORT ?? "9100", 10);
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000")
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
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })
);

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: error.message }, 500);
});

app.get("/health", (c) => c.json({ ok: true }));
app.route("/", fsRoutes);
app.route("/", terminalRoutes);

await initializeFileWatcher();

const server = serve({
  fetch: app.fetch,
  port,
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

console.log(`OpenCursor server listening on http://localhost:${port}`);
