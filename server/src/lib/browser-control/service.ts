import { randomUUID } from "node:crypto";
import {
  captureDebugSessionViewport,
  createDebugSession,
  destroyDebugSession,
  dispatchDebugSessionInput,
  evaluateDebugSession,
  getDebugSession,
  navigateDebugSession,
  readDebugSessionEvents,
  snapshotDebugSession,
} from "../../browser-debug/chromium-session.js";
import {
  browserControlCapabilitiesForEngine,
  normalizeBrowserControlViewport,
} from "./capabilities.js";
import type {
  BrowserControlEvent,
  BrowserControlEventInput,
  BrowserControlGroup,
  BrowserControlInput,
  BrowserControlLockState,
  BrowserControlSession,
  BrowserControlSnapshot,
  BrowserControlTab,
  BrowserControlViewport,
} from "./types.js";

const tabs = new Map<string, BrowserControlTab>();
const sessions = new Map<string, BrowserControlSession>();
let eventSeq = 0;
const events: BrowserControlEvent[] = [];

function pushEvent(event: BrowserControlEventInput & { ts?: number }): void {
  eventSeq += 1;
  events.push({ ...event, seq: eventSeq, ts: event.ts ?? Date.now() } as BrowserControlEvent);
  if (events.length > 1_000) {
    events.splice(0, events.length - 1_000);
  }
}

function defaultLockState(): BrowserControlLockState {
  return {
    locked: false,
    lockVersion: 0,
    lockedByConversationId: null,
    lockReason: null,
    lockedAt: null,
    userUnlockedAt: null,
    userAlteredAt: null,
  };
}

