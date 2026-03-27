import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import chokidar, { type FSWatcher } from "chokidar";
import { WebSocketServer, WebSocket } from "ws";
import {
  isDimmed,
  shouldIgnorePath,
  toRelativePath,
} from "../lib/workspace.js";
import { getWorkspaceById } from "../lib/workspace-registry.js";

type SequencedFsEvent =
  | { type: "add"; seq: number; path: string; isDir: false }
  | { type: "addDir"; seq: number; path: string; isDir: true }
  | { type: "change"; seq: number; path: string }
  | { type: "unlink"; seq: number; path: string; isDir: false }
  | { type: "unlinkDir"; seq: number; path: string; isDir: true };

type FsSocketMessage =
  | SequencedFsEvent
  | {
      type: "workspace_snapshot";
      workspaceId: string;
      root: string;
      name: string;
      latestSeq: number;
    }
  | { type: "ready"; latestSeq: number }
  | { type: "resync_required"; latestSeq: number }
  | { type: "pong"; latestSeq: number };

type WorkspaceWatcherRoom = {
  workspaceId: string;
  root: string;
  name: string;
  watcher: FSWatcher;
  clients: Set<WebSocket>;
  pendingEvents: Map<string, NodeJS.Timeout>;
  pendingPayloads: Map<string, Omit<SequencedFsEvent, "seq">>;
  bufferedEvents: SequencedFsEvent[];
  nextSeq: number;
};

const fsWebSocketServer = new WebSocketServer({ noServer: true });
const watcherRooms = new Map<string, WorkspaceWatcherRoom>();
const MAX_BUFFERED_EVENTS = 500;

function getLatestSeq(room: WorkspaceWatcherRoom): number {
  return Math.max(0, room.nextSeq - 1);
}

function sendMessage(ws: WebSocket, message: FsSocketMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(room: WorkspaceWatcherRoom, message: FsSocketMessage): void {
  for (const client of room.clients) {
    sendMessage(client, message);
  }
}

function appendBufferedEvent(room: WorkspaceWatcherRoom, event: SequencedFsEvent): void {
  room.bufferedEvents.push(event);
  while (room.bufferedEvents.length > MAX_BUFFERED_EVENTS) {
    room.bufferedEvents.shift();
  }
}

function emitSequencedEvent(
  room: WorkspaceWatcherRoom,
  event: Omit<SequencedFsEvent, "seq">
): void {
  const nextEvent = {
    ...event,
    seq: room.nextSeq++,
  } as SequencedFsEvent;
  appendBufferedEvent(room, nextEvent);
  broadcast(room, nextEvent);
}

function debounceBroadcast(
  room: WorkspaceWatcherRoom,
  key: string,
  event: Omit<SequencedFsEvent, "seq">
): void {
  const existing = room.pendingEvents.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  room.pendingPayloads.set(key, event);
  room.pendingEvents.set(
    key,
    setTimeout(() => {
      const payload = room.pendingPayloads.get(key);
      if (payload) {
        emitSequencedEvent(room, payload);
      }
      room.pendingPayloads.delete(key);
      room.pendingEvents.delete(key);
    }, 100)
  );
}

function handleFsEvent(
  room: WorkspaceWatcherRoom,
  type: SequencedFsEvent["type"],
  absolutePath?: string
): void {
  if (!absolutePath) {
    return;
  }

  const relativePath = toRelativePath(room.root, absolutePath);
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

  debounceBroadcast(room, `${type}:${relativePath}`, event as Omit<SequencedFsEvent, "seq">);
}

async function createWatcherRoom(workspaceId: string): Promise<WorkspaceWatcherRoom> {
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace: ${workspaceId}`);
  }

  const room: WorkspaceWatcherRoom = {
    workspaceId,
    root: workspace.root,
    name: workspace.name,
    watcher: chokidar.watch(workspace.root, {
      ignored: (watchedPath) => {
        const relativePath = toRelativePath(workspace.root, watchedPath);
        return (
          shouldIgnorePath(relativePath) ||
          isDimmed(relativePath.split("/")[0] ?? "")
        );
      },
      ignoreInitial: true,
      persistent: true,
    }),
    clients: new Set(),
    pendingEvents: new Map(),
    pendingPayloads: new Map(),
    bufferedEvents: [],
    nextSeq: 1,
  };

  room.watcher
    .on("add", (absolutePath) => handleFsEvent(room, "add", absolutePath))
    .on("addDir", (absolutePath) => handleFsEvent(room, "addDir", absolutePath))
    .on("change", (absolutePath) => handleFsEvent(room, "change", absolutePath))
    .on("unlink", (absolutePath) => handleFsEvent(room, "unlink", absolutePath))
    .on("unlinkDir", (absolutePath) => handleFsEvent(room, "unlinkDir", absolutePath));

  watcherRooms.set(workspaceId, room);
  return room;
}

async function getOrCreateWatcherRoom(
  workspaceId: string
): Promise<WorkspaceWatcherRoom> {
  const existing = watcherRooms.get(workspaceId);
  if (existing) {
    return existing;
  }
  return createWatcherRoom(workspaceId);
}

function canReplay(room: WorkspaceWatcherRoom, since: number): boolean {
  if (since <= 0) {
    return true;
  }
  const firstSeq = room.bufferedEvents[0]?.seq ?? getLatestSeq(room);
  return since >= firstSeq - 1;
}

export function handleFsUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  const url = new URL(request.url ?? "/", "http://localhost");
  const workspaceId = url.searchParams.get("workspaceId")?.trim();
  const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10);

  if (!workspaceId) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\nMissing workspaceId");
    socket.destroy();
    return;
  }

  void getOrCreateWatcherRoom(workspaceId)
    .then((room) => {
      fsWebSocketServer.handleUpgrade(request, socket, head, (ws) => {
        room.clients.add(ws);

        sendMessage(ws, {
          type: "workspace_snapshot",
          workspaceId: room.workspaceId,
          root: room.root,
          name: room.name,
          latestSeq: getLatestSeq(room),
        });

        if (Number.isFinite(since) && since < getLatestSeq(room)) {
          if (canReplay(room, since)) {
            for (const event of room.bufferedEvents) {
              if (event.seq > since) {
                sendMessage(ws, event);
              }
            }
          } else {
            sendMessage(ws, {
              type: "resync_required",
              latestSeq: getLatestSeq(room),
            });
          }
        }

        sendMessage(ws, { type: "ready", latestSeq: getLatestSeq(room) });

        ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(String(raw)) as { type?: string };
            if (msg?.type === "ping") {
              sendMessage(ws, { type: "pong", latestSeq: getLatestSeq(room) });
            }
          } catch {
            /* ignore malformed */
          }
        });

        ws.on("close", () => {
          room.clients.delete(ws);
        });
      });
    })
    .catch(() => {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\nUnknown workspace");
      socket.destroy();
    });
}
