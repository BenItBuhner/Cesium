import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceRecord } from "../workspace-registry.js";
import { getWorkspaceById } from "../workspace-registry.js";
import {
  deliverExtensionSurfaceMessage,
  getExtensionHostStatus,
  onExtensionHostEvent,
  onExtensionHostLifecycle,
  releaseExtensionHost,
  resolveExtensionSurface,
  retainExtensionHost,
  updateExtensionSurfaceThemeInHost,
} from "./host-runtime.js";
import { logWorkspaceExtensionEvent } from "./host-events.js";
import type { ExtensionHostStatus, ExtensionInstallRecord } from "./types.js";

export type ExtensionSurfacePlacement = "sidebar" | "editor";
export type ExtensionSurfaceKind = "marketplace" | "webview" | "customEditor" | "view" | "output";

export type ExtensionWebviewThemeSnapshot = {
  colorScheme: "dark" | "light";
  variables: Record<string, string>;
};

export type ExtensionSurfaceEvent = {
  seq: number;
  ts: number;
  type: "html" | "message" | "external-url" | "state" | "theme" | "status" | "tree";
  sessionId: string;
  payload?: unknown;
};

export type ExtensionSurfaceSession = {
  sessionId: string;
  workspaceId: string;
  extensionId: string;
  surfaceId: string;
  title: string;
  kind: ExtensionSurfaceKind;
  viewType?: string;
  placements: ExtensionSurfacePlacement[];
  createdAt: number;
  updatedAt: number;
  lastAttachedAt?: number;
  attachedClientCount: number;
  html: string;
  htmlVersion: number;
  messageCursor: number;
  messages: Array<{ seq: number; ts: number; message: unknown }>;
  externalUrls: string[];
  vscodeState?: unknown;
  theme?: ExtensionWebviewThemeSnapshot;
  activationMs?: number;
  resolveMs?: number;
  htmlBytes?: number;
  lastError?: string;
  missingProvider?: boolean;
  message?: string;
  isPanel?: boolean;
  isTree?: boolean;
  host: ExtensionHostStatus;
};

export type ExtensionSurfaceDescriptor = {
  extensionId: string;
  surfaceId: string;
  title: string;
  kind: ExtensionSurfaceKind;
  viewType?: string;
  placement: ExtensionSurfacePlacement;
};

export type ExtensionSurfaceSnapshot = {
  session: ExtensionSurfaceSession;
  html: string;
  htmlVersion: number;
  messages: Array<{ seq: number; ts: number; message: unknown }>;
  externalUrls: string[];
  vscodeState?: unknown;
  theme?: ExtensionWebviewThemeSnapshot;
  host: ExtensionHostStatus;
  missingProvider?: boolean;
  message?: string;
  isTree?: boolean;
  treeItems?: unknown[];
};

type MutableSession = Omit<ExtensionSurfaceSession, "attachedClientCount"> & {
  attachedClientIds: Set<string>;
  resolvePromise?: Promise<void>;
  seenMessageIds: string[];
  treeItems?: unknown[];
  themeKey?: string;
};

const sessions = new Map<string, MutableSession>();
const MAX_MESSAGE_BACKLOG = 1_000;
const MAX_EVENT_BACKLOG = 2_000;
const MAX_PUBLIC_MESSAGE_BACKLOG = 300;
const MAX_PUBLIC_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_SEEN_MESSAGE_IDS = 256;
let eventSeq = 0;
const events: ExtensionSurfaceEvent[] = [];

type SurfaceEventListener = (workspaceId: string, event: ExtensionSurfaceEvent) => void;
const surfaceEventListeners = new Set<SurfaceEventListener>();

export function subscribeExtensionSurfaceEvents(listener: SurfaceEventListener): () => void {
  surfaceEventListeners.add(listener);
  return () => surfaceEventListeners.delete(listener);
}

export function stableExtensionSurfaceSessionId(input: {
  workspaceId: string;
  extensionId: string;
  surfaceId: string;
}): string {
  const hash = createHash("sha1")
    .update(`${input.workspaceId}\0${input.extensionId.toLowerCase()}\0${input.surfaceId}`)
    .digest("hex")
    .slice(0, 20);
  return `extsurf-${hash}`;
}

