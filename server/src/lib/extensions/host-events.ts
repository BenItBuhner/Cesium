/**
 * Workspace-level extension event hub.
 *
 * Aggregates unsolicited extension-host events (notifications, quick inputs,
 * status bar items, output channels, diagnostics, context keys, tree refreshes,
 * document opens, ...) into:
 *
 *  1. a cursor-resumable event log per workspace (lossy-connection friendly:
 *     clients resume from their last seq and detect gaps), and
 *  2. materialized state snapshots so late/reconnecting clients can render the
 *     current world without replaying history.
 *
 * Both the WebSocket push channel and the HTTP polling fallback read from here.
 */
import { getStorage } from "../../storage/runtime.js";
import {
  onExtensionHostEvent,
  onExtensionHostLifecycle,
  notifyHostConfigChanged,
  sendUiResponseToHost,
  sendUiEventToHost,
} from "./host-runtime.js";
import type {
  HostChildEvent,
  SerializedDiagnostic,
  SerializedLanguageRegistration,
  SerializedStatusBarItem,
  UiClientEvent,
  UiRequestPayload,
  UiResponsePayload,
} from "./host-protocol.js";

export type WorkspaceExtensionEvent = {
  seq: number;
  ts: number;
  type: string;
  payload: unknown;
};

export type WorkspaceExtensionEventListener = (event: WorkspaceExtensionEvent) => void;

type OutputChannelState = {
  extensionId: string;
  channel: string;
  content: string;
};

type WorkspaceExtensionState = {
  workspaceId: string;
  seq: number;
  events: WorkspaceExtensionEvent[];
  listeners: Set<WorkspaceExtensionEventListener>;
  statusBarItems: Map<string, SerializedStatusBarItem>;
  contextKeys: Map<string, unknown>;
  outputChannels: Map<string, OutputChannelState>;
  diagnostics: Map<string, Map<string, SerializedDiagnostic[]>>;
  uiRequests: Map<string, UiRequestPayload>;
  languageRegistrations: SerializedLanguageRegistration[];
  hostErrors: Array<{ ts: number; error: string }>;
};

const MAX_EVENT_BACKLOG = 2_000;
const MAX_OUTPUT_CHANNEL_BYTES = 512 * 1024;
const MAX_HOST_ERRORS = 20;

const workspaceStates = new Map<string, WorkspaceExtensionState>();

function ensureState(workspaceId: string): WorkspaceExtensionState {
  let state = workspaceStates.get(workspaceId);
  if (!state) {
    state = {
      workspaceId,
      seq: 0,
      events: [],
      listeners: new Set(),
      statusBarItems: new Map(),
      contextKeys: new Map(),
      outputChannels: new Map(),
      diagnostics: new Map(),
      uiRequests: new Map(),
      languageRegistrations: [],
      hostErrors: [],
    };
    workspaceStates.set(workspaceId, state);
  }
  return state;
}

export function logWorkspaceExtensionEvent(
  workspaceId: string,
  type: string,
  payload: unknown
): WorkspaceExtensionEvent {
  const state = ensureState(workspaceId);
  state.seq += 1;
  const event: WorkspaceExtensionEvent = { seq: state.seq, ts: Date.now(), type, payload };
  state.events.push(event);
  if (state.events.length > MAX_EVENT_BACKLOG) {
    state.events.splice(0, state.events.length - MAX_EVENT_BACKLOG);
  }
  for (const listener of [...state.listeners]) {
    try {
      listener(event);
    } catch (error) {
      console.warn("[extensions] workspace event listener failed:", error);
    }
  }
  return event;
}

