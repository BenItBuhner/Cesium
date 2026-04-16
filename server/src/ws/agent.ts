import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import {
  readConversationEventsSince,
  readConversationHistoryPage,
  readConversationRecord,
  readConversationSnapshotHead,
  subscribeAgentStoreEvents,
} from "../lib/agents/session-store.js";
import type {
  AgentSocketClientMessage,
  AgentSocketServerMessage,
} from "../lib/agents/types.js";
import { getWorkspaceById } from "../lib/workspace-registry.js";
import { agentRuntimeManager } from "../lib/agents/runtime-manager.js";
import { subscribeToWorkspaceChannel } from "../lib/redis-coordination.js";

type AgentSocketState = {
  workspaceId: string;
  socket: WebSocket;
  subscribedConversationIds: Set<string>;
};

const agentWebSocketServer = new WebSocketServer({ noServer: true });
const workspaceClients = new Map<string, Set<AgentSocketState>>();
const workspaceUnsubscribers = new Map<string, () => Promise<void>>();

function send(socket: WebSocket, message: AgentSocketServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function fanOutWorkspaceEvent(workspaceId: string, event: AgentSocketServerMessage): void {
  const clients = workspaceClients.get(workspaceId);
  if (!clients) {
    return;
  }
  for (const client of clients) {
    if (
      event.type !== "snapshot" &&
      event.type !== "snapshot_head" &&
      "conversationId" in event &&
      event.conversationId &&
      !client.subscribedConversationIds.has(event.conversationId)
    ) {
      continue;
    }
    if (
      event.type === "conversation" &&
      !client.subscribedConversationIds.has(event.conversation.id)
    ) {
      continue;
    }
    send(client.socket, event);
  }
}

async function ensureWorkspaceSubscription(workspaceId: string): Promise<void> {
  if (workspaceUnsubscribers.has(workspaceId)) {
    return;
  }
  const unsubscribe = await subscribeToWorkspaceChannel(workspaceId, (message) => {
    let parsed: AgentSocketServerMessage | null = null;
    try {
      parsed = JSON.parse(message) as AgentSocketServerMessage;
    } catch {
      parsed = null;
    }
    if (!parsed) {
      return;
    }
    fanOutWorkspaceEvent(workspaceId, parsed);
  });
  workspaceUnsubscribers.set(workspaceId, unsubscribe);
}

function addClient(state: AgentSocketState): void {
  const set = workspaceClients.get(state.workspaceId) ?? new Set<AgentSocketState>();
  set.add(state);
  workspaceClients.set(state.workspaceId, set);
  void ensureWorkspaceSubscription(state.workspaceId);
}

function removeClient(state: AgentSocketState): void {
  const set = workspaceClients.get(state.workspaceId);
  if (!set) {
    return;
  }
  set.delete(state);
  if (set.size === 0) {
    workspaceClients.delete(state.workspaceId);
    const unsubscribe = workspaceUnsubscribers.get(state.workspaceId);
    workspaceUnsubscribers.delete(state.workspaceId);
    void unsubscribe?.();
  }
}

subscribeAgentStoreEvents((event) => {
  if (event.type === "event") {
    fanOutWorkspaceEvent(event.workspaceId, {
      type: "event",
      conversationId: event.conversationId,
      event: event.event,
    });
    return;
  }

  if (event.type === "conversation") {
    fanOutWorkspaceEvent(event.conversation.workspaceId, {
      type: "conversation",
      conversation: event.conversation,
    });
  }
});

async function sendSubscriptionData(
  state: AgentSocketState,
  conversationIds: string[],
  sinceByConversationId: Record<string, number>
): Promise<void> {
  const workspace = await getWorkspaceById(state.workspaceId);
  if (!workspace) {
    send(state.socket, {
      type: "error",
      message: `Unknown workspace: ${state.workspaceId}`,
    });
    return;
  }

  for (const conversationId of conversationIds) {
    const since = sinceByConversationId[conversationId] ?? 0;
    if (since > 0) {
      const record = await readConversationRecord(state.workspaceId, conversationId);
      if (!record) {
        send(state.socket, {
          type: "error",
          message: `Unknown conversation: ${conversationId}`,
        });
        continue;
      }
      send(state.socket, {
        type: "conversation",
        conversation: record,
      });
      const replay = await readConversationEventsSince(
        state.workspaceId,
        conversationId,
        since
      );
      for (const event of replay) {
        send(state.socket, {
          type: "event",
          conversationId,
          event,
        });
      }
      continue;
    }

    const head = await readConversationSnapshotHead(state.workspaceId, conversationId);
    if (!head) {
      send(state.socket, {
        type: "error",
        message: `Unknown conversation: ${conversationId}`,
      });
      continue;
    }
    send(state.socket, {
      type: "snapshot_head",
      snapshot: head,
    });
  }
}

export function handleAgentUpgrade(
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

  agentWebSocketServer.handleUpgrade(request, socket, head, (ws) => {
    const state: AgentSocketState = {
      workspaceId,
      socket: ws,
      subscribedConversationIds: new Set(),
    };
    addClient(state);
    send(ws, { type: "connected" });

    ws.on("message", (raw) => {
      let message: AgentSocketClientMessage | null = null;
      try {
        message = JSON.parse(String(raw)) as AgentSocketClientMessage;
      } catch {
        send(ws, { type: "error", message: "Malformed agent socket payload." });
        return;
      }
      if (!message) {
        return;
      }
      if (message.type === "ping") {
        send(ws, { type: "pong" });
        return;
      }
      if (message.type === "request_history") {
        const conversationId =
          typeof message.conversationId === "string" ? message.conversationId.trim() : "";
        const beforeSeq =
          typeof message.beforeSeq === "number" && Number.isFinite(message.beforeSeq)
            ? Math.floor(message.beforeSeq)
            : 0;
        if (!conversationId || beforeSeq <= 0) {
          send(ws, { type: "error", message: "request_history requires conversationId and beforeSeq." });
          return;
        }
        if (!state.subscribedConversationIds.has(conversationId)) {
          send(ws, { type: "error", message: "Subscribe to the conversation before requesting history." });
          return;
        }
        void (async () => {
          const workspace = await getWorkspaceById(state.workspaceId);
          if (!workspace) {
            send(ws, {
              type: "error",
              message: `Unknown workspace: ${state.workspaceId}`,
            });
            return;
          }
          const page = await readConversationHistoryPage(
            state.workspaceId,
            conversationId,
            beforeSeq,
            {
              limitTurns: message.limitTurns,
              limitEvents: message.limitEvents,
            }
          );
          if (!page) {
            send(ws, {
              type: "error",
              message: `Unknown conversation: ${conversationId}`,
            });
            return;
          }
          send(ws, {
            type: "history_page",
            conversationId,
            events: page.events,
            window: page.window,
          });
        })();
        return;
      }
      if (message.type === "subscribe") {
        const ids = Array.isArray(message.conversationIds)
          ? message.conversationIds.filter((value): value is string => typeof value === "string")
          : [];
        void (async () => {
          const workspace = await getWorkspaceById(state.workspaceId);
          if (!workspace) {
            send(ws, {
              type: "error",
              message: `Unknown workspace: ${state.workspaceId}`,
            });
            return;
          }
          const nextIds = new Set(ids);
          const released = [...state.subscribedConversationIds].filter(
            (conversationId) => !nextIds.has(conversationId)
          );
          const retained = ids.filter(
            (conversationId) => !state.subscribedConversationIds.has(conversationId)
          );
          state.subscribedConversationIds = nextIds;
          for (const conversationId of retained) {
            await agentRuntimeManager.retainConversationRuntime(workspace, conversationId);
          }
          for (const conversationId of released) {
            await agentRuntimeManager.releaseConversationRuntime(
              state.workspaceId,
              conversationId
            );
          }
          await sendSubscriptionData(state, ids, message.sinceByConversationId ?? {});
        })();
      }
    });

    ws.on("close", () => {
      for (const conversationId of state.subscribedConversationIds) {
        void agentRuntimeManager.releaseConversationRuntime(
          state.workspaceId,
          conversationId
        );
      }
      removeClient(state);
    });
  });
}
