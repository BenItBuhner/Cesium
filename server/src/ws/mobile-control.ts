import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import {
  registerMobileControlDevice,
  resolveMobileControlInvocation,
  type MobileControlCapability,
  type MobileControlDeviceInfo,
} from "../lib/mcp/builtin-mobile-tools.js";
import { refreshWorkspaceMcpMirror } from "../lib/mcp/connection-manager.js";
import { touchMcpCatalogRevision } from "../lib/mcp/server-store.js";
import { getWorkspaceById } from "../lib/workspace-registry.js";
import { type RuntimeSocket, wrapNodeWebSocket } from "./runtime-socket.js";

type RegisterMessage = {
  type: "register";
  device?: Partial<MobileControlDeviceInfo>;
  capabilities?: unknown[];
};

type ResultMessage = {
  type: "result";
  requestId?: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
};

type MobileClientMessage = RegisterMessage | ResultMessage | { type: "ping" };

const mobileWebSocketServer = new WebSocketServer({ noServer: true });
const CAPABILITIES = new Set<MobileControlCapability>([
  "device_info",
  "open_apps",
  "screen_capture",
  "ui_automation",
  "private_display",
  "device_settings",
]);

function send(socket: RuntimeSocket, message: unknown): void {
  if (socket.isOpen) socket.send(JSON.stringify(message));
}

function refreshCatalog(workspaceId: string): void {
  void (async () => {
    const workspace = await getWorkspaceById(workspaceId);
    if (!workspace) return;
    await touchMcpCatalogRevision(workspaceId);
    await refreshWorkspaceMcpMirror({
      workspaceId,
      workspaceRoot: workspace.root,
    });
  })().catch((error) => {
    console.warn("[ws/mobile-control] MCP catalog refresh failed:", error);
  });
}

function parseRegistration(
  message: RegisterMessage
): { device: MobileControlDeviceInfo; capabilities: MobileControlCapability[] } | null {
  const id = typeof message.device?.id === "string" ? message.device.id.trim() : "";
  const name = typeof message.device?.name === "string" ? message.device.name.trim() : "";
  const apiLevel =
    typeof message.device?.apiLevel === "number" && Number.isFinite(message.device.apiLevel)
      ? Math.floor(message.device.apiLevel)
      : 0;
  const appVersion =
    typeof message.device?.appVersion === "string" ? message.device.appVersion.trim() : "";
  if (!id || !name || apiLevel <= 0 || !appVersion || message.device?.platform !== "android") {
    return null;
  }
  const capabilities = (message.capabilities ?? []).filter(
    (value): value is MobileControlCapability =>
      typeof value === "string" && CAPABILITIES.has(value as MobileControlCapability)
  );
  return {
    device: { id, name, platform: "android", apiLevel, appVersion },
    capabilities: [...new Set(capabilities)],
  };
}

export function attachMobileControlSocket(socket: RuntimeSocket, workspaceId: string): void {
  if (!workspaceId) {
    socket.close(1008, "Missing workspaceId");
    return;
  }
  let deviceId: string | null = null;
  let unregister: (() => void) | null = null;
  send(socket, { type: "connected", protocolVersion: 1 });

  socket.onMessage((raw, isBinary) => {
    if (isBinary) {
      send(socket, { type: "error", message: "Binary mobile-control frames are not supported." });
      return;
    }
    let message: MobileClientMessage;
    try {
      message = JSON.parse(String(raw)) as MobileClientMessage;
    } catch {
      send(socket, { type: "error", message: "Malformed mobile-control payload." });
      return;
    }
    if (message.type === "ping") {
      send(socket, { type: "pong" });
      return;
    }
    if (message.type === "register") {
      const parsed = parseRegistration(message);
      if (!parsed) {
        send(socket, { type: "error", message: "Invalid Android device registration." });
        return;
      }
      unregister?.();
      deviceId = parsed.device.id;
      unregister = registerMobileControlDevice({
        workspaceId,
        socket,
        device: parsed.device,
        capabilities: parsed.capabilities,
      });
      send(socket, {
        type: "registered",
        deviceId,
        capabilities: parsed.capabilities,
      });
      refreshCatalog(workspaceId);
      return;
    }
    if (message.type === "result") {
      if (!deviceId || typeof message.requestId !== "string" || typeof message.ok !== "boolean") {
        send(socket, { type: "error", message: "Invalid mobile-control result." });
        return;
      }
      const accepted = resolveMobileControlInvocation({
        workspaceId,
        deviceId,
        requestId: message.requestId,
        ok: message.ok,
        result: message.result,
        error: message.error,
      });
      if (!accepted) {
        send(socket, {
          type: "error",
          message: `Unknown or expired mobile-control request: ${message.requestId}`,
        });
      }
    }
  });

  socket.onClose(() => {
    unregister?.();
    if (deviceId) refreshCatalog(workspaceId);
  });
  socket.onError(() => {
    unregister?.();
  });
}

export function handleMobileControlUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  const url = new URL(request.url ?? "/", "http://localhost");
  const workspaceId = url.searchParams.get("workspaceId")?.trim() ?? "";
  if (!workspaceId) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\nMissing workspaceId");
    socket.destroy();
    return;
  }
  mobileWebSocketServer.handleUpgrade(request, socket, head, (ws) => {
    attachMobileControlSocket(wrapNodeWebSocket(ws), workspaceId);
  });
}
