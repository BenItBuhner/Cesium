import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { getDebugSession } from "../browser-debug/chromium-session.js";

const browserDebugWss = new WebSocketServer({ noServer: true });

/**
 * Proxy a client WebSocket connection to Chromium's local DevTools WebSocket.
 *
 * - `sessionId` is our session identifier (bd-<uuid>).
 * - `subPath` is the slice of the URL AFTER `sessionId`, e.g. `/devtools/page/<targetId>`.
 * - We open a new `ws://127.0.0.1:<chromiumPort><subPath>` and pipe frames both ways.
 */
export function handleBrowserDebugUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  sessionId: string,
  subPath: string
): void {
  const rec = getDebugSession(sessionId);
  if (!rec) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\nDebug session not found.");
    socket.destroy();
    return;
  }
  if (!subPath || subPath === "/") {
    socket.write(
      "HTTP/1.1 400 Bad Request\r\n\r\nMissing DevTools path (expected /devtools/page/<id> or /devtools/browser/<id>)."
    );
    socket.destroy();
    return;
  }

  const upstreamUrl = `ws://127.0.0.1:${rec.debugPort}${subPath}`;

  browserDebugWss.handleUpgrade(request, socket, head, (clientWs) => {
    const upstreamWs = new WebSocket(upstreamUrl, {
      // Some builds of Chromium reject clients whose Origin doesn't match its
      // allow-list; we already passed `--remote-allow-origins=*` at launch.
      perMessageDeflate: false,
    });

    let clientBuffer: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
    let upstreamOpen = false;

    const flushBuffer = () => {
      for (const msg of clientBuffer) {
        upstreamWs.send(msg.data, { binary: msg.isBinary });
      }
      clientBuffer = [];
    };

    const closeBoth = () => {
      try {
        if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
          clientWs.close();
        }
      } catch {
        /* ignore */
      }
      try {
        if (upstreamWs.readyState === WebSocket.OPEN || upstreamWs.readyState === WebSocket.CONNECTING) {
          upstreamWs.close();
        }
      } catch {
        /* ignore */
      }
    };

    upstreamWs.on("open", () => {
      upstreamOpen = true;
      flushBuffer();
    });
    upstreamWs.on("message", (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary });
      }
    });
    upstreamWs.on("close", () => closeBoth());
    upstreamWs.on("error", (err) => {
      console.error("[browser-debug] upstream WS error:", err.message);
      closeBoth();
    });

    clientWs.on("message", (data, isBinary) => {
      if (!upstreamOpen) {
        clientBuffer.push({ data, isBinary });
        return;
      }
      if (upstreamWs.readyState === WebSocket.OPEN) {
        upstreamWs.send(data, { binary: isBinary });
      }
    });
    clientWs.on("close", () => closeBoth());
    clientWs.on("error", () => closeBoth());
  });
}
