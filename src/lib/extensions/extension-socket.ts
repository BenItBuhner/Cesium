"use client";

/**
 * Realtime client for the extension runtime.
 *
 * One shared WebSocket per workspace (ref-counted across surfaces + the
 * workspace bridge), designed to stay useful on terrible networks:
 *
 *  - reconnects with the shared exponential backoff, resubscribing every
 *    session with its last seen cursor so no events are lost across drops,
 *  - heartbeats (ping/pong) detect half-open connections and force a
 *    reconnect instead of waiting on TCP timeouts,
 *  - webview -> extension messages get client msgIds, are acked by the
 *    server, and fall back to idempotent HTTP delivery when the socket is
 *    down — retries never double-deliver,
 *  - while the socket is down, an adaptive HTTP polling loop (with jitter)
 *    keeps events flowing so the UI degrades to "slower" instead of "dead".
 */

import { JsonWebSocket } from "@/lib/ws-client";
import {
  buildExtensionsWebSocketUrl,
  deliverExtensionSurfaceSessionMessageClient,
  pushExtensionEditorContext,
  readExtensionSurfaceEvents,
  readWorkspaceExtensionEvents,
  sendExtensionUiEvent,
  sendExtensionUiResponse,
  updateExtensionSurfaceStateClient,
  type ExtensionSurfaceEvent,
  type ExtensionUiClientEvent,
  type ExtensionUiResponse,
  type ExtensionWebviewThemeSnapshot,
  type WorkspaceExtensionEvent,
} from "@/lib/server-api";

export type ExtensionSocketStatus = "connecting" | "open" | "polling";

export type ExtensionEditorContextPayload = {
  uri?: string;
  path?: string;
  language?: string;
  content?: string;
  selectedText?: string;
  selection?: {
    startLineNumber?: number;
    startColumn?: number;
    endLineNumber?: number;
    endColumn?: number;
  };
  version?: number;
  dirty?: boolean;
} | null;

type ServerMessage = {
  type: string;
  sessionId?: string;
  events?: Array<ExtensionSurfaceEvent | WorkspaceExtensionEvent>;
  msgId?: string;
  duplicate?: boolean;
  missingWebview?: boolean;
  message?: string;
  workspaceCursor?: number;
  resyncRequired?: boolean;
  snapshot?: unknown;
  t?: number;
};

type PendingDelivery = {
  msgId: string;
  sessionId: string;
  message: unknown;
  resolve: (result: { ok: boolean; missingWebview: boolean }) => void;
  timer: ReturnType<typeof setTimeout>;
  attempts: number;
};

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const ACK_TIMEOUT_MS = 8_000;
const POLL_BASE_INTERVAL_MS = 1_200;
const POLL_MAX_INTERVAL_MS = 6_000;
const EDITOR_CONTEXT_THROTTLE_MS = 150;

export class ExtensionWorkspaceSocket {
  private readonly socket: JsonWebSocket<ServerMessage>;
  private readonly sessionListeners = new Map<string, Set<(event: ExtensionSurfaceEvent) => void>>();
  private readonly sessionCursors = new Map<string, number>();
  private readonly workspaceListeners = new Set<(event: WorkspaceExtensionEvent) => void>();
  private readonly statusListeners = new Set<(status: ExtensionSocketStatus) => void>();
  private readonly resyncListeners = new Set<() => void>();
  private readonly pendingDeliveries = new Map<string, PendingDelivery>();
  private workspaceCursor = 0;
  private status: ExtensionSocketStatus = "connecting";
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatDeadline: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollInterval = POLL_BASE_INTERVAL_MS;
  private pollInFlight = false;
  private disposed = false;
  private lastThemeKey: string | null = null;
  private editorContextTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEditorContext: {
    context: ExtensionEditorContextPayload;
    reason: "open" | "focus" | "selection" | "edit" | "save" | "close";
  } | null = null;
  refCount = 0;

  constructor(readonly workspaceId: string) {
    this.socket = new JsonWebSocket<ServerMessage>(() =>
      buildExtensionsWebSocketUrl(workspaceId)
    );
    this.socket.onOpen(() => this.handleOpen());
    this.socket.onClose(() => this.handleClose());
    this.socket.onMessage((message) => this.handleMessage(message));
    this.socket.connect();
    this.setStatus("connecting");
  }

