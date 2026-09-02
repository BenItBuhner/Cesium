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
  /**
   * Conversations whose live `event_batch` frames were dropped for this
   * socket under backpressure, mapped to the highest dropped seq. Flushed as
   * tiny non-droppable `events_dropped` markers so the client knows to pull a
   * delta instead of silently rendering a transcript with a hole.
   */
  droppedThroughSeqByConversationId: Map<string, number>;
  dropMarkerFlushTimer: ReturnType<typeof setTimeout> | null;
};

// Node/desktop fallback path (Bun.serve configures its own compression).
// Agent frames are repetitive JSON that deflates 5-10x; the threshold keeps
// tiny control frames uncompressed and no-context-takeover keeps per-socket
// memory flat with thousands of connected clients.
const agentWebSocketServer = new WebSocketServer({
  noServer: true,
  perMessageDeflate:
    process.env.NODE_WS_PERMESSAGE_DEFLATE === "0"
      ? false
      : {
          threshold: 1_024,
          serverNoContextTakeover: true,
          clientNoContextTakeover: true,
          zlibDeflateOptions: { level: 3 },
        },
});
const workspaceClients = new Map<string, Set<AgentSocketState>>();
const MAX_EVENT_BATCH_EVENTS = 100;
const MAX_SOCKET_BUFFERED_BYTES = 2 * 1024 * 1024;
/** Coalesce per-conversation drop markers so a sustained burst of dropped frames costs one tiny frame, not hundreds. */
const DROP_MARKER_FLUSH_DELAY_MS = 300;

/**
 * Latest event seq observed on the in-process fan-out per conversation.
 * Piggybacked onto heartbeat `pong` frames so a client on a lossy link can
 * detect that its local log is behind even when every droppable frame (and
 * every record push) was lost. Purely in-memory: absent entries simply omit
 * the conversation from the pong, which the client treats as "no signal".
 */
const latestSeqByConversationKey = new Map<string, number>();

/** Buffers live agent events for one I/O turn so a burst of row writes = one `event_batch` frame. */
const eventBroadcastPending = new Map<string, AgentStoredEvent[]>();
const conversationUpsertPending = new Map<string, Map<string, AgentSocketServerMessage & { type: "conversation_upserted" }>>();
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
  if (event.seq > (latestSeqByConversationKey.get(k) ?? 0)) {
    latestSeqByConversationKey.set(k, event.seq);
  }
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
      const chunks: { serialized: string; lastSeq: number }[] = [];
      for (let i = 0; i < batch.length; i += MAX_EVENT_BATCH_EVENTS) {
        const events = batch.slice(i, i + MAX_EVENT_BATCH_EVENTS);
        chunks.push({
          serialized: JSON.stringify({
            type: "event_batch",
            workspaceId,
            conversationId,
            events,
          } satisfies AgentSocketServerMessage),
          lastSeq: events.reduce((max, e) => Math.max(max, e.seq), 0),
        });
      }
      for (const client of clients) {
        if (!client.subscribedConversationIds.has(conversationId)) {
          continue;
        }
        for (const chunk of chunks) {
          const delivered = sendSerialized(client.socket, chunk.serialized, {
            droppable: true,
          });
          if (!delivered) {
            recordDroppedEvents(client, conversationId, chunk.lastSeq);
          }
        }
      }
    });
  }
}

/**
 * A live frame was dropped for a backpressured socket. Remember the highest
 * dropped seq and schedule one coalesced `events_dropped` marker per
 * conversation - a few dozen bytes queued behind the congestion - so the
 * client deterministically learns about the hole instead of depending on a
 * later frame happening to expose the gap.
 */
function recordDroppedEvents(
  client: AgentSocketState,
  conversationId: string,
  throughSeq: number
): void {
  const prior = client.droppedThroughSeqByConversationId.get(conversationId) ?? 0;
  if (throughSeq > prior) {
    client.droppedThroughSeqByConversationId.set(conversationId, throughSeq);
  }
  if (client.dropMarkerFlushTimer != null) {
    return;
  }
  client.dropMarkerFlushTimer = setTimeout(() => {
    client.dropMarkerFlushTimer = null;
    flushDropMarkers(client);
  }, DROP_MARKER_FLUSH_DELAY_MS);
  client.dropMarkerFlushTimer.unref?.();
}