function titleFromUrl(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function requireTab(workspaceId: string, tabId: string): BrowserControlTab {
  const tab = tabs.get(tabId);
  if (!tab || tab.workspaceId !== workspaceId) {
    throw new Error("Unknown browser tab.");
  }
  return tab;
}

function patchTab(tabId: string, patch: Partial<BrowserControlTab>): BrowserControlTab {
  const current = tabs.get(tabId);
  if (!current) throw new Error("Unknown browser tab.");
  const next = { ...current, ...patch, updatedAt: Date.now() };
  tabs.set(tabId, next);
  return next;
}

function sessionForTab(tabId: string): BrowserControlSession | null {
  return [...sessions.values()].find((session) => session.tabId === tabId) ?? null;
}

async function ensureServerChromiumSession(tab: BrowserControlTab): Promise<BrowserControlSession> {
  const existing = sessionForTab(tab.tabId);
  if (existing?.debugSessionId && getDebugSession(existing.debugSessionId)) {
    return existing;
  }
  const rec = await createDebugSession(tab.workspaceId, tab.currentUrl || tab.targetUrl);
  const session: BrowserControlSession = {
    controlSessionId: existing?.controlSessionId ?? `bc-${randomUUID()}`,
    tabId: tab.tabId,
    workspaceId: tab.workspaceId,
    debugSessionId: rec.id,
    nativeSessionId: null,
    currentUrl: rec.page.url() || tab.targetUrl,
    viewport: tab.viewport,
    lockState: tab.lockState,
    lastEventCursor: 0,
    lastAgentActionAt: null,
  };
  sessions.set(session.controlSessionId, session);
  patchTab(tab.tabId, {
    currentUrl: session.currentUrl,
    engine: "server-chromium",
    debugSessionId: session.debugSessionId,
  });
  return session;
}

function assertCapability(tab: BrowserControlTab, capability: keyof BrowserControlTab["capabilities"]): void {
  if (!tab.capabilities[capability]) {
    throw new Error(`Browser engine ${tab.engine} does not support ${capability}.`);
  }
}

export function listBrowserControlTabs(workspaceId: string): BrowserControlTab[] {
  return [...tabs.values()].filter((tab) => tab.workspaceId === workspaceId);
}

export async function openBrowserControlTab(input: {
  workspaceId: string;
  url: string;
  group?: BrowserControlGroup;
  title?: string;
  engine?: "proxy" | "server-chromium";
  active?: boolean;
  viewport?: Partial<BrowserControlViewport>;
}): Promise<BrowserControlTab> {
  const now = Date.now();
  const engine = input.engine ?? "server-chromium";
  const tab: BrowserControlTab = {
    tabId: `browser:${randomUUID()}`,
    workspaceId: input.workspaceId,
    group: input.group ?? "right",
    title: input.title?.trim() || titleFromUrl(input.url),
    targetUrl: input.url,
    currentUrl: input.url,
    engine,
    debugSessionId: null,
    nativeSessionId: null,
    active: input.active ?? true,
    focused: input.active ?? true,
    capabilities: browserControlCapabilitiesForEngine(engine),
    viewport: normalizeBrowserControlViewport(input.viewport),
    lockState: defaultLockState(),
    createdAt: now,
    updatedAt: now,
  };
  tabs.set(tab.tabId, tab);
  if (tab.engine === "server-chromium") {
    await ensureServerChromiumSession(tab);
  }
  pushEvent({ type: "agent_action", tabId: tab.tabId, detail: `Opened ${input.url}` });
  return tabs.get(tab.tabId) ?? tab;
}

export async function closeBrowserControlTab(workspaceId: string, tabId: string): Promise<void> {
  const tab = requireTab(workspaceId, tabId);
  const session = sessionForTab(tab.tabId);
  if (session?.debugSessionId) {
    await destroyDebugSession(session.debugSessionId).catch(() => undefined);
  }
  if (session) sessions.delete(session.controlSessionId);
  tabs.delete(tab.tabId);
  pushEvent({ type: "agent_action", tabId, detail: "Closed tab" });
}

export function focusBrowserControlTab(workspaceId: string, tabId: string): BrowserControlTab {
  const tab = requireTab(workspaceId, tabId);
  for (const existing of listBrowserControlTabs(workspaceId)) {
    patchTab(existing.tabId, {
      active: existing.tabId === tabId,
      focused: existing.tabId === tabId,
    });
  }
  pushEvent({ type: "agent_action", tabId, detail: "Focused tab" });
  return tabs.get(tab.tabId) ?? tab;
}

export function moveBrowserControlTab(
  workspaceId: string,
  tabId: string,
  group: BrowserControlGroup
): BrowserControlTab {
  requireTab(workspaceId, tabId);
  pushEvent({ type: "agent_action", tabId, detail: `Moved tab to ${group}` });
  return patchTab(tabId, { group });
}

export async function navigateBrowserControlTab(
  workspaceId: string,
  tabId: string,
  input: { op: "goto"; url: string } | { op: "reload" | "back" | "forward"; url?: undefined }
): Promise<BrowserControlTab> {
  const tab = requireTab(workspaceId, tabId);
  assertCapability(tab, "navigation");
  const session = await ensureServerChromiumSession(tab);
  const currentUrl = session.debugSessionId
    ? await navigateDebugSession(session.debugSessionId, input)
    : null;
  session.currentUrl = currentUrl ?? session.currentUrl;
  session.lastAgentActionAt = Date.now();
  const next = patchTab(tabId, {
    currentUrl: session.currentUrl,
    targetUrl: input.op === "goto" ? input.url : tab.targetUrl,
  });
  pushEvent({ type: "agent_action", tabId, detail: `Navigation ${input.op}` });
  return next;
}

export function setBrowserControlLock(input: {
  workspaceId: string;
  tabId: string;
  locked: boolean;
  conversationId?: string | null;
  reason?: string | null;
  userInitiated?: boolean;
}): BrowserControlTab {
  const tab = requireTab(input.workspaceId, input.tabId);
  const nextLock: BrowserControlLockState = {
    ...tab.lockState,
    locked: input.locked,
    lockVersion: tab.lockState.lockVersion + 1,
    lockedByConversationId: input.locked ? input.conversationId ?? null : null,
    lockReason: input.locked ? input.reason ?? null : null,
    lockedAt: input.locked ? Date.now() : null,
    userUnlockedAt: !input.locked && input.userInitiated ? Date.now() : tab.lockState.userUnlockedAt,
  };
  const next = patchTab(input.tabId, { lockState: nextLock });
  const session = sessionForTab(input.tabId);
  if (session) session.lockState = nextLock;
  pushEvent({
    type: input.locked ? "lock" : "unlock",
    tabId: input.tabId,
    detail: input.reason ?? undefined,
  });
  return next;
}

export function markBrowserControlUserIntervention(
  workspaceId: string,
  tabId: string,
  detail = "User altered browser state"
): BrowserControlTab {
  const tab = requireTab(workspaceId, tabId);
  const lockState = { ...tab.lockState, userAlteredAt: Date.now() };
  const next = patchTab(tabId, { lockState });
  const session = sessionForTab(tabId);
  if (session) session.lockState = lockState;
  pushEvent({ type: "user_intervention", tabId, detail });
  return next;
}

export async function setBrowserControlViewport(
  workspaceId: string,
  tabId: string,
  viewport: Partial<BrowserControlViewport>
): Promise<BrowserControlTab> {
  const tab = requireTab(workspaceId, tabId);
  assertCapability(tab, "viewportEmulation");
  const nextViewport = normalizeBrowserControlViewport(viewport);
  const session = await ensureServerChromiumSession(tab);
  if (session.debugSessionId) {
    await captureDebugSessionViewport(session.debugSessionId, nextViewport).catch(() => null);
  }
  session.viewport = nextViewport;
  pushEvent({ type: "agent_action", tabId, detail: `Set viewport ${nextViewport.width}x${nextViewport.height}` });
  return patchTab(tabId, { viewport: nextViewport });
}

export async function screenshotBrowserControlTab(
  workspaceId: string,
  tabId: string
): Promise<{ imageDataUrl: string | null; tab: BrowserControlTab }> {
  const tab = requireTab(workspaceId, tabId);
  assertCapability(tab, "screenshot");
  const session = await ensureServerChromiumSession(tab);
  const imageDataUrl = session.debugSessionId
    ? await captureDebugSessionViewport(session.debugSessionId, tab.viewport)
    : null;
  pushEvent({ type: "agent_action", tabId, detail: "Captured screenshot" });
  return { imageDataUrl, tab: tabs.get(tabId) ?? tab };
}

export async function snapshotBrowserControlTab(
  workspaceId: string,
  tabId: string
): Promise<BrowserControlSnapshot> {
  const tab = requireTab(workspaceId, tabId);
  assertCapability(tab, "snapshot");
  const session = await ensureServerChromiumSession(tab);
  const snapshot = session.debugSessionId
    ? await snapshotDebugSession(session.debugSessionId)
    : null;
  if (!snapshot) {
    throw new Error("Unable to snapshot browser tab.");
  }
  const nextTab = patchTab(tabId, {
    title: snapshot.title || tab.title,
    currentUrl: snapshot.url || tab.currentUrl,
  });
  return { tab: nextTab, ...snapshot };
}

export async function evaluateBrowserControlTab(
  workspaceId: string,
  tabId: string,
  script: string
): Promise<{ result: unknown; exception?: string }> {
  const tab = requireTab(workspaceId, tabId);
  assertCapability(tab, "jsEvaluate");
  const session = await ensureServerChromiumSession(tab);
  if (!session.debugSessionId) {
    throw new Error("Browser tab has no debug session.");
  }
  session.lastAgentActionAt = Date.now();
  pushEvent({ type: "agent_action", tabId, detail: "Evaluated JavaScript" });
  return await evaluateDebugSession(session.debugSessionId, script);
}

export async function dispatchBrowserControlInput(
  workspaceId: string,
  tabId: string,
  input: BrowserControlInput
): Promise<boolean> {
  const tab = requireTab(workspaceId, tabId);
  assertCapability(tab, input.type === "key" ? "keyboardInput" : "mouseInput");
  const session = await ensureServerChromiumSession(tab);
  if (!session.debugSessionId) return false;
  session.lastAgentActionAt = Date.now();
  pushEvent({
    type: "agent_action",
    tabId,
    detail: input.type === "mouse" ? `${input.action} ${input.x},${input.y}` : input.type,
  });
  return await dispatchDebugSessionInput(session.debugSessionId, input);
}

export function readBrowserControlEvents(
  workspaceId: string,
  tabId: string | null,
  afterSeq = 0
): { events: BrowserControlEvent[]; cursor: number } {
  const workspaceTabIds = new Set(listBrowserControlTabs(workspaceId).map((tab) => tab.tabId));
  const localEvents = events.filter(
    (event) =>
      event.seq > afterSeq &&
      workspaceTabIds.has(event.tabId) &&
      (!tabId || event.tabId === tabId)
  );
  const debugEvents: BrowserControlEvent[] = [];
  if (tabId) {
    const session = sessionForTab(tabId);
    if (session?.debugSessionId) {
      const result = readDebugSessionEvents(session.debugSessionId, afterSeq);
      for (const event of result?.events ?? []) {
        if (event.type === "console") {
          debugEvents.push({
            seq: event.seq,
            ts: event.ts,
            type: "console",
            tabId,
            level: event.level,
            text: event.text,
            url: event.url,
            lineNumber: event.lineNumber,
            columnNumber: event.columnNumber,
          });
        } else if (event.type === "network") {
          debugEvents.push({
            seq: event.seq,
            ts: event.ts,
            type: "network",
            tabId,
            url: event.url,
            method: event.method,
            status: event.status,
            statusText: event.statusText,
            resourceType: event.resourceType,
          });
        }
      }
    }
  }
  return {
    events: [...localEvents, ...debugEvents].sort((a, b) => a.seq - b.seq),
    cursor: Math.max(eventSeq, ...debugEvents.map((event) => event.seq), afterSeq),
  };
}

export function resetBrowserControlForTests(): void {
  tabs.clear();
  sessions.clear();
  events.splice(0, events.length);
  eventSeq = 0;
}
