import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";

export type ChromiumTarget = {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
  devtoolsFrontendUrl: string;
};

export type DebugSessionRecord = {
  id: string;
  workspaceId: string;
  /** Browser handle when available (persistent contexts may not expose one). */
  browser: Browser | null;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  userDataDir: string;
  debugPort: number;
  /** Target id of the page we navigated - used to build the DevTools frontend URL. */
  targetId: string;
  /** Raw `devtoolsFrontendUrl` from Chromium's `/json/list` (unrewritten). */
  rawDevtoolsFrontendUrl: string;
  createdAt: number;
  eventSeq: number;
  events: BrowserDebugEvent[];
};

export type BrowserDebugEvent =
  | {
      seq: number;
      ts: number;
      type: "console";
      level: "log" | "info" | "warning" | "error" | "debug";
      source: "console" | "exception" | "log";
      text: string;
      url?: string;
      lineNumber?: number;
      columnNumber?: number;
    }
  | {
      seq: number;
      ts: number;
      type: "network";
      url: string;
      method?: string;
      status?: number;
      statusText?: string;
      resourceType?: string;
    };

const sessions = new Map<string, DebugSessionRecord>();
const MAX_SESSIONS = 4;
const MAX_SESSION_EVENTS = 500;
const CHROMIUM_START_TIMEOUT_MS = 30_000;

let playwrightModule: typeof import("playwright") | null = null;

async function loadPlaywright(): Promise<typeof import("playwright")> {
  if (playwrightModule) {
    return playwrightModule;
  }
  try {
    playwrightModule = await import("playwright");
    return playwrightModule;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Playwright is not available.";
    throw new Error(
      `${message} Install Chromium with: cd server && npx playwright install chromium`
    );
  }
}

type RenderScreenshotSession = {
  key: string;
  context: BrowserContext;
  page: Page;
  lastUsedAt: number;
  queue: Promise<void>;
};

export type RenderedElementScreenshotInput = {
  pageUrl: string;
  viewport: { width: number; height: number };
  pathIndices: number[];
  scroll?: { x: number; y: number } | null;
  rect?: { left: number; top: number; width: number; height: number } | null;
};

/**
 * Read the DevTools HTTP port Chromium chose for `--remote-debugging-port=0`.
 * Chromium writes it to `DevToolsActivePort` inside the user data dir. We keep
 * the HTTP endpoint alongside Playwright's pipe transport so the DevTools
 * frontend (`/devtools/inspector.html`, `ws://host/devtools/page/<id>`) stays
 * proxyable - and the pipe transport is what keeps Playwright working under
 * Bun, where its `connectOverCDP` websocket client hangs.
 */
async function readDevToolsActivePort(userDataDir: string): Promise<number> {
  const portFilePath = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + CHROMIUM_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(portFilePath, "utf8");
      const port = Number.parseInt(raw.split("\n")[0] ?? "", 10);
      if (Number.isFinite(port) && port > 0) {
        return port;
      }
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Chromium remote debugging port");
}

async function fetchChromiumTargets(debugPort: number): Promise<ChromiumTarget[]> {
  const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  if (!res.ok) {
    throw new Error(`Chromium /json/list failed with status ${res.status}`);
  }
  return (await res.json()) as ChromiumTarget[];
}

function sanitizeViewport(n: number, fallback: number): number {
  const parsed = Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.max(64, Math.min(parsed, 2400));
}

function pushDebugSessionEvent(
  rec: DebugSessionRecord,
  event:
    | (Omit<Extract<BrowserDebugEvent, { type: "console" }>, "seq" | "ts"> & {
        ts?: number;
      })
    | (Omit<Extract<BrowserDebugEvent, { type: "network" }>, "seq" | "ts"> & {
        ts?: number;
      })
): void {
  rec.eventSeq += 1;
  rec.events.push({
    ...event,
    seq: rec.eventSeq,
    ts: event.ts ?? Date.now(),
  } as BrowserDebugEvent);
  if (rec.events.length > MAX_SESSION_EVENTS) {
    rec.events.splice(0, rec.events.length - MAX_SESSION_EVENTS);
  }
}

