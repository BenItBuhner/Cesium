import dns from "node:dns";
import { serve } from "@hono/node-server";
import {
  authenticateUpgradeRequest,
  buildUpgradeHttpResponse,
} from "../lib/auth.js";
import { handleFsUpgrade } from "../ws/filewatcher.js";
import { handleAgentUpgrade } from "../ws/agent.js";
import { handleOrchestrationUpgrade } from "../ws/orchestration.js";
import { handleTerminalUpgrade } from "../ws/terminal.js";
import { handleBrowserDebugUpgrade } from "../ws/browser-debug.js";
import { handleMobileControlUpgrade } from "../ws/mobile-control.js";
import {
  createCesiumApp,
  serverConfig,
  startCesiumBackgroundServices,
} from "../app.js";
import { flushServerPerfReport } from "../lib/perf.js";

dns.setDefaultResultOrder("ipv4first");

const activeNodeServers: unknown[] = [];

export function startNodeServer(): void {
  const app = createCesiumApp();
  startCesiumBackgroundServices();

  const server = serve({
    fetch: app.fetch,
    port: serverConfig.port,
    hostname: serverConfig.host,
  });
  activeNodeServers.push(server);
  if (typeof server.ref === "function") {
    server.ref();
  }

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

    if (url.pathname === "/ws/mobile-control") {
      void authenticateUpgradeRequest(request, "ws-agent").then((result) => {
        if (!result.ok) {
          socket.write(buildUpgradeHttpResponse(result));
          socket.destroy();
          return;
        }
        handleMobileControlUpgrade(request, socket, head);
      });
      return;
    }

    if (url.pathname === "/ws/orchestration") {
      void authenticateUpgradeRequest(request, "ws-agent").then((result) => {
        if (!result.ok) {
          socket.write(buildUpgradeHttpResponse(result));
          socket.destroy();
          return;
        }
        handleOrchestrationUpgrade(request, socket, head);
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

    if (url.pathname.startsWith("/ws/browser-debug/")) {
      const rest = url.pathname.slice("/ws/browser-debug/".length);
      const firstSlash = rest.indexOf("/");
      const sessionId = firstSlash === -1 ? rest : rest.slice(0, firstSlash);
      const subPath = firstSlash === -1 ? "" : rest.slice(firstSlash);
      if (!sessionId) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\nMissing session id.");
        socket.destroy();
        return;
      }
      void authenticateUpgradeRequest(request, "ws-browser-debug").then((result) => {
        if (!result.ok) {
          socket.write(buildUpgradeHttpResponse(result));
          socket.destroy();
          return;
        }
        handleBrowserDebugUpgrade(request, socket, head, sessionId, subPath);
      });
      return;
    }

    socket.destroy();
  });

  console.log(`Cesium server listening on http://${serverConfig.publicHost}:${serverConfig.port}`);

  process.once("beforeExit", () => {
    void flushServerPerfReport("beforeExit").catch((error) => {
      console.warn("[perf] failed to flush report:", error);
    });
  });
}