export function discoverExtensionSurfaceDescriptors(
  extension: ExtensionInstallRecord
): ExtensionSurfaceDescriptor[] {
  if (!extension.enabled) {
    return [];
  }
  const normalized = extension.manifest.capabilities?.activitySurfaces;
  if (normalized?.length) {
    return normalized
      .filter((surface) => surface.visibility === "always")
      .map((surface) => ({
        extensionId: extension.extensionId,
        surfaceId: surface.surfaceId,
        title: surface.title || extension.displayName,
        kind: surface.kind === "activity.webviewView" ? "webview" : "view",
        viewType: surface.containerId,
        placement: "sidebar",
      }));
  }
  const contributes = extension.manifest.raw.contributes;
  const views =
    contributes && typeof contributes === "object" && "views" in contributes
      ? (contributes as { views?: unknown }).views
      : undefined;
  if (!views || typeof views !== "object") {
    return [];
  }
  const descriptors: ExtensionSurfaceDescriptor[] = [];
  for (const [containerId, viewList] of Object.entries(views as Record<string, unknown>)) {
    if (!Array.isArray(viewList)) {
      continue;
    }
    for (const contributedView of viewList) {
      if (!contributedView || typeof contributedView !== "object") {
        continue;
      }
      const id = (contributedView as { id?: unknown }).id;
      if (typeof id !== "string" || !id.trim()) {
        continue;
      }
      const name = (contributedView as { name?: unknown }).name;
      const type = (contributedView as { type?: unknown }).type;
      descriptors.push({
        extensionId: extension.extensionId,
        surfaceId: id,
        title: typeof name === "string" && name.trim() ? name : extension.displayName,
        kind: type === "webview" ? "webview" : "view",
        viewType: containerId,
        placement: "sidebar",
      });
    }
  }
  return descriptors;
}

export function discoverWorkspaceExtensionSurfaceDescriptors(
  extensions: ExtensionInstallRecord[]
): ExtensionSurfaceDescriptor[] {
  return extensions.flatMap(discoverExtensionSurfaceDescriptors);
}

export function findExtensionSurfaceDescriptorBySessionId(input: {
  workspaceId: string;
  extensions: ExtensionInstallRecord[];
  sessionId: string;
}): ExtensionSurfaceDescriptor | null {
  for (const descriptor of discoverWorkspaceExtensionSurfaceDescriptors(input.extensions)) {
    const candidate = stableExtensionSurfaceSessionId({
      workspaceId: input.workspaceId,
      extensionId: descriptor.extensionId,
      surfaceId: descriptor.surfaceId,
    });
    if (candidate === input.sessionId) {
      return descriptor;
    }
  }
  return null;
}

function retainId(sessionId: string): string {
  return `surface:${sessionId}`;
}

function pushEvent(
  workspaceId: string,
  sessionId: string,
  type: ExtensionSurfaceEvent["type"],
  payload?: unknown
): void {
  eventSeq += 1;
  const event: ExtensionSurfaceEvent = { seq: eventSeq, ts: Date.now(), type, sessionId, payload };
  events.push(event);
  if (events.length > MAX_EVENT_BACKLOG) {
    events.splice(0, events.length - MAX_EVENT_BACKLOG);
  }
  for (const listener of [...surfaceEventListeners]) {
    try {
      listener(workspaceId, event);
    } catch (error) {
      console.warn("[extensions] surface event listener failed:", error);
    }
  }
}

function appendMessages(session: MutableSession, messages: unknown[]): void {
  for (const message of messages) {
    session.messageCursor += 1;
    const entry = { seq: session.messageCursor, ts: Date.now(), message };
    session.messages.push(entry);
    pushEvent(session.workspaceId, session.sessionId, "message", entry);
  }
  if (session.messages.length > MAX_MESSAGE_BACKLOG) {
    session.messages.splice(0, session.messages.length - MAX_MESSAGE_BACKLOG);
  }
}