function installSessionEventCapture(rec: DebugSessionRecord): void {
  rec.cdp.on("Runtime.consoleAPICalled", (params) => {
    const text = (params.args ?? [])
      .map((arg: { value?: unknown; description?: string; type?: string }) =>
        arg.value != null ? String(arg.value) : arg.description ?? arg.type ?? ""
      )
      .filter(Boolean)
      .join(" ");
    const frame = params.stackTrace?.callFrames?.[0];
    pushDebugSessionEvent(rec, {
      type: "console",
      level:
        params.type === "error"
          ? "error"
          : params.type === "warning"
            ? "warning"
            : params.type === "debug"
              ? "debug"
              : "log",
      source: "console",
      text,
      url: frame?.url,
      lineNumber: frame?.lineNumber,
      columnNumber: frame?.columnNumber,
    });
  });
  rec.cdp.on("Runtime.exceptionThrown", (params) => {
    const details = params.exceptionDetails ?? {};
    pushDebugSessionEvent(rec, {
      type: "console",
      level: "error",
      source: "exception",
      text:
        details.text ??
        details.exception?.description ??
        "Uncaught exception",
      url: details.url,
      lineNumber: details.lineNumber,
      columnNumber: details.columnNumber,
    });
  });
  rec.cdp.on("Log.entryAdded", (params) => {
    const entry = params.entry ?? {};
    pushDebugSessionEvent(rec, {
      type: "console",
      level:
        entry.level === "error"
          ? "error"
          : entry.level === "warning"
            ? "warning"
            : "info",
      source: "log",
      text: entry.text ?? "",
      url: entry.url,
      lineNumber: entry.lineNumber,
    });
  });
  rec.cdp.on("Network.responseReceived", (params) => {
    const response = params.response ?? {};
    pushDebugSessionEvent(rec, {
      type: "network",
      url: response.url ?? "",
      status: response.status,
      statusText: response.statusText,
      resourceType: params.type,
    });
  });
}

function sanitizeClipRect(
  rect: RenderedElementScreenshotInput["rect"] | null | undefined,
  viewport: { width: number; height: number }
):
  | {
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | null {
  if (!rect) return null;
  const x = Math.max(0, Math.floor(rect.left));
  const y = Math.max(0, Math.floor(rect.top));
  const right = Math.min(viewport.width, Math.ceil(rect.left + rect.width));
  const bottom = Math.min(viewport.height, Math.ceil(rect.top + rect.height));
  const width = right - x;
  const height = bottom - y;
  if (width < 2 || height < 2) return null;
  return { x, y, width, height };
}

const renderScreenshotSessions = new Map<string, RenderScreenshotSession>();
const MAX_RENDER_SCREENSHOT_SESSIONS = 3;
let renderScreenshotBrowserPromise: Promise<Browser> | null = null;

async function getRenderScreenshotBrowser(): Promise<Browser> {
  if (renderScreenshotBrowserPromise) {
    return renderScreenshotBrowserPromise;
  }
  const pw = await loadPlaywright();
  renderScreenshotBrowserPromise = pw.chromium
    .launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
      ],
    })
    .catch((error) => {
      renderScreenshotBrowserPromise = null;
      throw error;
    });
  return renderScreenshotBrowserPromise;
}

function renderScreenshotSessionKey(
  pageUrl: string,
  viewport: { width: number; height: number }
): string {
  return `${pageUrl}|${viewport.width}x${viewport.height}`;
}

async function closeRenderScreenshotSession(key: string): Promise<void> {
  const rec = renderScreenshotSessions.get(key);
  if (!rec) return;
  renderScreenshotSessions.delete(key);
  await rec.context.close().catch(() => undefined);
}

async function evictOldestRenderScreenshotSession(): Promise<void> {
  if (renderScreenshotSessions.size < MAX_RENDER_SCREENSHOT_SESSIONS) {
    return;
  }
  const oldest = [...renderScreenshotSessions.values()].sort(
    (a, b) => a.lastUsedAt - b.lastUsedAt
  )[0];
  if (oldest) {
    await closeRenderScreenshotSession(oldest.key);
  }
}

async function getOrCreateRenderScreenshotSession(
  pageUrl: string,
  viewport: { width: number; height: number }
): Promise<RenderScreenshotSession> {
  const key = renderScreenshotSessionKey(pageUrl, viewport);
  const existing = renderScreenshotSessions.get(key);
  if (existing && !existing.page.isClosed()) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  if (existing) {
    await closeRenderScreenshotSession(key);
  }
  await evictOldestRenderScreenshotSession();
  const browser = await getRenderScreenshotBrowser();
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const rec: RenderScreenshotSession = {
    key,
    context,
    page,
    lastUsedAt: Date.now(),
    queue: Promise.resolve(),
  };
  renderScreenshotSessions.set(key, rec);
  return rec;
}