export function subscribeWorkspaceExtensionEvents(
  workspaceId: string,
  listener: WorkspaceExtensionEventListener
): () => void {
  const state = ensureState(workspaceId);
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

export function readWorkspaceExtensionEvents(input: {
  workspaceId: string;
  cursor?: number;
}): { events: WorkspaceExtensionEvent[]; cursor: number; resyncRequired: boolean } {
  const state = ensureState(input.workspaceId);
  const cursor = Number.isFinite(input.cursor) ? Number(input.cursor) : 0;
  const firstSeq = state.events[0]?.seq ?? state.seq + 1;
  const resyncRequired = cursor > 0 && cursor < firstSeq - 1;
  const events = state.events.filter((event) => event.seq > cursor);
  return {
    events,
    cursor: events.at(-1)?.seq ?? Math.max(cursor, state.seq),
    resyncRequired,
  };
}

export type WorkspaceExtensionUiSnapshot = {
  cursor: number;
  statusBarItems: SerializedStatusBarItem[];
  contextKeys: Record<string, unknown>;
  outputChannels: Array<{ extensionId: string; channel: string; sizeBytes: number }>;
  diagnostics: Array<{
    key: string;
    uri: string;
    entries: SerializedDiagnostic[];
  }>;
  uiRequests: UiRequestPayload[];
  languageRegistrations: SerializedLanguageRegistration[];
  hostErrors: Array<{ ts: number; error: string }>;
};

export function getWorkspaceExtensionUiSnapshot(workspaceId: string): WorkspaceExtensionUiSnapshot {
  const state = ensureState(workspaceId);
  const diagnostics: WorkspaceExtensionUiSnapshot["diagnostics"] = [];
  for (const [key, byUri] of state.diagnostics) {
    for (const [uri, entries] of byUri) {
      diagnostics.push({ key, uri, entries });
    }
  }
  return {
    cursor: state.seq,
    statusBarItems: [...state.statusBarItems.values()],
    contextKeys: Object.fromEntries(state.contextKeys),
    outputChannels: [...state.outputChannels.values()].map((channel) => ({
      extensionId: channel.extensionId,
      channel: channel.channel,
      sizeBytes: Buffer.byteLength(channel.content, "utf8"),
    })),
    diagnostics,
    uiRequests: [...state.uiRequests.values()],
    languageRegistrations: state.languageRegistrations,
    hostErrors: state.hostErrors,
  };
}

export function getWorkspaceOutputChannelContent(
  workspaceId: string,
  extensionId: string,
  channel: string
): string | null {
  const state = ensureState(workspaceId);
  const entry = state.outputChannels.get(`${extensionId.toLowerCase()}:${channel}`);
  return entry ? entry.content : null;
}

export function getWorkspaceContextKeys(workspaceId: string): Record<string, unknown> {
  return Object.fromEntries(ensureState(workspaceId).contextKeys);
}

/* ------------------------------------------------------------------ */
/* UI request resolution                                               */
/* ------------------------------------------------------------------ */

export async function resolveWorkspaceUiRequest(input: {
  workspaceId: string;
  response: UiResponsePayload;
}): Promise<boolean> {
  const state = ensureState(input.workspaceId);
  const delivered = await sendUiResponseToHost({
    workspaceId: input.workspaceId,
    response: input.response,
  }).catch(() => false);
  if (state.uiRequests.delete(input.response.requestId)) {
    logWorkspaceExtensionEvent(input.workspaceId, "ui-close", {
      requestId: input.response.requestId,
    });
  }
  return delivered;
}

export async function forwardWorkspaceUiEvent(input: {
  workspaceId: string;
  event: UiClientEvent;
}): Promise<boolean> {
  return await sendUiEventToHost({ workspaceId: input.workspaceId, event: input.event }).catch(
    () => false
  );
}

/* ------------------------------------------------------------------ */
/* Host event ingestion                                                */
/* ------------------------------------------------------------------ */

/** Surface-scoped events are consumed by surface-sessions.ts instead. */
const SURFACE_SCOPED_EVENTS = new Set([
  "webview-message",
  "webview-html",
  "webview-panel",
  "webview-panel-disposed",
]);

const SILENT_EVENTS = new Set(["ready", "metrics", "log"]);

function handleHostEvent(workspaceId: string, event: HostChildEvent): void {
  if (SURFACE_SCOPED_EVENTS.has(event.event) || SILENT_EVENTS.has(event.event)) {
    return;
  }
  const state = ensureState(workspaceId);
  switch (event.event) {
    case "status-bar": {
      state.statusBarItems.set(event.payload.itemId, event.payload);
      break;
    }
    case "status-bar-dispose": {
      state.statusBarItems.delete(event.payload.itemId);
      break;
    }
    case "context": {
      state.contextKeys.set(event.payload.key, event.payload.value);
      break;
    }
    case "output": {
      const key = `${event.payload.extensionId.toLowerCase()}:${event.payload.channel}`;
      let entry = state.outputChannels.get(key);
      if (!entry) {
        entry = {
          extensionId: event.payload.extensionId.toLowerCase(),
          channel: event.payload.channel,
          content: "",
        };
        state.outputChannels.set(key, entry);
      }
      entry.content += event.payload.data;
      if (entry.content.length > MAX_OUTPUT_CHANNEL_BYTES) {
        entry.content = entry.content.slice(-MAX_OUTPUT_CHANNEL_BYTES);
      }
      break;
    }
    case "diagnostics": {
      const key = `${event.payload.extensionId.toLowerCase()}:${event.payload.collection}`;
      let byUri = state.diagnostics.get(key);
      if (!byUri) {
        byUri = new Map();
        state.diagnostics.set(key, byUri);
      }
      if (event.payload.entries.length === 0) {
        byUri.delete(event.payload.uri);
      } else {
        byUri.set(event.payload.uri, event.payload.entries);
      }
      break;
    }
    case "diagnostics-clear": {
      state.diagnostics.delete(
        `${event.payload.extensionId.toLowerCase()}:${event.payload.collection}`
      );
      break;
    }
    case "ui-request": {
      state.uiRequests.set(event.payload.requestId, event.payload);
      break;
    }
    case "ui-update": {
      const existing = state.uiRequests.get(event.payload.requestId);
      if (existing) {
        state.uiRequests.set(event.payload.requestId, { ...existing, ...event.payload.patch });
      }
      break;
    }
    case "ui-close": {
      state.uiRequests.delete(event.payload.requestId);
      break;
    }
    case "progress": {
      if (event.payload.done) {
        state.uiRequests.delete(event.payload.requestId);
      }
      break;
    }
    case "language-registrations": {
      state.languageRegistrations = event.payload.registrations;
      break;
    }
    case "config-update": {
      void persistConfigUpdate(workspaceId, event.payload.extensionId, event.payload.key, event.payload.value);
      break;
    }
    default:
      break;
  }
  logWorkspaceExtensionEvent(workspaceId, event.event, event.payload);
}

async function persistConfigUpdate(
  workspaceId: string,
  extensionId: string,
  key: string,
  value: unknown
): Promise<void> {
  try {
    const storage = await getStorage();
    const record = await storage.patchExtensionSettings(workspaceId, extensionId.toLowerCase(), {
      [key]: value,
    });
    if (record) {
      // Echo the merged settings back so every extension instance (and any
      // future host restart) sees the authoritative stored view.
      notifyHostConfigChanged({
        workspaceId,
        extensionId: record.extensionId,
        settings: record.settings,
      });
    }
  } catch (error) {
    console.warn("[extensions] failed to persist config update:", error);
  }
}

let ingestionStarted = false;

export function startExtensionEventIngestion(): void {
  if (ingestionStarted) return;
  ingestionStarted = true;
  onExtensionHostEvent(handleHostEvent);
  onExtensionHostLifecycle({
    onCrashed: (workspaceId, error) => {
      const state = ensureState(workspaceId);
      state.hostErrors.push({ ts: Date.now(), error });
      if (state.hostErrors.length > MAX_HOST_ERRORS) {
        state.hostErrors.splice(0, state.hostErrors.length - MAX_HOST_ERRORS);
      }
      // Status bar items / ui requests died with the host.
      state.statusBarItems.clear();
      state.uiRequests.clear();
      logWorkspaceExtensionEvent(workspaceId, "host-crashed", { error });
    },
    onRestarted: (workspace) => {
      logWorkspaceExtensionEvent(workspace.id, "host-restarted", {});
    },
  });
}

startExtensionEventIngestion();
