import "../env-bootstrap.js";
import {
  authenticateUpgradeRequest,
} from "../lib/auth.js";
import {
  createCesiumApp,
  serverConfig,
  startCesiumBackgroundServices,
} from "../app.js";
import { flushServerPerfReport } from "../lib/perf.js";
import { attachAgentSocket } from "../ws/agent.js";
import { attachOrchestrationSocket } from "../ws/orchestration.js";
import { attachFsSocket } from "../ws/filewatcher.js";
import { attachTerminalSocket } from "../ws/terminal.js";
import { attachBrowserDebugSocket } from "../ws/browser-debug.js";
import { BufferedRuntimeSocket, type RuntimeSocketData } from "../ws/runtime-socket.js";

// Match Node entry resilience: transient TLS / WS flakes must not take down Bun.
process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandledRejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[process] uncaughtException:", error);
});

type BunSocketData = {
  kind: "agent" | "orchestration" | "fs" | "terminal" | "browser-debug";
  workspaceId?: string;
  since?: number;
  terminalId?: string;
  sessionId?: string;
  subPath?: string;
  runtimeSocket?: BufferedRuntimeSocket;
};

type BunServerWebSocket = {
  data: BunSocketData;
  send(data: RuntimeSocketData): void;
  close(code?: number, reason?: string): void;
};

type BunServer = {
  upgrade(request: Request, options: { data: BunSocketData }): boolean;
};

type BunServeOptions = {
  port: number;
  hostname: string;
  maxRequestBodySize: number;
  fetch(request: Request, server: BunServer): Response | Promise<Response | undefined> | undefined;
  websocket: {
    open(ws: BunServerWebSocket): void;
    message(ws: BunServerWebSocket, message: string | Buffer): void;
    close(ws: BunServerWebSocket): void;
  };
};

type BunRuntime = {
  serve(options: BunServeOptions): { url: URL; stop(force?: boolean): void };
};

function responseFromUpgradeAuth(result: Awaited<ReturnType<typeof authenticateUpgradeRequest>>): Response | null {
  if (result.ok) {
    return null;
  }
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
  });
  if (result.retryAfterSec) {
    headers.set("Retry-After", String(result.retryAfterSec));
  }
  return new Response(result.message, { status: result.status, headers });
}

async function upgradeOrReject(
  request: Request,
  server: BunServer,
  kind: BunSocketData["kind"],
  data: Omit<BunSocketData, "kind">
): Promise<Response | undefined> {
  const authKind =
    kind === "fs"
      ? "ws-fs"
      : kind === "agent"
        ? "ws-agent"
        : kind === "orchestration"
          ? "ws-agent"
          : kind === "terminal"
            ? "ws-terminal"
            : "ws-browser-debug";
  const auth = responseFromUpgradeAuth(await authenticateUpgradeRequest(request, authKind));
  if (auth) {
    return auth;
  }
  const upgraded = server.upgrade(request, { data: { kind, ...data } });
  return upgraded ? undefined : new Response("WebSocket upgrade failed.", { status: 400 });
}

function attachSocket(ws: BunServerWebSocket): void {
  const runtimeSocket = new BufferedRuntimeSocket(
    (data) => ws.send(data),
    (code, reason) => ws.close(code, reason)
  );
  ws.data.runtimeSocket = runtimeSocket;
  switch (ws.data.kind) {
    case "agent":
      attachAgentSocket(runtimeSocket, ws.data.workspaceId ?? "");
      break;
    case "orchestration":
      attachOrchestrationSocket(runtimeSocket, ws.data.workspaceId ?? "");
      break;
    case "fs":
      void attachFsSocket(runtimeSocket, ws.data.workspaceId ?? "", ws.data.since ?? 0).catch(
        () => runtimeSocket.close(1008, "Unknown workspace")
      );
      break;
    case "terminal":
      attachTerminalSocket(runtimeSocket, ws.data.terminalId ?? "");
      break;
    case "browser-debug":
      attachBrowserDebugSocket(
        runtimeSocket,
        ws.data.sessionId ?? "",
        ws.data.subPath ?? ""
      );
      break;
    default: {
      const exhaustive: never = ws.data.kind;
      runtimeSocket.close(1011, `Unknown socket kind: ${String(exhaustive)}`);
    }
  }
}

export function startBunServer(): void {
  const BunRuntime = (globalThis as unknown as { Bun?: BunRuntime }).Bun;
  if (!BunRuntime) {
    throw new Error("Bun runtime is required for startBunServer().");
  }
  const app = createCesiumApp();
  startCesiumBackgroundServices();
  const server = BunRuntime.serve({
    port: serverConfig.port,
    hostname: serverConfig.host,
    maxRequestBodySize:
      Number.parseInt(process.env.BUN_MAX_REQUEST_BODY_SIZE ?? "", 10) ||
      1024 * 1024 * 200,
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      if (url.pathname === "/ws/fs") {
        return upgradeOrReject(request, bunServer, "fs", {
          workspaceId: url.searchParams.get("workspaceId")?.trim() || "",
          since: Number.parseInt(url.searchParams.get("since") ?? "0", 10) || 0,
        });
      }
      if (url.pathname === "/ws/agent") {
        return upgradeOrReject(request, bunServer, "agent", {
          workspaceId: url.searchParams.get("workspaceId")?.trim() || "",
        });
      }
      if (url.pathname === "/ws/orchestration") {
        return upgradeOrReject(request, bunServer, "orchestration", {
          workspaceId: url.searchParams.get("workspaceId")?.trim() || "",
        });
      }
      if (url.pathname.startsWith("/ws/terminal/")) {
        return upgradeOrReject(request, bunServer, "terminal", {
          terminalId: url.pathname.slice("/ws/terminal/".length),
        });
      }
      if (url.pathname.startsWith("/ws/browser-debug/")) {
        const rest = url.pathname.slice("/ws/browser-debug/".length);
        const firstSlash = rest.indexOf("/");
        const sessionId = firstSlash === -1 ? rest : rest.slice(0, firstSlash);
        const subPath = firstSlash === -1 ? "" : rest.slice(firstSlash);
        return upgradeOrReject(request, bunServer, "browser-debug", { sessionId, subPath });
      }
      return app.fetch(request);
    },
    websocket: {
      open(ws) {
        attachSocket(ws);
      },
      message(ws, message) {
        ws.data.runtimeSocket?.dispatchMessage(message, typeof message !== "string");
      },
      close(ws) {
        ws.data.runtimeSocket?.dispatchClose();
      },
    },
  });

  console.log(`Cesium Bun server listening on ${server.url}`);

  process.once("beforeExit", () => {
    void flushServerPerfReport("beforeExit").catch((error) => {
      console.warn("[perf] failed to flush report:", error);
    });
    server.stop();
  });
}

startBunServer();