/**
 * Best-effort rendered element screenshot for design mode.
 *
 * Why this exists:
 * - Browser-side SVG foreignObject capture is fast and usually good enough.
 * - Some real pages still defeat it (complex fonts, CSS variables, CSP quirks,
 *   weird sub-resources). When that path returns null, the client calls this
 *   helper so we can re-render the *same proxied page* in headless Chromium and
 *   screenshot the selected element by DOM child-index path.
 *
 * We intentionally navigate Chromium to the proxied `pageUrl` (which already
 * contains `__ocs_access` in the query string) so the rendered pixels match the
 * user's iframe as closely as possible.
 */
export async function captureRenderedElementScreenshot(
  input: RenderedElementScreenshotInput
): Promise<string | null> {
  const viewport = {
    width: sanitizeViewport(input.viewport.width, 1280),
    height: sanitizeViewport(input.viewport.height, 900),
  };
  const rec = await getOrCreateRenderScreenshotSession(input.pageUrl, viewport);
  const work = rec.queue.then(async () => {
    rec.lastUsedAt = Date.now();
    const page = rec.page;
    if (page.url() !== input.pageUrl) {
      await page.goto(input.pageUrl, { waitUntil: "domcontentloaded", timeout: 25_000 }).catch(() => {
        /* best effort */
      });
      // Old code waited for 6s networkidle on every capture; that's what made
      // design-mode fallbacks feel sluggish. For screenshots we mostly care
      // that layout + fonts have settled, not that every analytics beacon or
      // long-poll has gone quiet.
      await page.waitForTimeout(180).catch(() => undefined);
      await page
        .waitForFunction(
          () =>
            !(document as Document & { fonts?: { status?: string } }).fonts ||
            (document as Document & { fonts?: { status?: string } }).fonts?.status === "loaded",
          { timeout: 1_200 }
        )
        .catch(() => undefined);
    }
    if (input.scroll && (input.scroll.x || input.scroll.y)) {
      await page
        .evaluate(
          ({ x, y }) => {
            window.scrollTo(x, y);
          },
          {
            x: Math.max(0, Math.floor(input.scroll.x)),
            y: Math.max(0, Math.floor(input.scroll.y)),
          }
        )
        .catch(() => undefined);
      await page.waitForTimeout(60).catch(() => undefined);
    }

    const pathIndices = (input.pathIndices ?? [])
      .map((n) => Math.floor(n))
      .filter((n) => Number.isFinite(n) && n >= 0 && n < 4096);

    if (pathIndices.length > 0) {
      const handle = await page.evaluateHandle((path) => {
        let cur: Element | null = document.documentElement;
        for (const idx of path) {
          if (!cur || !cur.children || idx < 0 || idx >= cur.children.length) {
            return null;
          }
          cur = cur.children[idx] ?? null;
        }
        return cur;
      }, pathIndices);

      const element = handle.asElement();
      if (element) {
        try {
          await element.scrollIntoViewIfNeeded().catch(() => undefined);
          const png = await element.screenshot({
            type: "png",
            animations: "disabled",
            timeout: 15_000,
          });
          return `data:image/png;base64,${png.toString("base64")}`;
        } catch {
          /* try viewport clip fallback below */
        } finally {
          await handle.dispose().catch(() => undefined);
        }
      } else {
        await handle.dispose().catch(() => undefined);
      }
    }

    const clip = sanitizeClipRect(input.rect, viewport);
    if (!clip) {
      return null;
    }
    try {
      const png = await page.screenshot({
        type: "png",
        clip,
        animations: "disabled",
        timeout: 15_000,
      });
      return `data:image/png;base64,${png.toString("base64")}`;
    } catch {
      return null;
    }
  });
  rec.queue = work.then(() => undefined, () => undefined);
  try {
    return await work;
  } catch {
    // If a reused page got into a bad state (navigation crash, cross-process
    // teardown, etc.), drop the session so the next capture recreates it clean.
    await closeRenderScreenshotSession(rec.key).catch(() => undefined);
    return null;
  }
}

