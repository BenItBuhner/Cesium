import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { type RuntimeSocket, wrapNodeWebSocket } from "./runtime-socket.js";
import {
  readOrchestrationBoardSnapshot,
  subscribeOrchestrationStoreEvents,
} from "../lib/orchestration/store.js";

type OrchestrationSocketClientMessage =
  | { type: "ping" }
  | { type: "subscribe"; boardIds: string[] };

type OrchestrationSocketServerMessage =
  | { type: "connected" }
  | { type: "pong" }
  | { type: "error"; message: string; boardId?: string }
  | {
      type: "snapshot";
      boardId: string;
      snapshot: Awaited<ReturnType<typeof readOrchestrationBoardSnapshot>>;
    }
  | {
      type: "board";
      boardId: string;
      snapshot: NonNullable<Awaited<ReturnType<typeof readOrchestrationBoardSnapshot>>>;
    }
  | { type: "board_deleted"; boardId: string; workspaceId: string };

type OrchestrationSocketState = {
  workspaceId: string;
  socket: RuntimeSocket;
  subscribedBoardIds: Set<string>;
};

const orchestrationWebSocketServer = new WebSocketServer({ noServer: true });
const workspaceClients = new Map<string, Set<OrchestrationSocketState>>();

function send(
  socket: RuntimeSocket,
  message: OrchestrationSocketServerMessage
): void {
  if (socket.isOpen) {
    socket.send(JSON.stringify(message));
  }
}

function addClient(state: OrchestrationSocketState): void {
  const clients = workspaceClients.get(state.workspaceId) ?? new Set();
  clients.add(state);
  workspaceClients.set(state.workspaceId, clients);
}

function removeClient(state: OrchestrationSocketState): void {
  const clients = workspaceClients.get(state.workspaceId);
  if (!clients) {
    return;
  }
  clients.delete(state);
  if (clients.size === 0) {
    workspaceClients.delete(state.workspaceId);
  }
}

subscribeOrchestrationStoreEvents((event) => {
  const clients = workspaceClients.get(event.workspaceId);
  if (!clients) {
    return;
  }
  for (const client of clients) {
    if (!client.subscribedBoardIds.has(event.boardId)) {
      continue;
    }
    if (event.type === "board") {
      send(client.socket, {
        type: "board",
        boardId: event.boardId,
        snapshot: event.snapshot,
      });
      continue;
    }
    send(client.socket, {
      type: "board_deleted",
      boardId: event.boardId,
      workspaceId: event.workspaceId,
    });
  }
});

export function attachOrchestrationSocket(
  ws: RuntimeSocket,
  workspaceId: string
): void {
  if (!workspaceId) {
    ws.close(1008, "Missing workspaceId");
    return;
  }

  const state: OrchestrationSocketState = {
    workspaceId,
    socket: ws,
    subscribedBoardIds: new Set(),
  };
  addClient(state);
  send(ws, { type: "connected" });

  ws.onMessage((raw) => {
    let message: OrchestrationSocketClientMessage | null = null;
    try {
      message = JSON.parse(String(raw)) as OrchestrationSocketClientMessage;
    } catch {
      send(ws, {
        type: "error",
        message: "Malformed orchestration socket payload.",
      });
      return;
    }
    if (message.type === "ping") {
      send(ws, { type: "pong" });
      return;
    }
    if (message.type === "subscribe") {
      const ids = Array.isArray(message.boardIds)
        ? message.boardIds.filter((value): value is string => typeof value === "string")
        : [];
      state.subscribedBoardIds = new Set(ids);
      void Promise.all(
        ids.map(async (boardId) => {
          const snapshot = await readOrchestrationBoardSnapshot(boardId);
          if (!snapshot || snapshot.board.workspaceId !== workspaceId) {
            send(ws, {
              type: "error",
              boardId,
              message: `Unknown orchestration board: ${boardId}`,
            });
            return;
          }
          send(ws, { type: "snapshot", boardId, snapshot });
        })
      ).catch((error) => {
        send(ws, {
          type: "error",
          message:
            error instanceof Error
              ? `Subscribe failed: ${error.message}`
              : "Subscribe failed.",
        });
      });
    }
  });

  ws.onClose(() => {
    removeClient(state);
  });
}

export function handleOrchestrationUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  const url = new URL(request.url ?? "/", "http://localhost");
  const workspaceId = url.searchParams.get("workspaceId")?.trim();
  if (!workspaceId) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\nMissing workspaceId");
    socket.destroy();
    return;
  }

  orchestrationWebSocketServer.handleUpgrade(request, socket, head, (ws) => {
    attachOrchestrationSocket(wrapNodeWebSocket(ws), workspaceId);
  });
}
