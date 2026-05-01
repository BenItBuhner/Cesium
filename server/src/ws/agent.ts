import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { type RuntimeSocket, wrapNodeWebSocket } from "./runtime-socket.js";
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
  AgentStoredEvent,
} from "../lib/agents/types.js";
import { getWorkspaceById } from "../lib/workspace-registry.js";
import { agentRuntimeManager } from "../lib/agents/runtime-manager.js";
import { measureServerPerf } from "../lib/perf.js";

type AgentSocketState = {
  workspaceId: string;
  socket: RuntimeSocket;
  subscribedConversationIds: Set<string>;
  subscribeChain: Promise<void>;
};

const agentWebSocketServer = new WebSocketServer({ noServer: true });
const workspaceClients = new Map<string, Set<AgentSocketState>>();
const MAX_EVENT_BATCH_EVENTS = 100;

/** Buffers live agent events for one I/O turn so a burst of row writes = one `event_batch` frame. */
const eventBroadcastPending = new Map<string, AgentStoredEvent[]>();
function keyForEventWorkspaceConversation(
  workspaceId: string,
  conversationId: string
): string {
  return `${workspaceId}\t${conversationId}`;
}
function pushLiveAgentEventForBatch(
  workspaceId: string,
  conversationId: string,
  event: AgentStoredEvent
): void {
  const k = keyForEventWorkspaceConversation(workspaceId, conversationId);
  const q = eventBroadcastPending.get(k) ?? [];
  const first = q.length === 0;
  q.push(event);
  eventBroadcastPending.set(k, q);
  if (first) {
    setImmediate(() => {
      const batch = eventBroadcastPending.get(k);
      eventBroadcastPending.delete(k);
      if (!batch || batch.length === 0) {
        return;
      }
      const clients = workspaceClients.get(workspaceId);
      if (!clients) {
        return;
      }
      for (const client of clients) {
        if (!client.subscribedConversationIds.has(conversationId)) {
          continue;
        }
        for (let i = 0; i < batch.length; i += MAX_EVENT_BATCH_EVENTS) {
          send(client.socket, {
            type: "event_batch",
            workspaceId,
            conversationId,
            events: batch.slice(i, i + MAX_EVENT_BATCH_EVENTS),
          });
        }
      }
    });
  }
}

function send(socket: RuntimeSocket, message: AgentSocketServerMessage): void {
  if (socket.isOpen) {
    socket.send(JSON.stringify(message));
  }
}

function addClient(state: AgentSocketState): void {
  const set = workspaceClients.get(state.workspaceId) ?? new Set<AgentSocketState>();
  set.add(state);
  workspaceClients.set(state.workspaceId, set);
}

function removeClient(state: AgentSocketState): void {
  const set = workspaceClients.get(state.workspaceId);
  if (!set) {
    return;
  }
  set.delete(state);
  if (set.size === 0) {
    workspaceClients.delete(state.workspaceId);
  }
}

subscribeAgentStoreEvents((event) => {
  if (event.type === "event") {
    pushLiveAgentEventForBatch(
      event.workspaceId,
      event.conversationId,
      event.event
    );
    return;
  }

  if (event.type === "conversation") {
    const clients = workspaceClients.get(event.conversation.workspaceId);
    if (!clients) {
      return;
    }
    // Two separate fan-outs:
    //   * `conversation`           - full record, only to clients who have
    //                                actively subscribed (chat panel path).
    //   * `conversation_upserted`  - broadcast to every workspace client so
    //                                the conversation rail / sidebar can
    //                                refresh without the old `visibilitychange`
    //                                refetch dance.
    for (const client of clients) {
      if (client.subscribedConversationIds.has(event.conversation.id)) {
        send(client.socket, {
          type: "conversation",
          conversation: event.conversation,
        });
      }
      send(client.socket, {
        type: "conversation_upserted",
        conversation: event.conversation,
      });
    }
    return;
  }

  if (event.type === "conversation_deleted") {
    const clients = workspaceClients.get(event.workspaceId);
    if (!clients) {
      return;
    }
    for (const client of clients) {
      // Drop it from the in-memory subscription set eagerly; the client will
      // receive its own notice to purge local state.
      client.subscribedConversationIds.delete(event.conversationId);
      send(client.socket, {
        type: "conversation_deleted",
        conversationId: event.conversationId,
        workspaceId: event.workspaceId,
      });
    }
  }
});

async function sendSubscriptionData(
  state: AgentSocketState,
  conversationIds: string[],
  sinceByConversationId: Record<string, number>
): Promise<void> {
  return measureServerPerf(
    "ws.agent.subscribeData",
    () => sendSubscriptionDataUnmeasured(state, conversationIds, sinceByConversationId),
    { workspaceId: state.workspaceId, conversations: conversationIds.length }
  );
}

async function sendSubscriptionDataUnmeasured(
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
      if (replay.length > 0) {
        send(state.socket, {
          type: "event_batch",
          workspaceId: state.workspaceId,
          conversationId,
          events: replay,
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

export function attachAgentSocket(ws: RuntimeSocket, workspaceId: string): void {
  if (!workspaceId) {
    ws.close(1008, "Missing workspaceId");
    return;
  }

    const state: AgentSocketState = {
      workspaceId,
      socket: ws,
      subscribedConversationIds: new Set(),
      subscribeChain: Promise.resolve(),
    };
    addClient(state);
    send(ws, { type: "connected" });

    ws.onMessage((raw) => {
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
          try {
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
                conversationId,
                op: "request_history",
              });
              return;
            }
            send(ws, {
              type: "history_page",
              workspaceId: state.workspaceId,
              conversationId,
              events: page.events,
              window: page.window,
            });
          } catch (error) {
            console.error("[ws/agent] request_history failed:", error);
            send(ws, {
              type: "error",
              message:
                error instanceof Error
                  ? `History fetch failed: ${error.message}`
                  : "History fetch failed.",
              conversationId,
              op: "request_history",
            });
          }
        })();
        return;
      }
      if (message.type === "subscribe") {
        const ids = Array.isArray(message.conversationIds)
          ? message.conversationIds.filter((value): value is string => typeof value === "string")
          : [];
        const sinceByConversationId = message.sinceByConversationId ?? {};
        state.subscribeChain = state.subscribeChain
          .catch(() => undefined)
          .then(async () => {
            try {
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
              for (const conversationId of released) {
                await agentRuntimeManager.releaseConversationRuntime(
                  state.workspaceId,
                  conversationId
                );
              }
              await sendSubscriptionData(state, ids, sinceByConversationId);
              for (const conversationId of retained) {
                void agentRuntimeManager
                  .retainConversationRuntime(workspace, conversationId)
                  .catch((error) => {
                    console.warn("[ws/agent] runtime retain failed:", error);
                  });
              }
            } catch (error) {
              console.error("[ws/agent] subscribe failed:", error);
              send(ws, {
                type: "error",
                message:
                  error instanceof Error
                    ? `Subscribe failed: ${error.message}`
                    : "Subscribe failed.",
              });
            }
          });
      }
    });

    ws.onClose(() => {
      for (const conversationId of state.subscribedConversationIds) {
        void agentRuntimeManager.releaseConversationRuntime(
          state.workspaceId,
          conversationId
        );
      }
      removeClient(state);
    });
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
    attachAgentSocket(wrapNodeWebSocket(ws), workspaceId);
  });
}