  /* ------------------------------------------------------------ */
  /* Lifecycle                                                     */
  /* ------------------------------------------------------------ */

  dispose(): void {
    this.disposed = true;
    this.stopHeartbeat();
    this.stopPolling();
    if (this.editorContextTimer) clearTimeout(this.editorContextTimer);
    for (const pending of this.pendingDeliveries.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, missingWebview: false });
    }
    this.pendingDeliveries.clear();
    this.socket.disconnect();
  }

  private handleOpen(): void {
    this.setStatus("open");
    this.stopPolling();
    this.startHeartbeat();
    this.socket.send({
      type: "hello",
      workspaceCursor: this.workspaceCursor,
      sessions: [...this.sessionListeners.keys()].map((sessionId) => ({
        sessionId,
        cursor: this.sessionCursors.get(sessionId) ?? 0,
      })),
    });
    // Un-acked deliveries are retried over the fresh socket; server-side
    // msgId dedup keeps this safe.
    for (const pending of this.pendingDeliveries.values()) {
      this.socket.send({
        type: "message",
        sessionId: pending.sessionId,
        message: pending.message,
        msgId: pending.msgId,
      });
    }
  }

  private handleClose(): void {
    if (this.disposed) return;
    this.stopHeartbeat();
    this.setStatus("polling");
    this.startPolling();
  }

  private handleMessage(message: ServerMessage): void {
    if (!message || typeof message !== "object") return;
    if (message.type === "pong") {
      if (this.heartbeatDeadline) {
        clearTimeout(this.heartbeatDeadline);
        this.heartbeatDeadline = null;
      }
      return;
    }
    if (message.type === "hello-ack") {
      if (typeof message.workspaceCursor === "number") {
        this.workspaceCursor = Math.max(this.workspaceCursor, message.workspaceCursor);
      }
      if (message.resyncRequired) {
        this.emitResync();
      }
      return;
    }
    if (message.type === "workspace-events" && Array.isArray(message.events)) {
      for (const event of message.events as WorkspaceExtensionEvent[]) {
        if (event.seq > this.workspaceCursor) {
          this.workspaceCursor = event.seq;
        }
        for (const listener of [...this.workspaceListeners]) {
          try {
            listener(event);
          } catch {
            /* listener errors must not break the stream */
          }
        }
      }
      return;
    }
    if (message.type === "session-events" && message.sessionId && Array.isArray(message.events)) {
      const listeners = this.sessionListeners.get(message.sessionId);
      for (const event of message.events as ExtensionSurfaceEvent[]) {
        const cursor = this.sessionCursors.get(message.sessionId) ?? 0;
        if (event.seq <= cursor) continue;
        this.sessionCursors.set(message.sessionId, event.seq);
        if (!listeners) continue;
        for (const listener of [...listeners]) {
          try {
            listener(event);
          } catch {
            /* listener errors must not break the stream */
          }
        }
      }
      return;
    }
    if ((message.type === "ack" || message.type === "nack") && message.msgId) {
      const pending = this.pendingDeliveries.get(message.msgId);
      if (!pending) return;
      if (message.type === "ack") {
        clearTimeout(pending.timer);
        this.pendingDeliveries.delete(message.msgId);
        pending.resolve({ ok: true, missingWebview: message.missingWebview === true });
      } else {
        // Nack: server-side failure; fall back to HTTP delivery.
        clearTimeout(pending.timer);
        this.retryDeliveryOverHttp(pending);
      }
    }
  }

  private setStatus(status: ExtensionSocketStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of [...this.statusListeners]) {
      listener(status);
    }
  }

  getStatus(): ExtensionSocketStatus {
    return this.status;
  }

  private emitResync(): void {
    for (const listener of [...this.resyncListeners]) {
      try {
        listener();
      } catch {
        /* ignore */
      }
    }
  }

  /* ------------------------------------------------------------ */
  /* Heartbeat                                                     */
  /* ------------------------------------------------------------ */

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket.connected) return;
      this.socket.send({ type: "ping", t: Date.now() });
      this.heartbeatDeadline ??= setTimeout(() => {
        this.heartbeatDeadline = null;
        // Half-open connection: force a reconnect instead of hanging.
        this.socket.forceCloseConnection();
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatDeadline) {
      clearTimeout(this.heartbeatDeadline);
      this.heartbeatDeadline = null;
    }
  }

  /* ------------------------------------------------------------ */
  /* Polling fallback                                              */
  /* ------------------------------------------------------------ */

  private startPolling(): void {
    if (this.pollTimer || this.disposed) return;
    this.pollInterval = POLL_BASE_INTERVAL_MS;
    this.schedulePoll(250);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private schedulePoll(delay: number): void {
    if (this.disposed) return;
    const jitter = Math.random() * 0.3 * delay;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollOnce();
    }, delay + jitter);
  }

  private async pollOnce(): Promise<void> {
    if (this.disposed || this.socket.connected || this.pollInFlight) {
      return;
    }
    this.pollInFlight = true;
    let hadEvents = false;
    let hadErrors = false;
    try {
      try {
        const workspaceRead = await readWorkspaceExtensionEvents({
          workspaceId: this.workspaceId,
          cursor: this.workspaceCursor,
        });
        if (workspaceRead.resyncRequired) {
          this.emitResync();
        }
        for (const event of workspaceRead.events) {
          hadEvents = true;
          this.workspaceCursor = Math.max(this.workspaceCursor, event.seq);
          for (const listener of [...this.workspaceListeners]) {
            try {
              listener(event);
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        hadErrors = true;
      }
      for (const [sessionId, listeners] of this.sessionListeners) {
        if (listeners.size === 0) continue;
        try {
          const read = await readExtensionSurfaceEvents({
            workspaceId: this.workspaceId,
            sessionId,
            cursor: this.sessionCursors.get(sessionId) ?? 0,
          });
          for (const event of read.events) {
            hadEvents = true;
            this.sessionCursors.set(sessionId, Math.max(this.sessionCursors.get(sessionId) ?? 0, event.seq));
            for (const listener of [...listeners]) {
              try {
                listener(event);
              } catch {
                /* ignore */
              }
            }
          }
        } catch {
          hadErrors = true;
        }
      }
    } finally {
      this.pollInFlight = false;
    }
    if (this.socket.connected || this.disposed) {
      return;
    }
    // Adaptive interval: fast while events flow, back off when quiet/erroring.
    this.pollInterval = hadEvents
      ? POLL_BASE_INTERVAL_MS
      : Math.min(this.pollInterval * (hadErrors ? 2 : 1.4), POLL_MAX_INTERVAL_MS);
    this.schedulePoll(this.pollInterval);
  }

  /* ------------------------------------------------------------ */
  /* Subscriptions                                                 */
  /* ------------------------------------------------------------ */

  subscribeSession(
    sessionId: string,
    listener: (event: ExtensionSurfaceEvent) => void,
    initialCursor?: number
  ): () => void {
    let listeners = this.sessionListeners.get(sessionId);
    const isNew = !listeners;
    if (!listeners) {
      listeners = new Set();
      this.sessionListeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    if (typeof initialCursor === "number") {
      const current = this.sessionCursors.get(sessionId) ?? 0;
      this.sessionCursors.set(sessionId, Math.max(current, initialCursor));
    }
    if (isNew && this.socket.connected) {
      this.socket.send({
        type: "subscribe",
        sessionId,
        cursor: this.sessionCursors.get(sessionId) ?? 0,
      });
    }
    return () => {
      const set = this.sessionListeners.get(sessionId);
      set?.delete(listener);
      if (set && set.size === 0) {
        this.sessionListeners.delete(sessionId);
        if (this.socket.connected) {
          this.socket.send({ type: "unsubscribe", sessionId });
        }
      }
    };
  }

  subscribeWorkspace(listener: (event: WorkspaceExtensionEvent) => void): () => void {
    this.workspaceListeners.add(listener);
    return () => this.workspaceListeners.delete(listener);
  }

  subscribeStatus(listener: (status: ExtensionSocketStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  subscribeResync(listener: () => void): () => void {
    this.resyncListeners.add(listener);
    return () => this.resyncListeners.delete(listener);
  }

  /* ------------------------------------------------------------ */
  /* Outbound                                                      */
  /* ------------------------------------------------------------ */

  deliverWebviewMessage(
    sessionId: string,
    message: unknown
  ): Promise<{ ok: boolean; missingWebview: boolean }> {
    const msgId = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve) => {
      const pending: PendingDelivery = {
        msgId,
        sessionId,
        message,
        resolve,
        attempts: 0,
        timer: setTimeout(() => this.retryDeliveryOverHttp(pending), ACK_TIMEOUT_MS),
      };
      this.pendingDeliveries.set(msgId, pending);
      if (this.socket.connected) {
        this.socket.send({ type: "message", sessionId, message, msgId });
      } else {
        clearTimeout(pending.timer);
        this.retryDeliveryOverHttp(pending);
      }
    });
  }

  private retryDeliveryOverHttp(pending: PendingDelivery): void {
    if (!this.pendingDeliveries.has(pending.msgId)) return;
    pending.attempts += 1;
    if (pending.attempts > 4) {
      this.pendingDeliveries.delete(pending.msgId);
      pending.resolve({ ok: false, missingWebview: false });
      return;
    }
    void deliverExtensionSurfaceSessionMessageClient({
      workspaceId: this.workspaceId,
      sessionId: pending.sessionId,
      message: pending.message,
      msgId: pending.msgId,
    })
      .then((result) => {
        if (!this.pendingDeliveries.delete(pending.msgId)) return;
        pending.resolve({ ok: true, missingWebview: result.missingWebview === true });
      })
      .catch(() => {
        if (!this.pendingDeliveries.has(pending.msgId)) return;
        pending.timer = setTimeout(
          () => this.retryDeliveryOverHttp(pending),
          Math.min(500 * 2 ** pending.attempts, 8_000)
        );
      });
  }

  sendState(sessionId: string, state: unknown): void {
    if (this.socket.connected) {
      this.socket.send({ type: "state", sessionId, state });
      return;
    }
    void updateExtensionSurfaceStateClient({
      workspaceId: this.workspaceId,
      sessionId,
      state,
    }).catch(() => undefined);
  }

  sendTheme(theme: ExtensionWebviewThemeSnapshot): void {
    const key = JSON.stringify(theme);
    if (key === this.lastThemeKey) return;
    this.lastThemeKey = key;
    if (this.socket.connected) {
      this.socket.send({ type: "theme", theme });
    }
  }

  sendUiResponse(response: ExtensionUiResponse): void {
    if (this.socket.connected) {
      this.socket.send({ type: "ui-response", response });
      return;
    }
    void sendExtensionUiResponse({ workspaceId: this.workspaceId, response }).catch(() => undefined);
  }

  sendUiEvent(event: ExtensionUiClientEvent): void {
    if (this.socket.connected) {
      this.socket.send({ type: "ui-event", event });
      return;
    }
    void sendExtensionUiEvent({ workspaceId: this.workspaceId, event }).catch(() => undefined);
  }

  sendEditorContext(
    context: ExtensionEditorContextPayload,
    reason: "open" | "focus" | "selection" | "edit" | "save" | "close"
  ): void {
    this.pendingEditorContext = { context, reason };
    if (this.editorContextTimer) return;
    this.editorContextTimer = setTimeout(() => {
      this.editorContextTimer = null;
      const payload = this.pendingEditorContext;
      this.pendingEditorContext = null;
      if (!payload) return;
      if (this.socket.connected) {
        this.socket.send({
          type: "editor-context",
          context: payload.context,
          reason: payload.reason,
        });
        return;
      }
      void pushExtensionEditorContext({
        workspaceId: this.workspaceId,
        context: payload.context,
        reason: payload.reason,
      }).catch(() => undefined);
    }, EDITOR_CONTEXT_THROTTLE_MS);
  }
}

const sockets = new Map<string, ExtensionWorkspaceSocket>();

export function acquireExtensionSocket(workspaceId: string): ExtensionWorkspaceSocket {
  let socket = sockets.get(workspaceId);
  if (!socket) {
    socket = new ExtensionWorkspaceSocket(workspaceId);
    sockets.set(workspaceId, socket);
  }
  socket.refCount += 1;
  return socket;
}

export function releaseExtensionSocket(socket: ExtensionWorkspaceSocket): void {
  socket.refCount -= 1;
  if (socket.refCount <= 0) {
    sockets.delete(socket.workspaceId);
    socket.dispose();
  }
}

export function peekExtensionSocket(workspaceId: string): ExtensionWorkspaceSocket | null {
  return sockets.get(workspaceId) ?? null;
}