function flushDropMarkers(client: AgentSocketState): void {
  const pending = client.droppedThroughSeqByConversationId;
  if (pending.size === 0 || !client.socket.isOpen) {
    pending.clear();
    return;
  }
  for (const [conversationId, throughSeq] of pending) {
    if (!client.subscribedConversationIds.has(conversationId)) {
      continue;
    }
    send(client.socket, {
      type: "events_dropped",
      workspaceId: client.workspaceId,
      conversationId,
      throughSeq,
    });
  }
  pending.clear();
}

function pushConversationUpsertForBatch(
  workspaceId: string,
  message: AgentSocketServerMessage & { type: "conversation_upserted" }
): void {
  const pending = conversationUpsertPending.get(workspaceId) ?? new Map();
  const first = pending.size === 0;
  pending.set(message.conversation.id, message);
  conversationUpsertPending.set(workspaceId, pending);
  if (!first) {
    return;
  }
  setTimeout(() => {
    const batch = conversationUpsertPending.get(workspaceId);
    conversationUpsertPending.delete(workspaceId);
    if (!batch || workspaceClients.size === 0) {
      return;
    }
    const serialized = [...batch.values()].map((queued) => JSON.stringify(queued));
    // Record pushes go to EVERY client, not just the conversation's own
    // workspace: the conversation rail is cross-workspace, and pushing spares
    // it from polling full conversation lists to keep other workspaces live.
    for (const clients of workspaceClients.values()) {
      for (const client of clients) {
        for (const frame of serialized) {
          sendSerialized(client.socket, frame, { droppable: true });
        }
      }
    }
  }, 100);
}

/**
 * Direct frames are NEVER dropped for backpressure. This deliberately
 * includes recovery `event_batch` replays (subscribe cursors,
 * `request_events_since`): dropping the heal path leaves a lossy client with
 * a permanent transcript hole it can do nothing about. Only the live
 * broadcast fan-out opts into droppability - and it records the drop so a
 * marker frame tells the client to pull a delta.
 */
function send(socket: RuntimeSocket, message: AgentSocketServerMessage): void {
  if (!socket.isOpen) {
    return;
  }
  socket.send(JSON.stringify(message));
}

/**
 * Broadcast path: the frame is serialized ONCE and the same string goes to
 * every client. With N clients and hundreds of running agents, per-client
 * JSON.stringify of identical frames was pure CPU burn on the event loop.
 * Droppable frames (stream batches, coalesced record pushes) are skipped for
 * backpressured sockets. Returns whether the frame was actually written so
 * callers can record the drop and notify the client.
 */
