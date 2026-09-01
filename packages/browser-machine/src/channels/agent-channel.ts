/**
 * Virtual `/ws/agent` channel implementing the exact
 * `AgentSocketClientMessage` / `AgentSocketServerMessage` protocol from
 * `@cesium/core` against the browser conversation store.
 */
import type {
  AgentSocketClientMessage,
  AgentSocketServerMessage,
} from "@cesium/core";
import type { EngineSocketChannel, EngineSocketContext } from "../sockets";
import type { AgentStoreEvent, ConversationStore } from "../stores/conversations";

const MAX_EVENT_BATCH_EVENTS = 100;

type ClientState = {
  workspaceId: string;
  context: EngineSocketContext;
  subscribed: Set<string>;
};

export class AgentChannelHub {
  private readonly clients = new Set<ClientState>();

  constructor(private readonly conversations: ConversationStore) {
    this.conversations.subscribe((event) => this.onStoreEvent(event));
  }

  private send(state: ClientState, message: AgentSocketServerMessage): void {
    state.context.send(message);
  }

  private onStoreEvent(event: AgentStoreEvent): void {
    if (event.type === "event") {
      for (const state of this.clients) {
        if (!state.subscribed.has(event.conversationId)) continue;
        this.send(state, {
          type: "event_batch",
          workspaceId: event.workspaceId,
          conversationId: event.conversationId,
          events: [event.event],
        });
      }
      return;
    }
    if (event.type === "conversation") {
      for (const state of this.clients) {
        if (state.subscribed.has(event.conversation.id)) {
          this.send(state, { type: "conversation", conversation: event.conversation });
        }
        this.send(state, {
          type: "conversation_upserted",
          conversation: event.conversation,
        });
      }
      return;
    }
    for (const state of this.clients) {
      state.subscribed.delete(event.conversationId);
      this.send(state, {
        type: "conversation_deleted",
        conversationId: event.conversationId,
        workspaceId: event.workspaceId,
      });
    }
  }

  createChannel(url: URL, context: EngineSocketContext): EngineSocketChannel | null {
    const workspaceId = url.searchParams.get("workspaceId")?.trim();
    if (!workspaceId) return null;
    const state: ClientState = { workspaceId, context, subscribed: new Set() };
    this.clients.add(state);
    this.send(state, { type: "connected" });

    return {
      onClientMessage: (raw) => {
        let message: AgentSocketClientMessage | null = null;
        try {
          message = JSON.parse(raw) as AgentSocketClientMessage;
        } catch {
          this.send(state, { type: "error", message: "Malformed agent socket payload." });
          return;
        }
        if (!message) return;
        if (message.type === "ping") {
          this.send(state, { type: "pong" });
          return;
        }
        if (message.type === "subscribe") {
          const ids = Array.isArray(message.conversationIds)
            ? message.conversationIds.filter((value): value is string => typeof value === "string")
            : [];
          const sinceByConversationId = message.sinceByConversationId ?? {};
          state.subscribed = new Set(ids);
          void (async () => {
            for (const conversationId of ids) {
              const since = sinceByConversationId[conversationId] ?? 0;
              if (since > 0) {
                const record = await this.conversations.get(workspaceId, conversationId);
                if (!record) {
                  this.send(state, {
                    type: "error",
                    message: `Unknown conversation: ${conversationId}`,
                  });
                  continue;
                }
                this.send(state, { type: "conversation", conversation: record });
                const replay = await this.conversations.readEventsSince(conversationId, since);
                if (replay.length > 0) {
                  for (let i = 0; i < replay.length; i += MAX_EVENT_BATCH_EVENTS) {
                    this.send(state, {
                      type: "event_batch",
                      workspaceId,
                      conversationId,
                      events: replay.slice(i, i + MAX_EVENT_BATCH_EVENTS),
                    });
                  }
                }
                continue;
              }
              const head = await this.conversations.readSnapshotHead(workspaceId, conversationId);
              if (!head) {
                this.send(state, {
                  type: "error",
                  message: `Unknown conversation: ${conversationId}`,
                });
                continue;
              }
              this.send(state, { type: "snapshot_head", snapshot: head });
            }
          })();
          return;
        }
        if (message.type === "request_events_since") {
          const conversationId = message.conversationId?.trim() ?? "";
          const sinceSeq =
            typeof message.sinceSeq === "number" && Number.isFinite(message.sinceSeq)
              ? Math.max(0, Math.floor(message.sinceSeq))
              : -1;
          if (!conversationId || sinceSeq < 0) {
            this.send(state, {
              type: "error",
              message: "request_events_since requires conversationId and sinceSeq.",
            });
            return;
          }
          if (!state.subscribed.has(conversationId)) {
            this.send(state, {
              type: "error",
              message: "Subscribe to the conversation before requesting a delta.",
            });
            return;
          }
          void (async () => {
            try {
              const replay = await this.conversations.readEventsSince(conversationId, sinceSeq);
              for (let i = 0; i < replay.length; i += MAX_EVENT_BATCH_EVENTS) {
                this.send(state, {
                  type: "event_batch",
                  workspaceId,
                  conversationId,
                  events: replay.slice(i, i + MAX_EVENT_BATCH_EVENTS),
                });
              }
            } catch (error) {
              this.send(state, {
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
          const conversationId = message.conversationId?.trim() ?? "";
          const beforeSeq =
            typeof message.beforeSeq === "number" && Number.isFinite(message.beforeSeq)
              ? Math.floor(message.beforeSeq)
              : 0;
          if (!conversationId || beforeSeq <= 0) {
            this.send(state, {
              type: "error",
              message: "request_history requires conversationId and beforeSeq.",
            });
            return;
          }
          if (!state.subscribed.has(conversationId)) {
            this.send(state, {
              type: "error",
              message: "Subscribe to the conversation before requesting history.",
            });
            return;
          }
          void (async () => {
            try {
              const page = await this.conversations.readHistoryPage(conversationId, beforeSeq, {
                limitTurns: message.limitTurns,
                limitEvents: message.limitEvents,
              });
              if (!page) {
                this.send(state, {
                  type: "error",
                  message: `Unknown conversation: ${conversationId}`,
                  conversationId,
                  op: "request_history",
                });
                return;
              }
              this.send(state, {
                type: "history_page",
                workspaceId,
                conversationId,
                events: page.events,
                window: page.window,
              });
            } catch (error) {
              this.send(state, {
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
        }
      },
      onClose: () => {
        this.clients.delete(state);
      },
    };
  }
}