export async function createDebugSession(
  workspaceId: string,
  navigateUrl: string
): Promise<DebugSessionRecord> {
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) {
      await destroyDebugSession(oldest.id);
    }
  }

  const pw = await loadPlaywright();
  let context: BrowserContext | null = null;
  let userDataDir: string | null = null;
  try {
    userDataDir = await mkdtemp(path.join(tmpdir(), "cesium-cdp-"));
    // Pipe transport (Playwright default) + a real DevTools HTTP port for the
    // inspector proxy. Manual spawn + connectOverCDP is not used because the
    // websocket client path hangs under the Bun runtime.
    context = await pw.chromium.launchPersistentContext(userDataDir, {
      headless: true,
      env: {
        ...process.env,
        OPENCURSOR_PROCESS_NAME: "Cesium Browser - Headless Chromium",
      },
      args: [
        "--remote-debugging-port=0",
        "--remote-allow-origins=*",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--hide-scrollbars",
        "--mute-audio",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-popup-blocking",
      ],
    });
    const page = context.pages()[0] ?? (await context.newPage());

    const cdp = await context.newCDPSession(page);
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Network.enable");

    await page
      .goto(navigateUrl, { waitUntil: "domcontentloaded", timeout: 120_000 })
      .catch(() => {
        /* surfaced in DevTools console */
      });

    const debugPort = await readDevToolsActivePort(userDataDir);
    const targets = await fetchChromiumTargets(debugPort);
    const pageTarget = targets.find((t) => t.type === "page") ?? targets[0];
    if (!pageTarget) {
      throw new Error("Chromium did not report any debuggable targets");
    }

    const id = `bd-${randomUUID()}`;
    const rec: DebugSessionRecord = {
      id,
      workspaceId,
      browser: context.browser(),
      context,
      page,
      cdp,
      userDataDir,
      debugPort,
      targetId: pageTarget.id,
      rawDevtoolsFrontendUrl: pageTarget.devtoolsFrontendUrl,
      createdAt: Date.now(),
      eventSeq: 0,
      events: [],
    };
    installSessionEventCapture(rec);
    sessions.set(id, rec);
    return rec;
  } catch (err) {
    if (context) {
      await context.close().catch(() => undefined);
    }
    if (userDataDir) {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw err;
  }
}

export function getDebugSession(sessionId: string): DebugSessionRecord | undefined {
  return sessions.get(sessionId);
}

export function readDebugSessionEvents(
  sessionId: string,
  afterSeq = 0
): { events: BrowserDebugEvent[]; cursor: number } | null {
  const rec = sessions.get(sessionId);
  if (!rec) return null;
  const events = rec.events.filter((event) => event.seq > afterSeq);
  return { events, cursor: rec.eventSeq };
}

export async function captureDebugSessionViewport(
  sessionId: string,
  viewport?: { width?: number; height?: number } | null
): Promise<string | null> {
  const rec = sessions.get(sessionId);
  if (!rec) return null;
  if (viewport?.width || viewport?.height) {
    await rec.page
      .setViewportSize({
        width: sanitizeViewport(viewport.width ?? 1280, 1280),
        height: sanitizeViewport(viewport.height ?? 900, 900),
      })
      .catch(() => undefined);
  }
  const png = await rec.page.screenshot({
    type: "png",
    animations: "disabled",
    timeout: 15_000,
  });
  return `data:image/png;base64,${png.toString("base64")}`;
}

export async function dispatchDebugSessionInput(
  sessionId: string,
  input:
    | { type: "mouse"; action: "move" | "down" | "up" | "click"; x: number; y: number; button?: "left" | "middle" | "right" }
    | { type: "wheel"; deltaX?: number; deltaY?: number }
    | { type: "key"; action: "down" | "up" | "press" | "type"; key: string }
): Promise<boolean> {
  const rec = sessions.get(sessionId);
  if (!rec) return false;
  if (input.type === "mouse") {
    const x = Math.max(0, Math.floor(input.x));
    const y = Math.max(0, Math.floor(input.y));
    const button = input.button ?? "left";
    if (input.action === "move") await rec.page.mouse.move(x, y);
    else if (input.action === "down") await rec.page.mouse.down({ button });
    else if (input.action === "up") await rec.page.mouse.up({ button });
    else await rec.page.mouse.click(x, y, { button });
    return true;
  }
  if (input.type === "wheel") {
    await rec.page.mouse.wheel(input.deltaX ?? 0, input.deltaY ?? 0);
    return true;
  }
  if (input.type === "key") {
    if (input.action === "type") await rec.page.keyboard.type(input.key);
    else if (input.action === "down") await rec.page.keyboard.down(input.key);
    else if (input.action === "up") await rec.page.keyboard.up(input.key);
    else await rec.page.keyboard.press(input.key);
    return true;
  }
  return false;
}

