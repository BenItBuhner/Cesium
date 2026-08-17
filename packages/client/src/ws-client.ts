"use client";

import { clientLocation } from "./platform";

/**
 * Convert an HTTP(S) origin to a WebSocket origin. Empty / relative `url`
 * means "same-origin" — fall back to the page's own origin so a WebSocket
 * can piggyback on the reverse proxy that already handles `/api/*`.
 */
export function toWebSocketUrl(url: string): string {
  if (url.startsWith("https://")) {
    return `wss://${url.slice("https://".length)}`;
  }
  if (url.startsWith("http://")) {
    return `ws://${url.slice("http://".length)}`;
  }
  const location = clientLocation();
  if ((url === "" || url.startsWith("/")) && location) {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const suffix = url.startsWith("/") ? url : "";
    return `${scheme}//${location.host}${suffix}`;
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
  private mobilePaused = false;
  private mobileLifecycleBound = false;
  private readonly onMobileLifecycle = (event: Event) => {
    const detail = (event as CustomEvent<{ type?: string; state?: string }>).detail;
    if (detail?.type !== "lifecycle") return;
    if (detail.state === "active") {
      this.resumeFromMobileBackground();
      return;
    }
    if (detail.state !== "background" && detail.state !== "inactive") return;
    this.suspendForMobileBackground();
  };
  // The bridge lifecycle message rides a `postMessage` that races the WebView
  // pause and is sometimes dropped; Chromium delivers `visibilitychange`
  // synchronously before pausing the renderer, so it is the reliable signal.
  // Both funnel into the same idempotent suspend/resume.
  private readonly onMobileVisibility = () => {
    if (typeof document === "undefined") return;
    if (document.visibilityState === "hidden") {
      this.suspendForMobileBackground();
      return;
    }
    this.resumeFromMobileBackground();
  };

  /**
   * Backgrounded: stop reconnect attempts (battery), but keep an open socket.
   * The server's protocol-level pings are answered by the network stack even
   * while the renderer is paused, so short backgrounds usually keep the
   * connection alive and resume needs no reconnect at all. If the socket dies
   * while hidden (process frozen, server idle-reap), the close is swallowed
   * quietly and `resumeFromMobileBackground` reconnects.
   */
  private suspendForMobileBackground(): void {
    if (this.mobilePaused) return;
    this.mobilePaused = true;
    this.clearReconnectTimer();
  }

  private resumeFromMobileBackground(): void {
    if (!this.mobilePaused) return;
    this.mobilePaused = false;
    if (this.manuallyClosed) return;
    if (
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    // Fresh backoff: a resume-time reconnect should be immediate, not tail an
    // exponential delay accumulated before the app was backgrounded.
    this.reconnectAttempt = 0;
    this.connect();
  }

  constructor(protected readonly url: string | (() => string)) {}

  private getResolvedUrl(): string {
    return typeof this.url === "function" ? this.url() : this.url;
  }

  connect(): void {
    this.manuallyClosed = false;
    this.bindMobileLifecycle();
    this.clearReconnectTimer();
    if (this.mobilePaused) {
      // Resuming reconnects on its own; opening sockets while backgrounded
      // only burns battery.
      this.setState("closed");
      return;
    }
    if (
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");

    const ws = new WebSocket(this.getResolvedUrl());
    this.ws = ws;
    this.configureSocket(ws);
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.clearReconnectTimer();
    this.ws?.close();
    this.ws = null;
    this.unbindMobileLifecycle();
    this.mobilePaused = false;
    this.setState("closed");
  }

  /** Close the socket without disabling auto-reconnect (e.g. heartbeat failure). */
  forceCloseConnection(): void {
    if (this.manuallyClosed) return;
    this.clearReconnectTimer();
    this.ws?.close();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  protected scheduleReconnect(): void {
    if (this.manuallyClosed || this.mobilePaused) return;
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
      if (this.ws === ws) {
        this.ws = null;
      }
      if (this.mobilePaused) {
        // Expected while backgrounded (frozen process, server idle-reap).
        // Stay quiet — no disconnect notifications, no reconnect churn — and
        // let the resume path reconnect when the app is visible again.
        this.setState("closed");
        return;
      }
      this.listeners.close.forEach((listener) => listener());
      if (!this.manuallyClosed) {
        this.scheduleReconnect();
        return;
      }
      this.setState("closed");
    });

    ws.addEventListener("error", (event) => {
      if (this.mobilePaused) return;
      this.listeners.error.forEach((listener) => listener(event));
    });
  }

  protected clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private bindMobileLifecycle(): void {
    if (this.mobileLifecycleBound || typeof window === "undefined") return;
    const mobileWindow = window as typeof window & {
      ReactNativeWebView?: { postMessage(message: string): void };
    };
    if (!mobileWindow.ReactNativeWebView) return;
    this.mobileLifecycleBound = true;
    this.mobilePaused =
      document.documentElement.classList.contains("opencursor-mobile-idle") ||
      document.visibilityState === "hidden";
    window.addEventListener("cesium:mobile-bridge-message", this.onMobileLifecycle);
    document.addEventListener("visibilitychange", this.onMobileVisibility);
  }

  private unbindMobileLifecycle(): void {
    if (!this.mobileLifecycleBound || typeof window === "undefined") return;
    window.removeEventListener("cesium:mobile-bridge-message", this.onMobileLifecycle);
    document.removeEventListener("visibilitychange", this.onMobileVisibility);
    this.mobileLifecycleBound = false;
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