function sendSerialized(
  socket: RuntimeSocket,
  serialized: string,
  options: { droppable: boolean }
): boolean {
  if (!socket.isOpen) {
    return false;
  }
  if (options.droppable && (socket.bufferedAmount ?? 0) > MAX_SOCKET_BUFFERED_BYTES) {
    return false;
  }
  socket.send(serialized);
  return true;
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
    const seqKey = keyForEventWorkspaceConversation(
      event.conversation.workspaceId,
      event.conversation.id
    );
    if (event.conversation.lastEventSeq > (latestSeqByConversationKey.get(seqKey) ?? 0)) {
      latestSeqByConversationKey.set(seqKey, event.conversation.lastEventSeq);
    }
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
    let serializedConversation: string | null = null;
    for (const client of clients) {
      if (client.subscribedConversationIds.has(event.conversation.id)) {
        serializedConversation ??= JSON.stringify({
          type: "conversation",
          conversation: event.conversation,
        } satisfies AgentSocketServerMessage);
        sendSerialized(client.socket, serializedConversation, { droppable: false });
      }
    }
    pushConversationUpsertForBatch(event.conversation.workspaceId, {
      type: "conversation_upserted",
      conversation: event.conversation,
    });
    return;
  }

  if (event.type === "conversation_deleted") {
    const deletedKey = keyForEventWorkspaceConversation(
      event.workspaceId,
      event.conversationId
    );
    eventBroadcastPending.delete(deletedKey);
    latestSeqByConversationKey.delete(deletedKey);
    const pendingUpserts = conversationUpsertPending.get(event.workspaceId);
    pendingUpserts?.delete(event.conversationId);
    if (pendingUpserts?.size === 0) {
      conversationUpsertPending.delete(event.workspaceId);
    }
    // Deletions broadcast to every client (rare, tiny frames) so the
    // cross-workspace rail drops the row without waiting for a backstop poll.
    const serialized = JSON.stringify({
      type: "conversation_deleted",
      conversationId: event.conversationId,
      workspaceId: event.workspaceId,
    } satisfies AgentSocketServerMessage);
    for (const clients of workspaceClients.values()) {
      for (const client of clients) {
        // Drop it from the in-memory subscription set eagerly; the client will
        // receive its own notice to purge local state.
        client.subscribedConversationIds.delete(event.conversationId);
        client.droppedThroughSeqByConversationId.delete(event.conversationId);
        sendSerialized(client.socket, serialized, { droppable: false });
      }
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
    // Whatever a pending drop marker covered is about to be superseded by the
    // cursor replay / snapshot below.
    state.droppedThroughSeqByConversationId.delete(conversationId);
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
      // Chunked so a long-gap resume doesn't serialize one multi-megabyte
      // frame; never droppable - this IS the reconnect heal path.
      for (let i = 0; i < replay.length; i += MAX_EVENT_BATCH_EVENTS) {
        send(state.socket, {
          type: "event_batch",
          workspaceId: state.workspaceId,
          conversationId,
          events: replay.slice(i, i + MAX_EVENT_BATCH_EVENTS),
        });
      }
      // Same completion contract as request_events_since: the client can
      // treat seqs still missing in (since, throughSeq] as deleted rows and
      // knows its resume cursor has been fully served.
      send(state.socket, {
        type: "events_delta_done",
        workspaceId: state.workspaceId,
        conversationId,
        sinceSeq: since,
        throughSeq: Math.max(
          replay.at(-1)?.seq ?? 0,
          record.lastEventSeq,
          since
        ),
      });
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
      droppedThroughSeqByConversationId: new Map(),
      dropMarkerFlushTimer: null,
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
        // Heartbeat doubles as a consistency probe: report the latest known
        // seq for each subscribed conversation so a client that lost every
        // droppable frame still discovers exactly how far behind it is.
        let latestSeqByConversationId: Record<string, number> | undefined;
        for (const conversationId of state.subscribedConversationIds) {
          const latest = latestSeqByConversationKey.get(
            keyForEventWorkspaceConversation(state.workspaceId, conversationId)
          );
          if (latest == null) {
            continue;
          }
          latestSeqByConversationId ??= {};
          latestSeqByConversationId[conversationId] = latest;
        }
        send(ws, { type: "pong", latestSeqByConversationId });
        return;
      }
      if (message.type === "request_events_since") {
        const conversationId =
          typeof message.conversationId === "string" ? message.conversationId.trim() : "";
        const sinceSeq =
          typeof message.sinceSeq === "number" && Number.isFinite(message.sinceSeq)
            ? Math.max(0, Math.floor(message.sinceSeq))
            : -1;
        if (!conversationId || sinceSeq < 0) {
          send(ws, {
            type: "error",
            message: "request_events_since requires conversationId and sinceSeq.",
          });
          return;
        }
        if (!state.subscribedConversationIds.has(conversationId)) {
          send(ws, {
            type: "error",
            message: "Subscribe to the conversation before requesting a delta.",
          });
          return;
        }
        void (async () => {
          try {
            const replay = await readConversationEventsSince(
              state.workspaceId,
              conversationId,
              sinceSeq
            );
            // Recovery deltas are never dropped for backpressure - the client
            // asked precisely because earlier droppable frames were lost.
            for (let i = 0; i < replay.length; i += MAX_EVENT_BATCH_EVENTS) {
              send(ws, {
                type: "event_batch",
                workspaceId: state.workspaceId,
                conversationId,
                events: replay.slice(i, i + MAX_EVENT_BATCH_EVENTS),
              });
            }
            // The pending drop marker (if any) is now stale: everything it
            // covered was just replayed.
            state.droppedThroughSeqByConversationId.delete(conversationId);
            // throughSeq must never overstate what this replay actually read:
            // claiming coverage past the read snapshot would make the client
            // treat a concurrently-appended (real) event as deleted. The
            // replay tail is the only authoritative bound here.
            send(ws, {
              type: "events_delta_done",
              workspaceId: state.workspaceId,
              conversationId,
              sinceSeq,
              throughSeq: Math.max(replay.at(-1)?.seq ?? 0, sinceSeq),
            });
          } catch (error) {
            console.error("[ws/agent] request_events_since failed:", error);
            send(ws, {
              type: "error",
              message:
                error instanceof Error
                  ? `Delta fetch failed: ${error.message}`
                  : "Delta fetch failed.",
              conversationId,
              op: "request_events_since",
            });
          }
        })();
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
      if (state.dropMarkerFlushTimer != null) {
        clearTimeout(state.dropMarkerFlushTimer);
        state.dropMarkerFlushTimer = null;
      }
      state.droppedThroughSeqByConversationId.clear();
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