export async function navigateDebugSession(
  sessionId: string,
  input:
    | { op: "goto"; url: string }
    | { op: "reload" | "back" | "forward"; url?: undefined }
): Promise<string | null> {
  const rec = sessions.get(sessionId);
  if (!rec) return null;
  const navOpts = { waitUntil: "commit" as const, timeout: 15_000 };
  if (input.op === "goto") {
    await rec.page.goto(input.url, navOpts).catch(() => undefined);
  } else if (input.op === "reload") {
    await rec.page.reload(navOpts).catch(() => undefined);
  } else if (input.op === "back") {
    await rec.page.goBack(navOpts).catch(() => undefined);
  } else if (input.op === "forward") {
    await rec.page.goForward(navOpts).catch(() => undefined);
  }
  return rec.page.url() || null;
}

export async function evaluateDebugSession(
  sessionId: string,
  script: string
): Promise<{ result: unknown; exception?: string }> {
  const rec = sessions.get(sessionId);
  if (!rec) {
    throw new Error("Unknown browser debug session.");
  }
  return await rec.page.evaluate((source) => {
    try {
      const value = (0, eval)(source);
      return { result: value };
    } catch (error) {
      return {
        result: null,
        exception: error instanceof Error ? error.message : String(error),
      };
    }
  }, script);
}

export async function snapshotDebugSession(sessionId: string): Promise<{
  title: string | null;
  url: string | null;
  visibleText: string;
  html: string;
  accessibilityText: string;
  elementRefs: Array<{
    ref: string;
    tag: string;
    text?: string;
    role?: string;
    selector?: string;
    rect?: { x: number; y: number; width: number; height: number };
  }>;
  truncated: boolean;
} | null> {
  const rec = sessions.get(sessionId);
  if (!rec) return null;
  const dom = await rec.page.evaluate(() => {
    const MAX_TEXT = 30_000;
    const MAX_HTML = 50_000;
    const MAX_ELEMENTS = 80;
    const selectorFor = (el: Element): string => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts: string[] = [];
      let current: Element | null = el;
      while (current && parts.length < 4) {
        const tag = current.tagName.toLowerCase();
        const parent: Element | null = current.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const siblings = [...parent.children].filter((child) => child.tagName === current?.tagName);
        const index = siblings.indexOf(current) + 1;
        parts.unshift(`${tag}:nth-of-type(${Math.max(1, index)})`);
        current = parent;
      }
      return parts.join(" > ");
    };
    const candidates = [...document.querySelectorAll("a,button,input,textarea,select,[role],summary")]
      .slice(0, MAX_ELEMENTS)
      .map((el, index) => {
        const rect = el.getBoundingClientRect();
        const text =
          (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
            ? el.placeholder || el.value
            : el.textContent || ""
          ).trim().replace(/\s+/g, " ").slice(0, 160);
        return {
          ref: `e${index + 1}`,
          tag: el.tagName.toLowerCase(),
          text: text || undefined,
          role: el.getAttribute("role") || undefined,
          selector: selectorFor(el),
          rect:
            rect.width > 0 && rect.height > 0
              ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
              : undefined,
        };
      });
    const text = (document.body?.innerText || "").slice(0, MAX_TEXT);
    const html = (document.documentElement?.outerHTML || "").slice(0, MAX_HTML);
    return {
      title: document.title || null,
      url: location.href,
      visibleText: text,
      html,
      elementRefs: candidates,
      truncated:
        (document.body?.innerText || "").length > MAX_TEXT ||
        (document.documentElement?.outerHTML || "").length > MAX_HTML,
    };
  });
  let accessibilityText = "";
  try {
    const ax = await rec.cdp.send("Accessibility.getFullAXTree", {});
    accessibilityText = JSON.stringify(ax ?? null).slice(0, 30_000);
  } catch {
    accessibilityText = "";
  }
  return { ...dom, accessibilityText };
}

