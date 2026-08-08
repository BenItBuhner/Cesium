import type { WebSocketLike } from "./transport.js";

export type CesiumSocketState =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

type QueueResolver<T> = (result: IteratorResult<T>) => void;

export type CesiumSocketOptions<TClientMessage> = {
  create(): Promise<WebSocketLike>;
  initialMessage?: TClientMessage;
  reconnect?: boolean;
  maxReconnectDelayMs?: number;
};

/**
 * Runtime-neutral typed WebSocket with reconnect and AsyncIterable support.
 * Node/Bun consumers provide a WebSocket factory through CesiumClient options.
 */
export class CesiumSocket<TClientMessage, TServerMessage>
  implements AsyncIterable<TServerMessage>, AsyncIterator<TServerMessage>
{
  private socket: WebSocketLike | null = null;
  private stateValue: CesiumSocketState = "connecting";
  private manuallyClosed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly messagesQueue: TServerMessage[] = [];
  private readonly queueResolvers: QueueResolver<TServerMessage>[] = [];
  private readonly messageListeners = new Set<(message: TServerMessage) => void>();
  private readonly stateListeners = new Set<(state: CesiumSocketState) => void>();
  private readonly errorListeners = new Set<(error: unknown) => void>();

  constructor(private readonly options: CesiumSocketOptions<TClientMessage>) {
    void this.connect();
  }

  get state(): CesiumSocketState {
    return this.stateValue;
  }

  get connected(): boolean {
    return this.stateValue === "open";
  }

  onMessage(listener: (message: TServerMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onState(listener: (state: CesiumSocketState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.stateValue);
    return () => this.stateListeners.delete(listener);
  }

  onError(listener: (error: unknown) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  send(message: TClientMessage): void {
    if (!this.socket || this.stateValue !== "open") {
      throw new Error("Cesium WebSocket is not open.");
    }
    this.socket.send(JSON.stringify(message));
  }

  close(code = 1000, reason = "Client closed"): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close(code, reason);
    this.socket = null;
    this.setState("closed");
    this.finishIterator();
  }

  [Symbol.asyncIterator](): AsyncIterator<TServerMessage> {
    return this;
  }

  next(): Promise<IteratorResult<TServerMessage>> {
    const message = this.messagesQueue.shift();
    if (message !== undefined) {
      return Promise.resolve({ done: false, value: message });
    }
    if (this.manuallyClosed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => this.queueResolvers.push(resolve));
  }

  return(): Promise<IteratorResult<TServerMessage>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  private async connect(): Promise<void> {
    if (this.manuallyClosed) return;
    this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    let socket: WebSocketLike;
    try {
      socket = await this.options.create();
    } catch (error) {
      this.emitError(error);
      this.scheduleReconnect();
      return;
    }
    if (this.manuallyClosed) {
      socket.close(1000, "Client closed");
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.manuallyClosed) return;
      this.reconnectAttempt = 0;
      this.setState("open");
      if (this.options.initialMessage !== undefined) {
        socket.send(JSON.stringify(this.options.initialMessage));
      }
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || typeof event.data !== "string") return;
      try {
        this.emitMessage(JSON.parse(event.data) as TServerMessage);
      } catch (error) {
        this.emitError(error);
      }
    });
    socket.addEventListener("error", (event) => this.emitError(event));
    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      if (this.manuallyClosed) {
        this.setState("closed");
        this.finishIterator();
        return;
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed || this.options.reconnect === false) {
      this.setState("closed");
      this.finishIterator();
      return;
    }
    const maxDelay = this.options.maxReconnectDelayMs ?? 30_000;
    const delay = Math.min(maxDelay, 1_000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.setState("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private setState(state: CesiumSocketState): void {
    if (state === this.stateValue) return;
    this.stateValue = state;
    for (const listener of this.stateListeners) listener(state);
  }

  private emitMessage(message: TServerMessage): void {
    for (const listener of this.messageListeners) listener(message);
    const resolver = this.queueResolvers.shift();
    if (resolver) {
      resolver({ done: false, value: message });
    } else {
      this.messagesQueue.push(message);
    }
  }

  private emitError(error: unknown): void {
    for (const listener of this.errorListeners) listener(error);
  }

  private finishIterator(): void {
    for (const resolve of this.queueResolvers.splice(0)) {
      resolve({ done: true, value: undefined });
    }
  }
}
