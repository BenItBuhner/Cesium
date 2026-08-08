import type {
  AgentConversationRecord,
  AgentSocketServerMessage,
  AgentStoredEvent,
  MobileAgentProjection,
} from "@cesium/core";
import {
  deriveMobileAgentProjection,
} from "@cesium/core";

export type AgentStatusServiceConfig = {
  serverBaseUrl: string;
  workspaceId: string | null;
  /** Every conversation to track (focused + all with active agent runs). */
  conversationIds: string[];
  authToken?: string | null;
};

export type AgentStatusServiceOptions = {
  onProjection(projection: MobileAgentProjection): void;
  onConversationRemoved?(conversationId: string): void;
  onConnectionState?(state: "idle" | "connecting" | "open" | "closed" | "reconnecting"): void;
};

type TrackedConversation = {
  conversation: AgentConversationRecord | null;
  events: AgentStoredEvent[];
  previousProjection: MobileAgentProjection | null;
};

/**
 * Background companion to the web workbench: keeps one agent socket open and
 * subscribed to every tracked conversation so each active agent's live
 * notification stays current while the WebView is idle.
 */
export class AgentStatusService {
  private config: AgentStatusServiceConfig | null = null;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private tracked = new Map<string, TrackedConversation>();
  private manuallyClosed = false;
  private connectionEnabled = false;

  constructor(private readonly options: AgentStatusServiceOptions) {}

  updateConfig(config: AgentStatusServiceConfig) {
    const previousBaseKey = this.baseKey(this.config);
    const nextBaseKey = this.baseKey(config);
    const previousIds = this.config?.conversationIds ?? [];
    this.config = config;
    if (!config.workspaceId || config.conversationIds.length === 0) {
      this.close("idle");
      this.tracked.clear();
      return;
    }
    if (previousBaseKey !== nextBaseKey) {
      this.tracked.clear();
      this.reconnectAttempt = 0;
      this.close("idle");
      if (this.connectionEnabled) {
        this.connect();
      }
      return;
    }
    const nextIds = new Set(config.conversationIds);
    for (const id of previousIds) {
      if (!nextIds.has(id)) {
        this.tracked.delete(id);
      }
    }
    if (this.connectionEnabled) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.subscribe();
      } else {
        this.connect();
      }
    }
  }

  connect() {
    if (
      !this.connectionEnabled ||
      !this.config?.workspaceId ||
      this.config.conversationIds.length === 0 ||
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    this.manuallyClosed = false;
    this.clearReconnectTimer();
    this.options.onConnectionState?.(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    const ws = new WebSocket(this.buildUrl(this.config));
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.options.onConnectionState?.("open");
      this.subscribe();
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      this.handleMessage(JSON.parse(event.data) as AgentSocketServerMessage);
    };
    ws.onerror = () => {
      this.options.onConnectionState?.("closed");
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.manuallyClosed) {
        this.options.onConnectionState?.("closed");
        return;
      }
      this.scheduleReconnect();
    };
  }

  setConnectionEnabled(enabled: boolean) {
    if (this.connectionEnabled === enabled) return;
    this.connectionEnabled = enabled;
    if (enabled) {
      this.connect();
      return;
    }
    this.close("idle");
  }

  close(nextState: "idle" | "closed" = "closed") {
    this.manuallyClosed = true;
    this.clearReconnectTimer();
    this.ws?.close();
    this.ws = null;
    this.options.onConnectionState?.(nextState);
  }

  getLastEventSeq(conversationId: string) {
    const events = this.tracked.get(conversationId)?.events ?? [];
    return events.reduce((max, event) => Math.max(max, event.seq), 0);
  }

  private isTracked(conversationId: string): boolean {
    return this.config?.conversationIds.includes(conversationId) ?? false;
  }

  private entryFor(conversationId: string): TrackedConversation {
    let entry = this.tracked.get(conversationId);
    if (!entry) {
      entry = { conversation: null, events: [], previousProjection: null };
      this.tracked.set(conversationId, entry);
    }
    return entry;
  }

  private handleMessage(message: AgentSocketServerMessage) {
    if (!this.config) return;
    switch (message.type) {
      case "conversation":
      case "conversation_upserted":
        if (this.isTracked(message.conversation.id)) {
          this.entryFor(message.conversation.id).conversation = message.conversation;
          this.emitProjection(message.conversation.id);
        }
        return;
      case "snapshot":
      case "snapshot_head":
        if (this.isTracked(message.snapshot.conversation.id)) {
          const entry = this.entryFor(message.snapshot.conversation.id);
          entry.conversation = message.snapshot.conversation;
          entry.events = mergeEvents(entry.events, message.snapshot.events);
          this.emitProjection(message.snapshot.conversation.id);
        }
        return;
      case "event":
        if (this.isTracked(message.conversationId)) {
          const entry = this.entryFor(message.conversationId);
          entry.events = mergeEvents(entry.events, [message.event]);
          this.emitProjection(message.conversationId);
        }
        return;
      case "event_batch":
        if (this.isTracked(message.conversationId)) {
          const entry = this.entryFor(message.conversationId);
          entry.events = mergeEvents(entry.events, message.events);
          this.emitProjection(message.conversationId);
        }
        return;
      case "conversation_deleted":
        if (this.isTracked(message.conversationId)) {
          this.tracked.delete(message.conversationId);
          this.options.onConversationRemoved?.(message.conversationId);
        }
        return;
      default:
        return;
    }
  }

  private emitProjection(conversationId: string) {
    const entry = this.tracked.get(conversationId);
    if (!entry?.conversation) return;
    const projection = deriveMobileAgentProjection(entry.conversation, entry.events, {
      previous: entry.previousProjection,
    });
    entry.previousProjection = projection;
    this.options.onProjection(projection);
  }

  private subscribe() {
    if (
      !this.config ||
      this.config.conversationIds.length === 0 ||
      this.ws?.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    this.ws.send(
      JSON.stringify({
        type: "subscribe",
        conversationIds: this.config.conversationIds,
        sinceByConversationId: Object.fromEntries(
          this.config.conversationIds.map((conversationId) => [
            conversationId,
            this.getLastEventSeq(conversationId),
          ])
        ),
      })
    );
  }

  private scheduleReconnect() {
    if (!this.connectionEnabled) return;
    this.clearReconnectTimer();
    this.reconnectAttempt += 1;
    this.options.onConnectionState?.("reconnecting");
    const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private buildUrl(config: AgentStatusServiceConfig) {
    const base = config.serverBaseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    const params = new URLSearchParams({ workspaceId: config.workspaceId ?? "" });
    if (config.authToken) {
      params.set("access_token", config.authToken);
    }
    return `${base.replace(/\/+$/, "")}/ws/agent?${params.toString()}`;
  }

  private baseKey(config: AgentStatusServiceConfig | null) {
    if (!config) return "";
    return [config.serverBaseUrl, config.workspaceId, config.authToken ?? ""].join("\0");
  }
}

export function mergeEvents(
  existing: AgentStoredEvent[],
  incoming: AgentStoredEvent[]
): AgentStoredEvent[] {
  if (incoming.length === 0) return existing;
  const lastSeq = existing.at(-1)?.seq ?? 0;
  if (
    incoming.every(
      (event, index) =>
        event.seq > lastSeq &&
        (index === 0 || event.seq > (incoming[index - 1]?.seq ?? lastSeq))
    )
  ) {
    return [...existing, ...incoming];
  }
  const bySeq = new Map<number, AgentStoredEvent>();
  for (const event of existing) {
    bySeq.set(event.seq, event);
  }
  for (const event of incoming) {
    bySeq.set(event.seq, event);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