function publicSession(session: MutableSession): ExtensionSurfaceSession {
  const {
    attachedClientIds: _attachedClientIds,
    resolvePromise: _resolvePromise,
    seenMessageIds: _seen,
    treeItems: _treeItems,
    themeKey: _themeKey,
    ...rest
  } = session;
  return {
    ...rest,
    attachedClientCount: session.attachedClientIds.size,
  };
}

function snapshot(session: MutableSession): ExtensionSurfaceSnapshot {
  return {
    session: publicSession(session),
    html: session.html,
    htmlVersion: session.htmlVersion,
    messages: publicMessages(session.messages),
    externalUrls: session.externalUrls,
    vscodeState: session.vscodeState,
    theme: session.theme,
    host: session.host,
    missingProvider: session.missingProvider,
    message: session.message,
    isTree: session.isTree,
    treeItems: session.treeItems,
  };
}

function publicMessages(
  messages: Array<{ seq: number; ts: number; message: unknown }>
): Array<{ seq: number; ts: number; message: unknown }> {
  const selected: Array<{ seq: number; ts: number; message: unknown }> = [];
  let bytes = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (selected.length >= MAX_PUBLIC_MESSAGE_BACKLOG) break;
    const entry = messages[index];
    if (!entry) continue;
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(entry.message), "utf8");
    } catch {
      continue;
    }
    if (size > MAX_PUBLIC_MESSAGE_BYTES) continue;
    if (selected.length > 0 && bytes + size > MAX_PUBLIC_MESSAGE_BYTES) break;
    bytes += size;
    selected.unshift(entry);
  }
  return selected;
}

export function listExtensionSurfaceSessions(workspaceId: string): ExtensionSurfaceSession[] {
  return [...sessions.values()]
    .filter((session) => session.workspaceId === workspaceId)
    .map(publicSession);
}

export function getExtensionSurfaceSession(
  workspaceId: string,
  sessionId: string
): ExtensionSurfaceSession | null {
  const session = sessions.get(sessionId);
  if (!session || session.workspaceId !== workspaceId) {
    return null;
  }
  return publicSession(session);
}

export function readExtensionSurfaceEvents(input: {
  workspaceId: string;
  sessionId: string;
  cursor?: number;
}): { events: ExtensionSurfaceEvent[]; cursor: number } {
  const cursor = Number.isFinite(input.cursor) ? Number(input.cursor) : 0;
  const session = sessions.get(input.sessionId);
  if (!session || session.workspaceId !== input.workspaceId) {
    return { events: [], cursor };
  }
  const next = events.filter((event) => event.sessionId === input.sessionId && event.seq > cursor);
  return {
    events: next,
    cursor: next.at(-1)?.seq ?? cursor,
  };
}

function createSessionObject(input: {
  sessionId: string;
  workspaceId: string;
  extensionId: string;
  surfaceId: string;
  title: string;
  kind: ExtensionSurfaceKind;
  viewType?: string;
  placement?: ExtensionSurfacePlacement;
  theme?: ExtensionWebviewThemeSnapshot;
  isPanel?: boolean;
}): MutableSession {
  const now = Date.now();
  const session: MutableSession = {
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    extensionId: input.extensionId.toLowerCase(),
    surfaceId: input.surfaceId,
    title: input.title,
    kind: input.kind,
    viewType: input.viewType,
    placements: input.placement ? [input.placement] : [],
    createdAt: now,
    updatedAt: now,
    attachedClientIds: new Set(),
    html: "",
    htmlVersion: 0,
    messageCursor: 0,
    messages: [],
    externalUrls: [],
    theme: input.theme,
    themeKey: input.theme ? JSON.stringify(input.theme) : undefined,
    isPanel: input.isPanel,
    seenMessageIds: [],
    host: getExtensionHostStatus(input.workspaceId),
  };
  sessions.set(input.sessionId, session);
  return session;
}