export type DebugSessionScreencastFrame = {
  /** Base64 PNG frame data (no data: prefix). */
  data: string;
  /** Wall-clock capture time in ms. */
  ts: number;
};

type ScreencastState = {
  handler: (params: { data: string; sessionId: number }) => void;
};

const screencastStates = new Map<string, ScreencastState>();

/**
 * Start a CDP screencast on a debug session. Frames are delivered to `onFrame`
 * as base64 PNG payloads until `stopDebugSessionScreencast` is called. Only one
 * screencast per session is allowed.
 */
export async function startDebugSessionScreencast(
  sessionId: string,
  options: { maxWidth?: number; maxHeight?: number; everyNthFrame?: number },
  onFrame: (frame: DebugSessionScreencastFrame) => void
): Promise<boolean> {
  const rec = sessions.get(sessionId);
  if (!rec) return false;
  if (screencastStates.has(sessionId)) {
    throw new Error("A screencast is already running for this browser session.");
  }
  const handler = (params: { data: string; sessionId: number }) => {
    try {
      onFrame({ data: params.data, ts: Date.now() });
    } finally {
      rec.cdp
        .send("Page.screencastFrameAck", { sessionId: params.sessionId })
        .catch(() => undefined);
    }
  };
  rec.cdp.on("Page.screencastFrame", handler);
  screencastStates.set(sessionId, { handler });
  try {
    await rec.cdp.send("Page.startScreencast", {
      format: "png",
      maxWidth: sanitizeViewport(options.maxWidth ?? 1440, 1440),
      maxHeight: sanitizeViewport(options.maxHeight ?? 900, 900),
      everyNthFrame: Math.max(1, Math.min(Math.floor(options.everyNthFrame ?? 1), 10)),
    });
  } catch (error) {
    rec.cdp.off("Page.screencastFrame", handler);
    screencastStates.delete(sessionId);
    throw error;
  }
  return true;
}

export async function stopDebugSessionScreencast(sessionId: string): Promise<void> {
  const rec = sessions.get(sessionId);
  const state = screencastStates.get(sessionId);
  screencastStates.delete(sessionId);
  if (!rec || !state) return;
  rec.cdp.off("Page.screencastFrame", state.handler);
  await rec.cdp.send("Page.stopScreencast").catch(() => undefined);
}

export function isDebugSessionScreencasting(sessionId: string): boolean {
  return screencastStates.has(sessionId);
}

export async function destroyDebugSession(sessionId: string): Promise<void> {
  if (screencastStates.has(sessionId)) {
    await stopDebugSessionScreencast(sessionId).catch(() => undefined);
  }
  const rec = sessions.get(sessionId);
  if (!rec) {
    return;
  }
  sessions.delete(sessionId);
  try {
    await rec.context.close();
  } catch {
    /* ignore */
  }
  try {
    await rec.browser?.close();
  } catch {
    /* ignore */
  }
  await rm(rec.userDataDir, { recursive: true, force: true }).catch(() => undefined);
}

export function sessionBelongsToWorkspace(sessionId: string, workspaceId: string): boolean {
  const rec = sessions.get(sessionId);
  return Boolean(rec && rec.workspaceId === workspaceId);
}

export function listDebugSessions(): DebugSessionRecord[] {
  return [...sessions.values()];
}

/** Best-effort cleanup on process shutdown - close every Chromium we launched. */
function cleanupAllSessions(): void {
  for (const rec of sessions.values()) {
    try {
      void rec.context.close();
    } catch {
      /* ignore */
    }
  }
  sessions.clear();
  for (const rec of renderScreenshotSessions.values()) {
    try {
      void rec.context.close();
    } catch {
      /* ignore */
    }
  }
  renderScreenshotSessions.clear();
  if (renderScreenshotBrowserPromise) {
    void renderScreenshotBrowserPromise.then((browser) => browser.close()).catch(() => undefined);
    renderScreenshotBrowserPromise = null;
  }
}

process.once("SIGINT", () => {
  cleanupAllSessions();
});
process.once("SIGTERM", () => {
  cleanupAllSessions();
});
process.once("exit", () => {
  cleanupAllSessions();
});
