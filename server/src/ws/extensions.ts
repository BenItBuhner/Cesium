/**
 * /ws/extensions — realtime push channel for the VS Code extension runtime.
 *
 * One socket per (client, workspace). Replaces the old 1s HTTP polling loop:
 * surface events (webview messages/html/theme/tree) and workspace events
 * (notifications, quick inputs, status bar, output, diagnostics, ...) are
 * pushed the moment they occur.
 *
 * Designed for poor networks:
 *  - every event stream is cursor-sequenced; clients resume with their last
 *    cursor after a reconnect and receive exactly the missed events,
 *  - if the backlog no longer covers the cursor the server says `resync` and
 *    the client refetches materialized snapshots over HTTP,
 *  - webview -> extension messages carry client-generated `msgId`s that are
 *    acked; retries are deduplicated server-side, so at-least-once delivery
 *    over flaky links never double-fires extension handlers,
 *  - ping/pong heartbeats let both ends detect dead connections quickly.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { type RuntimeSocket, wrapNodeWebSocket } from "./runtime-socket.js";
import { getWorkspaceById, type WorkspaceRecord } from "../lib/workspace-registry.js";
import {
  deliverExtensionSurfaceSessionMessage,
  readExtensionSurfaceEvents,
  subscribeExtensionSurfaceEvents,
  updateExtensionSurfaceState,
  updateExtensionSurfaceTheme,
  listExtensionSurfaceSessions,
  type ExtensionSurfaceEvent,
  type ExtensionWebviewThemeSnapshot,
} from "../lib/extensions/surface-sessions.js";
import {
  getWorkspaceExtensionUiSnapshot,
  readWorkspaceExtensionEvents,
  resolveWorkspaceUiRequest,
  forwardWorkspaceUiEvent,
  subscribeWorkspaceExtensionEvents,
  type WorkspaceExtensionEvent,
} from "../lib/extensions/host-events.js";
import { updateHostEditorContext } from "../lib/extensions/host-runtime.js";
import type {
  EditorCommandContext,
  EditorContextSyncReason,
  UiClientEvent,
  UiResponsePayload,
} from "../lib/extensions/host-protocol.js";

type ClientMessage =
  | {
      type: "hello";
      workspaceCursor?: number;
      sessions?: Array<{ sessionId: string; cursor?: number }>;
    }
  | { type: "subscribe"; sessionId: string; cursor?: number }
  | { type: "unsubscribe"; sessionId: string }
  | { type: "message"; sessionId: string; message: unknown; msgId?: string }
  | { type: "state"; sessionId: string; state: unknown }
  | { type: "theme"; theme: unknown }
  | { type: "ui-response"; response: UiResponsePayload }
  | { type: "ui-event"; event: UiClientEvent }
  | {
      type: "editor-context";
      context: EditorCommandContext | null;
      reason: EditorContextSyncReason;
    }
  | { type: "ping"; t?: number };

const extensionsWebSocketServer = new WebSocketServer({ noServer: true });

const EVENT_FLUSH_MS = 5;

function asThemeSnapshot(value: unknown): ExtensionWebviewThemeSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { colorScheme?: unknown; variables?: unknown };
  if (raw.colorScheme !== "dark" && raw.colorScheme !== "light") return undefined;
  if (!raw.variables || typeof raw.variables !== "object" || Array.isArray(raw.variables)) {
    return undefined;
  }
  const variables: Record<string, string> = {};
  for (const [key, color] of Object.entries(raw.variables)) {
    if (typeof color === "string") variables[key] = color;
  }
  return { colorScheme: raw.colorScheme, variables };
}

export function attachExtensionsSocket(ws: RuntimeSocket, workspaceId: string): void {
  if (!workspaceId) {
    ws.close(1008, "Missing workspaceId");
    return;
  }

  let workspace: WorkspaceRecord | null = null;
  const subscribedSessions = new Set<string>();
  let workspaceSubscribed = false;

  let pendingSessionEvents = new Map<string, ExtensionSurfaceEvent[]>();
  let pendingWorkspaceEvents: WorkspaceExtensionEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const send = (payload: unknown): void => {
    if (!ws.isOpen) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* dropped frame; client resumes via cursor */
    }
  };

  const flush = (): void => {
    flushTimer = undefined;
    if (pendingWorkspaceEvents.length > 0) {
      const events = pendingWorkspaceEvents;
      pendingWorkspaceEvents = [];
      send({ type: "workspace-events", events });
    }
    if (pendingSessionEvents.size > 0) {
      const bySession = pendingSessionEvents;
      pendingSessionEvents = new Map();
      for (const [sessionId, events] of bySession) {
        send({ type: "session-events", sessionId, events });
      }
    }
  };

  const scheduleFlush = (): void => {
    if (!flushTimer) {
      flushTimer = setTimeout(flush, EVENT_FLUSH_MS);
    }
  };

  const unsubscribeSurface = subscribeExtensionSurfaceEvents((eventWorkspaceId, event) => {
    if (eventWorkspaceId !== workspaceId) return;
    if (!subscribedSessions.has(event.sessionId)) {
      // Newly created sessions (e.g. extension-opened panels) matter even
      // before an explicit subscribe: surface creation via workspace events.
      return;
    }
    const queue = pendingSessionEvents.get(event.sessionId);
    if (queue) {
      queue.push(event);
    } else {
      pendingSessionEvents.set(event.sessionId, [event]);
    }
    scheduleFlush();
  });

  const unsubscribeWorkspace = subscribeWorkspaceExtensionEvents(workspaceId, (event) => {
    if (!workspaceSubscribed) return;
    pendingWorkspaceEvents.push(event);
    scheduleFlush();
  });

  void getWorkspaceById(workspaceId)
    .then((record) => {
      if (!record) {
        ws.close(1008, "Unknown workspace");
        return;
      }
      workspace = record;
      send({ type: "ready" });
    })
    .catch(() => ws.close(1011, "Failed to load workspace"));

  ws.onMessage((raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      return;
    }
    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      return;
    }
    void handleClientMessage(message).catch((error) => {
      send({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });

  async function handleClientMessage(message: ClientMessage): Promise<void> {
    if (message.type === "ping") {
      send({ type: "pong", t: message.t ?? Date.now() });
      return;
    }
    if (message.type === "hello") {
      workspaceSubscribed = true;
      const workspaceRead = readWorkspaceExtensionEvents({
        workspaceId,
        cursor: message.workspaceCursor,
      });
      send({
        type: "hello-ack",
        workspaceCursor: workspaceRead.cursor,
        resyncRequired: workspaceRead.resyncRequired,
        snapshot: getWorkspaceExtensionUiSnapshot(workspaceId),
        sessions: listExtensionSurfaceSessions(workspaceId).map((session) => ({
          sessionId: session.sessionId,
          extensionId: session.extensionId,
          surfaceId: session.surfaceId,
          title: session.title,
          kind: session.kind,
          htmlVersion: session.htmlVersion,
          isPanel: session.isPanel,
          isTree: session.isTree,
        })),
      });
      if (!workspaceRead.resyncRequired && workspaceRead.events.length > 0) {
        send({ type: "workspace-events", events: workspaceRead.events });
      }
      for (const subscription of message.sessions ?? []) {
        subscribeSession(subscription.sessionId, subscription.cursor);
      }
      return;
    }
    if (message.type === "subscribe") {
      subscribeSession(message.sessionId, message.cursor);
      return;
    }
    if (message.type === "unsubscribe") {
      subscribedSessions.delete(message.sessionId);
      return;
    }
    if (message.type === "message") {
      if (!workspace) throw new Error("Workspace not ready.");
      try {
        const result = await deliverExtensionSurfaceSessionMessage({
          workspace,
          sessionId: message.sessionId,
          message: message.message,
          msgId: message.msgId,
        });
        send({
          type: "ack",
          msgId: message.msgId,
          sessionId: message.sessionId,
          duplicate: result.duplicate,
          missingWebview: result.missingWebview,
        });
      } catch (error) {
        send({
          type: "nack",
          msgId: message.msgId,
          sessionId: message.sessionId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (message.type === "state") {
      await updateExtensionSurfaceState({
        workspaceId,
        sessionId: message.sessionId,
        state: message.state,
      }).catch(() => undefined);
      return;
    }
    if (message.type === "theme") {
      if (!workspace) return;
      const theme = asThemeSnapshot(message.theme);
      if (!theme) return;
      for (const session of listExtensionSurfaceSessions(workspaceId)) {
        await updateExtensionSurfaceTheme({
          workspace,
          sessionId: session.sessionId,
          theme,
        }).catch(() => undefined);
      }
      return;
    }
    if (message.type === "ui-response") {
      if (!message.response || typeof message.response.requestId !== "string") return;
      await resolveWorkspaceUiRequest({ workspaceId, response: message.response });
      return;
    }
    if (message.type === "ui-event") {
      if (!message.event || typeof message.event.requestId !== "string") return;
      await forwardWorkspaceUiEvent({ workspaceId, event: message.event });
      return;
    }
    if (message.type === "editor-context") {
      updateHostEditorContext({
        workspaceId,
        context: message.context ?? null,
        reason: message.reason ?? "focus",
      });
      return;
    }
  }

  function subscribeSession(sessionId: string, cursor?: number): void {
    if (typeof sessionId !== "string" || !sessionId.trim()) return;
    subscribedSessions.add(sessionId);
    const backlog = readExtensionSurfaceEvents({
      workspaceId,
      sessionId,
      cursor: Number.isFinite(cursor) ? Number(cursor) : 0,
    });
    if (backlog.events.length > 0) {
      send({ type: "session-events", sessionId, events: backlog.events });
    }
    send({ type: "subscribed", sessionId, cursor: backlog.cursor });
  }

  ws.onClose(() => {
    unsubscribeSurface();
    unsubscribeWorkspace();
    if (flushTimer) clearTimeout(flushTimer);
  });
  ws.onError(() => {
    /* close handler performs cleanup */
  });
}

export function handleExtensionsUpgrade(
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
  extensionsWebSocketServer.handleUpgrade(request, socket, head, (ws) => {
    attachExtensionsSocket(wrapNodeWebSocket(ws), workspaceId);
  });
}
