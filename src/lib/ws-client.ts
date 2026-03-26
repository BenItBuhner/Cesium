"use client";

export function toWebSocketUrl(url: string): string {
  if (url.startsWith("https://")) {
    return `wss://${url.slice("https://".length)}`;
  }
  if (url.startsWith("http://")) {
    return `ws://${url.slice("http://".length)}`;
  }
  return url;
}

type ConnectionState = "idle" | "connecting" | "open" | "closed" | "reconnecting";

type ListenerMap<T> = {
  open: Set<() => void>;
  close: Set<() => void>;
  error: Set<(error: Event) => void>;
  message: Set<(data: T) => void>;
  state: Set<(state: ConnectionState) => void>;
};

abstract class BaseReconnectSocket<TMessage> {
  protected ws: WebSocket | null = null;
  protected manuallyClosed = false;
  protected reconnectAttempt = 0;
  protected reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  protected readonly listeners: ListenerMap<TMessage> = {
    open: new Set(),
    close: new Set(),
    error: new Set(),
    message: new Set(),
    state: new Set(),
  };
  private state: ConnectionState = "idle";

  constructor(protected readonly url: string) {}

  connect(): void {
    this.manuallyClosed = false;
    this.clearReconnectTimer();
    this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");

    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.configureSocket(ws);
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.clearReconnectTimer();
    this.ws?.close();
    this.ws = null;
    this.setState("closed");
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  protected scheduleReconnect(): void {
    if (this.manuallyClosed) return;
    this.clearReconnectTimer();
    const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.setState("reconnecting");
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  protected configureSocket(ws: WebSocket): void {
    ws.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.setState("open");
      this.listeners.open.forEach((listener) => listener());
    });

    ws.addEventListener("close", () => {
      this.listeners.close.forEach((listener) => listener());
      if (!this.manuallyClosed) {
        this.scheduleReconnect();
        return;
      }
      this.setState("closed");
    });

    ws.addEventListener("error", (event) => {
      this.listeners.error.forEach((listener) => listener(event));
    });
  }

  protected clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  protected setState(state: ConnectionState): void {
    this.state = state;
    this.listeners.state.forEach((listener) => listener(state));
  }

  protected emitMessage(data: TMessage): void {
    this.listeners.message.forEach((listener) => listener(data));
  }

  protected addListener<K extends keyof ListenerMap<TMessage>>(
    event: K,
    listener: ListenerMap<TMessage>[K] extends Set<infer TListener> ? TListener : never
  ): () => void {
    const listeners = this.listeners[event];
    listeners.add(listener as never);
    return () => {
      listeners.delete(listener as never);
    };
  }
}

export class JsonWebSocket<TMessage = unknown> extends BaseReconnectSocket<TMessage> {
  onOpen(listener: () => void): () => void {
    return this.addListener("open", listener);
  }

  onClose(listener: () => void): () => void {
    return this.addListener("close", listener);
  }

  onError(listener: (error: Event) => void): () => void {
    return this.addListener("error", listener);
  }

  onMessage(listener: (data: TMessage) => void): () => void {
    return this.addListener("message", listener);
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    return this.addListener("state", listener);
  }

  send(data: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(data));
  }

  protected override configureSocket(ws: WebSocket): void {
    super.configureSocket(ws);
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      this.emitMessage(JSON.parse(event.data) as TMessage);
    });
  }
}

export class BinaryWebSocket extends BaseReconnectSocket<
  string | ArrayBuffer | { type: string; [key: string]: unknown }
> {
  private readonly encoder = new TextEncoder();

  constructor(url: string) {
    super(url);
  }

  onOpen(listener: () => void): () => void {
    return this.addListener("open", listener);
  }

  onClose(listener: () => void): () => void {
    return this.addListener("close", listener);
  }

  onError(listener: (error: Event) => void): () => void {
    return this.addListener("error", listener);
  }

  onMessage(
    listener: (data: string | ArrayBuffer | { type: string; [key: string]: unknown }) => void
  ): () => void {
    return this.addListener("message", listener);
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    return this.addListener("state", listener);
  }

  sendText(data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(data);
  }

  sendJson(data: Record<string, unknown>): void {
    this.sendText(JSON.stringify(data));
  }

  sendBinary(data: string | ArrayBufferLike | Blob): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (typeof data === "string") {
      this.ws.send(this.encoder.encode(data));
      return;
    }
    this.ws.send(data);
  }

  protected override configureSocket(ws: WebSocket): void {
    super.configureSocket(ws);
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        try {
          this.emitMessage(JSON.parse(event.data) as { type: string; [key: string]: unknown });
        } catch {
          this.emitMessage(event.data);
        }
        return;
      }
      this.emitMessage(event.data as ArrayBuffer);
    });
  }
}
