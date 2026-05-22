import type {
  AgentConversationRecord,
  AgentSocketServerMessage,
  AgentStoredEvent,
} from "../../../../src/lib/agent-types";
import {
  deriveMobileAgentProjection,
  type MobileAgentProjection,
} from "../../../../src/lib/mobile-agent-projection";

export type AgentStatusServiceConfig = {
  serverBaseUrl: string;
  workspaceId: string | null;
  conversationId: string | null;
  authToken?: string | null;
};

export type AgentStatusServiceOptions = {
  onProjection(projection: MobileAgentProjection | null): void;
  onConnectionState?(state: "idle" | "connecting" | "open" | "closed" | "reconnecting"): void;
};

export class AgentStatusService {
  private config: AgentStatusServiceConfig | null = null;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private conversation: AgentConversationRecord | null = null;
  private events: AgentStoredEvent[] = [];
  private previousProjection: MobileAgentProjection | null = null;
  private manuallyClosed = false;

  constructor(private readonly options: AgentStatusServiceOptions) {}

  updateConfig(config: AgentStatusServiceConfig) {
    const previousKey = this.configKey(this.config);
    const nextKey = this.configKey(config);
    this.config = config;
    if (!config.workspaceId || !config.conversationId) {
      this.close("idle");
      this.resetProjection();
      return;
    }
    if (previousKey !== nextKey) {
      this.events = [];
      this.conversation = null;
      this.previousProjection = null;
      this.reconnectAttempt = 0;
      this.connect();
    } else if (this.ws?.readyState === WebSocket.OPEN) {
      this.subscribe();
    }
  }

  connect() {
    if (!this.config?.workspaceId || !this.config.conversationId) return;
    this.manuallyClosed = false;
    this.clearReconnectTimer();
    this.ws?.close();
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
      if (this.manuallyClosed) {
        this.options.onConnectionState?.("closed");
        return;
      }
      this.scheduleReconnect();
    };
  }

  close(nextState: "idle" | "closed" = "closed") {
    this.manuallyClosed = true;
    this.clearReconnectTimer();
    this.ws?.close();
    this.ws = null;
    this.options.onConnectionState?.(nextState);
  }

  getLastEventSeq() {
    return this.events.reduce((max, event) => Math.max(max, event.seq), 0);
  }

  private handleMessage(message: AgentSocketServerMessage) {
    if (!this.config?.conversationId) return;
    switch (message.type) {
      case "conversation":
      case "conversation_upserted":
        if (message.conversation.id === this.config.conversationId) {
          this.conversation = message.conversation;
          this.emitProjection();
        }
        return;
      case "snapshot":
      case "snapshot_head":
        if (message.snapshot.conversation.id === this.config.conversationId) {
          this.conversation = message.snapshot.conversation;
          this.events = dedupeEvents([...this.events, ...message.snapshot.events]);
          this.emitProjection();
        }
        return;
      case "event":
        if (message.conversationId === this.config.conversationId) {
          this.events = dedupeEvents([...this.events, message.event]);
          this.emitProjection();
        }
        return;
      case "event_batch":
        if (message.conversationId === this.config.conversationId) {
          this.events = dedupeEvents([...this.events, ...message.events]);
          this.emitProjection();
        }
        return;
      case "conversation_deleted":
        if (message.conversationId === this.config.conversationId) {
          this.resetProjection();
        }
        return;
      default:
        return;
    }
  }

  private emitProjection() {
    if (!this.conversation) return;
    const projection = deriveMobileAgentProjection(this.conversation, this.events, {
      previous: this.previousProjection,
    });
    this.previousProjection = projection;
    this.options.onProjection(projection);
  }

  private resetProjection() {
    this.conversation = null;
    this.events = [];
    this.previousProjection = null;
    this.options.onProjection(null);
  }

  private subscribe() {
    if (!this.config?.conversationId || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: "subscribe",
        conversationIds: [this.config.conversationId],
        sinceByConversationId: {
          [this.config.conversationId]: this.getLastEventSeq(),
        },
      })
    );
  }

  private scheduleReconnect() {
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

  private configKey(config: AgentStatusServiceConfig | null) {
    if (!config) return "";
    return [config.serverBaseUrl, config.workspaceId, config.conversationId, config.authToken ?? ""].join("\0");
  }
}

function dedupeEvents(events: AgentStoredEvent[]) {
  const bySeq = new Map<number, AgentStoredEvent>();
  for (const event of events) {
    bySeq.set(event.seq, event);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
