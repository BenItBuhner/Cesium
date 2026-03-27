import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import chokidar, { type FSWatcher } from "chokidar";
import { WebSocketServer, WebSocket } from "ws";
import {
  getWorkspaceName,
  getWorkspaceRoot,
  isDimmed,
  shouldIgnorePath,
  toRelativePath,
} from "../lib/workspace.js";

type FSEvent =
  | { type: "add"; path: string; isDir: false }
  | { type: "addDir"; path: string; isDir: true }
  | { type: "change"; path: string }
  | { type: "unlink"; path: string; isDir: false }
  | { type: "unlinkDir"; path: string; isDir: true }
  | { type: "ready" }
  | { type: "pong" }
  | { type: "workspace_changed"; root: string; name: string };

const fsWebSocketServer = new WebSocketServer({ noServer: true });
const fsClients = new Set<WebSocket>();
const pendingEvents = new Map<string, NodeJS.Timeout>();
const pendingPayloads = new Map<string, FSEvent>();
let watcher: FSWatcher | null = null;

function broadcast(event: FSEvent): void {
  const payload = JSON.stringify(event);
  for (const client of fsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function debounceBroadcast(key: string, event: FSEvent): void {
  const existing = pendingEvents.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  pendingPayloads.set(key, event);
  pendingEvents.set(
    key,
    setTimeout(() => {
      const payload = pendingPayloads.get(key);
      if (payload) {
        broadcast(payload);
      }
      pendingPayloads.delete(key);
      pendingEvents.delete(key);
    }, 100)
  );
}

function handleFsEvent(type: FSEvent["type"], absolutePath?: string): void {
  if (!absolutePath || type === "ready" || type === "workspace_changed") {
    broadcast({ type } as FSEvent);
    return;
  }

  const relativePath = toRelativePath(absolutePath);
  if (!relativePath || shouldIgnorePath(relativePath)) {
    return;
  }

  const topLevelName = relativePath.split("/")[0] ?? "";
  if (isDimmed(topLevelName)) {
    return;
  }

  const event =
    type === "addDir" || type === "unlinkDir"
      ? { type, path: relativePath, isDir: true }
      : type === "add" || type === "unlink"
        ? { type, path: relativePath, isDir: false }
        : { type, path: relativePath };

  debounceBroadcast(`${type}:${relativePath}`, event as FSEvent);
}

export async function restartWorkspaceWatcher(): Promise<void> {
  await watcher?.close();

  watcher = chokidar.watch(getWorkspaceRoot(), {
    ignored: (watchedPath) => {
      const relativePath = toRelativePath(watchedPath);
      return shouldIgnorePath(relativePath) || isDimmed(relativePath.split("/")[0] ?? "");
    },
    ignoreInitial: true,
    persistent: true,
  });

  watcher
    .on("add", (absolutePath) => handleFsEvent("add", absolutePath))
    .on("addDir", (absolutePath) => handleFsEvent("addDir", absolutePath))
    .on("change", (absolutePath) => handleFsEvent("change", absolutePath))
    .on("unlink", (absolutePath) => handleFsEvent("unlink", absolutePath))
    .on("unlinkDir", (absolutePath) => handleFsEvent("unlinkDir", absolutePath))
    .on("ready", () => broadcast({ type: "ready" }));
}

export async function initializeFileWatcher(): Promise<void> {
  if (!watcher) {
    await restartWorkspaceWatcher();
  }
}

export async function broadcastWorkspaceChanged(): Promise<void> {
  await restartWorkspaceWatcher();
  broadcast({
    type: "workspace_changed",
    root: getWorkspaceRoot(),
    name: getWorkspaceName(),
  });
}

export function handleFsUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  fsWebSocketServer.handleUpgrade(request, socket, head, (ws) => {
    fsClients.add(ws);
    ws.send(
      JSON.stringify({
        type: "workspace_changed",
        root: getWorkspaceRoot(),
        name: getWorkspaceName(),
      } satisfies FSEvent)
    );
    ws.send(JSON.stringify({ type: "ready" } satisfies FSEvent));
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string };
        if (msg?.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" } satisfies FSEvent));
        }
      } catch {
        /* ignore malformed */
      }
    });
    ws.on("close", () => {
      fsClients.delete(ws);
    });
  });
}