async function resolveSessionSurface(
  session: MutableSession,
  workspace: WorkspaceRecord
): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await resolveExtensionSurface({
      workspace,
      extensionId: session.extensionId,
      surfaceId: session.surfaceId,
      title: session.title,
      surfaceSessionId: session.sessionId,
      webviewState: session.vscodeState,
      theme: session.theme,
      kind: session.isPanel ? "panel" : undefined,
    });
    const elapsed = Date.now() - startedAt;
    session.resolveMs = elapsed;
    session.activationMs = elapsed;
    if (result.html || !session.html) {
      session.html = result.html;
      session.htmlVersion += 1;
    }
    session.htmlBytes = Buffer.byteLength(session.html, "utf8");
    session.externalUrls = result.externalUrls;
    session.host = result.status;
    session.missingProvider = result.missingProvider;
    session.isTree = result.treeView;
    if (result.treeView) {
      session.treeItems = result.treeItems;
      session.kind = "view";
    }
    session.message = result.message;
    session.lastError = undefined;
    session.updatedAt = Date.now();
    appendMessages(session, result.messages);
    pushEvent(session.workspaceId, session.sessionId, "html", {
      htmlVersion: session.htmlVersion,
      htmlBytes: session.htmlBytes,
      html: session.html,
      isTree: session.isTree,
    });
  } catch (error) {
    session.lastError = error instanceof Error ? error.message : String(error);
    session.updatedAt = Date.now();
    pushEvent(session.workspaceId, session.sessionId, "status", { error: session.lastError });
    throw error;
  }
}

export async function ensureExtensionSurfaceSession(input: {
  workspace: WorkspaceRecord;
  extensionId: string;
  surfaceId: string;
  title?: string;
  kind?: ExtensionSurfaceKind;
  viewType?: string;
  placement?: ExtensionSurfacePlacement;
  sessionId?: string;
  theme?: ExtensionWebviewThemeSnapshot;
}): Promise<ExtensionSurfaceSnapshot> {
  const now = Date.now();
  const sessionId =
    input.sessionId ??
    stableExtensionSurfaceSessionId({
      workspaceId: input.workspace.id,
      extensionId: input.extensionId,
      surfaceId: input.surfaceId,
    });
  let session = sessions.get(sessionId);
  if (!session) {
    session = createSessionObject({
      sessionId,
      workspaceId: input.workspace.id,
      extensionId: input.extensionId,
      surfaceId: input.surfaceId,
      title: input.title ?? input.surfaceId,
      kind: input.kind ?? "view",
      viewType: input.viewType,
      placement: input.placement,
      theme: input.theme,
      isPanel: sessionId.startsWith("extpanel-"),
    });
    await retainExtensionHost(input.workspace, retainId(sessionId));
    pushEvent(input.workspace.id, sessionId, "status", { created: true });
  } else {
    session.title = input.title ?? session.title;
    session.kind = input.kind ?? session.kind;
    session.viewType = input.viewType ?? session.viewType;
    if (input.placement && !session.placements.includes(input.placement)) {
      session.placements.push(input.placement);
    }
    if (input.theme) {
      session.theme = input.theme;
    }
    session.updatedAt = now;
  }

  if (!session.html && !session.isTree) {
    session.resolvePromise ??= resolveSessionSurface(session, input.workspace).finally(() => {
      session.resolvePromise = undefined;
    });
    await session.resolvePromise;
  }

  if (input.theme) {
    await updateExtensionSurfaceTheme({
      workspace: input.workspace,
      sessionId: session.sessionId,
      theme: input.theme,
    });
  }

  return snapshot(session);
}

export async function prewarmExtensionSurfaceSessions(input: {
  workspace: WorkspaceRecord;
  extensions: ExtensionInstallRecord[];
  theme?: ExtensionWebviewThemeSnapshot;
  placement?: ExtensionSurfacePlacement;
}): Promise<ExtensionSurfaceSnapshot[]> {
  const snapshots: ExtensionSurfaceSnapshot[] = [];
  for (const descriptor of discoverWorkspaceExtensionSurfaceDescriptors(input.extensions)) {
    try {
      snapshots.push(
        await ensureExtensionSurfaceSession({
          workspace: input.workspace,
          extensionId: descriptor.extensionId,
          surfaceId: descriptor.surfaceId,
          title: descriptor.title,
          kind: descriptor.kind,
          viewType: descriptor.viewType,
          placement: input.placement ?? descriptor.placement,
          theme: input.theme,
        })
      );
    } catch (error) {
      const sessionId = stableExtensionSurfaceSessionId({
        workspaceId: input.workspace.id,
        extensionId: descriptor.extensionId,
        surfaceId: descriptor.surfaceId,
      });
      pushEvent(input.workspace.id, sessionId, "status", {
        prewarmFailed: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return snapshots;
}

export async function attachExtensionSurfaceSession(input: {
  workspace: WorkspaceRecord;
  sessionId: string;
  clientId?: string;
  theme?: ExtensionWebviewThemeSnapshot;
}): Promise<ExtensionSurfaceSnapshot> {
  const session = sessions.get(input.sessionId);
  if (!session || session.workspaceId !== input.workspace.id) {
    throw new Error("Unknown extension surface session.");
  }
  if (input.clientId?.trim()) {
    session.attachedClientIds.add(input.clientId);
  }
  session.lastAttachedAt = Date.now();
  session.updatedAt = session.lastAttachedAt;
  if (input.theme) {
    await updateExtensionSurfaceTheme({
      workspace: input.workspace,
      sessionId: session.sessionId,
      theme: input.theme,
    });
  }
  await retainExtensionHost(input.workspace, retainId(session.sessionId));
  pushEvent(session.workspaceId, session.sessionId, "status", {
    attachedClientCount: session.attachedClientIds.size,
  });
  return snapshot(session);
}

export async function detachExtensionSurfaceSession(input: {
  workspaceId: string;
  sessionId: string;
  clientId?: string;
}): Promise<ExtensionSurfaceSession | null> {
  const session = sessions.get(input.sessionId);
  if (!session || session.workspaceId !== input.workspaceId) {
    return null;
  }
  if (input.clientId?.trim()) {
    session.attachedClientIds.delete(input.clientId);
  }
  session.updatedAt = Date.now();
  pushEvent(session.workspaceId, session.sessionId, "status", {
    attachedClientCount: session.attachedClientIds.size,
  });
  return publicSession(session);
}

export async function closeExtensionSurfaceSession(input: {
  workspaceId: string;
  sessionId: string;
}): Promise<boolean> {
  const session = sessions.get(input.sessionId);
  if (!session || session.workspaceId !== input.workspaceId) {
    return false;
  }
  sessions.delete(input.sessionId);
  await releaseExtensionHost(input.workspaceId, retainId(input.sessionId));
  pushEvent(input.workspaceId, input.sessionId, "status", { closed: true });
  return true;
}

export async function closeWorkspaceExtensionSurfaceSessions(workspaceId: string): Promise<void> {
  const sessionIds = [...sessions.values()]
    .filter((session) => session.workspaceId === workspaceId)
    .map((session) => session.sessionId);
  for (const sessionId of sessionIds) {
    await closeExtensionSurfaceSession({ workspaceId, sessionId });
  }
}

export async function closeExtensionSurfaceSessionsForExtension(input: {
  workspaceId: string;
  extensionId: string;
}): Promise<void> {
  const sessionIds = [...sessions.values()]
    .filter(
      (session) =>
        session.workspaceId === input.workspaceId &&
        session.extensionId === input.extensionId.toLowerCase()
    )
    .map((session) => session.sessionId);
  for (const sessionId of sessionIds) {
    await closeExtensionSurfaceSession({ workspaceId: input.workspaceId, sessionId });
  }
}

export async function deliverExtensionSurfaceSessionMessage(input: {
  workspace: WorkspaceRecord;
  sessionId: string;
  message: unknown;
  msgId?: string;
}): Promise<ExtensionSurfaceSnapshot & { missingWebview: boolean; duplicate: boolean }> {
  const session = sessions.get(input.sessionId);
  if (!session || session.workspaceId !== input.workspace.id) {
    throw new Error("Unknown extension surface session.");
  }
  // Idempotent delivery: retried sends over lossy links carry the same msgId.
  if (input.msgId) {
    if (session.seenMessageIds.includes(input.msgId)) {
      return { ...snapshot(session), missingWebview: false, duplicate: true };
    }
    session.seenMessageIds.push(input.msgId);
    if (session.seenMessageIds.length > MAX_SEEN_MESSAGE_IDS) {
      session.seenMessageIds.splice(0, session.seenMessageIds.length - MAX_SEEN_MESSAGE_IDS);
    }
  }
  const result = await deliverExtensionSurfaceMessage({
    workspace: input.workspace,
    extensionId: session.extensionId,
    surfaceId: session.surfaceId,
    surfaceSessionId: session.sessionId,
    message: input.message,
  });
  appendMessages(session, result.messages);
  session.host = result.status;
  session.updatedAt = Date.now();
  return { ...snapshot(session), missingWebview: result.missingWebview, duplicate: false };
}

export async function updateExtensionSurfaceState(input: {
  workspaceId: string;
  sessionId: string;
  state: unknown;
}): Promise<ExtensionSurfaceSnapshot> {
  const session = sessions.get(input.sessionId);
  if (!session || session.workspaceId !== input.workspaceId) {
    throw new Error("Unknown extension surface session.");
  }
  session.vscodeState = input.state;
  session.updatedAt = Date.now();
  pushEvent(session.workspaceId, session.sessionId, "state", { state: input.state });
  return snapshot(session);
}

export async function updateExtensionSurfaceTheme(input: {
  workspace: WorkspaceRecord;
  sessionId: string;
  theme: ExtensionWebviewThemeSnapshot;
}): Promise<ExtensionSurfaceSnapshot> {
  const session = sessions.get(input.sessionId);
  if (!session || session.workspaceId !== input.workspace.id) {
    throw new Error("Unknown extension surface session.");
  }
  const themeKey = JSON.stringify(input.theme);
  if (session.themeKey === themeKey) {
    return snapshot(session);
  }
  session.theme = input.theme;
  session.themeKey = themeKey;
  session.updatedAt = Date.now();
  await updateExtensionSurfaceThemeInHost({
    workspace: input.workspace,
    extensionId: session.extensionId,
    surfaceId: session.surfaceId,
    surfaceSessionId: session.sessionId,
    theme: input.theme,
  }).catch((error) => {
    session.lastError = error instanceof Error ? error.message : String(error);
  });
  pushEvent(session.workspaceId, session.sessionId, "theme", input.theme);
  return snapshot(session);
}

export function newExtensionSurfaceClientId(): string {
  return `ext-client-${randomUUID()}`;
}

/* ------------------------------------------------------------------ */
/* Host event ingestion (webview push channel)                         */
/* ------------------------------------------------------------------ */

function handleHostSurfaceEvent(
  workspaceId: string,
  event:
    | { event: "webview-message"; payload: { surfaceKey: string; extensionId: string; message: unknown } }
    | { event: "webview-html"; payload: { surfaceKey: string; extensionId: string; html: string; title?: string } }
    | {
        event: "webview-panel";
        payload: {
          surfaceKey: string;
          extensionId: string;
          viewType: string;
          title: string;
          html: string;
          active: boolean;
        };
      }
    | { event: "webview-panel-disposed"; payload: { surfaceKey: string; extensionId: string } }
    | { event: "tree-changed"; payload: { extensionId: string; viewId: string } }
): void {
  if (event.event === "webview-message") {
    const session = sessions.get(event.payload.surfaceKey);
    if (!session || session.workspaceId !== workspaceId) return;
    appendMessages(session, [event.payload.message]);
    session.updatedAt = Date.now();
    return;
  }
  if (event.event === "webview-html") {
    const session = sessions.get(event.payload.surfaceKey);
    if (!session || session.workspaceId !== workspaceId) return;
    if (typeof event.payload.title === "string" && event.payload.title.trim()) {
      session.title = event.payload.title;
    }
    if (session.html !== event.payload.html) {
      session.html = event.payload.html;
      session.htmlVersion += 1;
      session.htmlBytes = Buffer.byteLength(session.html, "utf8");
    }
    session.updatedAt = Date.now();
    pushEvent(workspaceId, session.sessionId, "html", {
      htmlVersion: session.htmlVersion,
      htmlBytes: session.htmlBytes,
      html: session.html,
      title: session.title,
    });
    return;
  }
  if (event.event === "webview-panel") {
    void (async () => {
      let session = sessions.get(event.payload.surfaceKey);
      if (!session) {
        session = createSessionObject({
          sessionId: event.payload.surfaceKey,
          workspaceId,
          extensionId: event.payload.extensionId,
          surfaceId: event.payload.viewType,
          title: event.payload.title,
          kind: "webview",
          placement: "editor",
          isPanel: true,
        });
        const workspace = await getWorkspaceById(workspaceId).catch(() => null);
        if (workspace) {
          await retainExtensionHost(workspace, retainId(session.sessionId)).catch(() => undefined);
        }
        pushEvent(workspaceId, session.sessionId, "status", { created: true });
      }
      if (event.payload.html && session.html !== event.payload.html) {
        session.html = event.payload.html;
        session.htmlVersion += 1;
        session.htmlBytes = Buffer.byteLength(session.html, "utf8");
      }
      session.title = event.payload.title || session.title;
      session.updatedAt = Date.now();
      logWorkspaceExtensionEvent(workspaceId, "panel-opened", {
        sessionId: session.sessionId,
        extensionId: session.extensionId,
        surfaceId: session.surfaceId,
        title: session.title,
        active: event.payload.active,
      });
    })();
    return;
  }
  if (event.event === "webview-panel-disposed") {
    void closeExtensionSurfaceSession({
      workspaceId,
      sessionId: event.payload.surfaceKey,
    });
    return;
  }
  if (event.event === "tree-changed") {
    // Forward per-session tree refreshes for sidebar/editor tree surfaces.
    for (const session of sessions.values()) {
      if (
        session.workspaceId === workspaceId &&
        session.extensionId === event.payload.extensionId.toLowerCase() &&
        session.surfaceId === event.payload.viewId
      ) {
        session.updatedAt = Date.now();
        pushEvent(workspaceId, session.sessionId, "tree", { viewId: event.payload.viewId });
      }
    }
  }
}

let surfaceIngestionStarted = false;

function startSurfaceIngestion(): void {
  if (surfaceIngestionStarted) return;
  surfaceIngestionStarted = true;
  onExtensionHostEvent((workspaceId, event) => {
    if (
      event.event === "webview-message" ||
      event.event === "webview-html" ||
      event.event === "webview-panel" ||
      event.event === "webview-panel-disposed" ||
      event.event === "tree-changed"
    ) {
      handleHostSurfaceEvent(workspaceId, event);
    }
  });
  onExtensionHostLifecycle({
    onRestarted: (workspace) => {
      void reresolveWorkspaceSurfaceSessions(workspace);
    },
    onCrashed: (workspaceId) => {
      for (const session of sessions.values()) {
        if (session.workspaceId !== workspaceId) continue;
        session.host = getExtensionHostStatus(workspaceId);
        pushEvent(workspaceId, session.sessionId, "status", { hostCrashed: true });
      }
    },
  });
}

async function reresolveWorkspaceSurfaceSessions(workspace: WorkspaceRecord): Promise<void> {
  for (const session of sessions.values()) {
    if (session.workspaceId !== workspace.id) continue;
    session.html = "";
    session.htmlVersion += 0;
    session.missingProvider = undefined;
    try {
      await resolveSessionSurface(session, workspace);
    } catch (error) {
      console.warn(
        `[extensions] failed to re-resolve surface ${session.sessionId} after restart:`,
        error instanceof Error ? error.message : error
      );
    }
  }
}

startSurfaceIngestion();
