import { app, BrowserWindow, Menu, WebContentsView, ipcMain, shell, dialog, powerMonitor } from "electron";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startCesiumBackend } from "./main.mjs";
import { resolvePackagedDesktopDataDir } from "./desktop-data-dir.mjs";

process.title = "Cesium Desktop";
app.setName("Cesium Desktop");
if (process.platform === "win32") {
  app.setAppUserModelId("com.cesium.desktop");
}

const here = dirname(fileURLToPath(import.meta.url));
const APP_ICON_PATH = app.isPackaged
  ? resolve(process.resourcesPath, "build/icon.png")
  : resolve(here, "../build/icon.png");
let backend = null;
let mainWindow = null;
const smokeMode = process.argv.includes("--smoke");
let cleanupStarted = false;
const WORKSPACE_ROUTE = "/workspace";
const DOCS_PATH = "/docs";
const DOCS_ROUTE_QUERY_PARAM = "cesiumRoute";
const DOCS_ROUTE_QUERY_VALUE = "docs";
let docsWindow = null;
const nativeBrowserSessions = new Map();
const MAIN_RENDERER_UNRESPONSIVE_RECOVERY_MS = 18_000;
const MAIN_RENDERER_PROBE_TIMEOUT_MS = 8_000;
const MAIN_RENDERER_FOCUS_PROBE_IDLE_MS = 5 * 60_000;
const rendererLoadFailureHandlers = new WeakSet();
let mainRendererRecoveryTimer = null;
let mainRendererRecovering = false;
let mainRendererCrashReloading = false;
let mainRendererProbeInFlight = false;
let lastRendererFocusProbeAt = 0;
let desktopLifecycleHandlersInstalled = false;

function browserErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizedBounds(bounds, owner) {
  if (!bounds || typeof bounds !== "object") return { x: 0, y: 0, width: 0, height: 0 };
  const n = (value) => Math.max(0, Math.round(Number(value) || 0));
  const next = {
    x: n(bounds.x),
    y: n(bounds.y),
    width: n(bounds.width),
    height: n(bounds.height),
  };
  if (!owner || owner.isDestroyed()) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const content = owner.getContentBounds();
  const maxW = Math.max(1, content.width);
  const maxH = Math.max(1, content.height);
  if (next.width <= 0 || next.height <= 0) {
    return next;
  }
  if (next.width > maxW || next.height > maxH) {
    console.warn("[cesium-desktop] rejecting native browser bounds larger than window", next, {
      maxW,
      maxH,
    });
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const area = next.width * next.height;
  const windowArea = maxW * maxH;
  if (area > windowArea * 0.92) {
    console.warn("[cesium-desktop] rejecting native browser bounds covering the main window", next);
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return next;
}

function hasVisibleBounds(bounds) {
  return Boolean(bounds && bounds.width > 0 && bounds.height > 0);
}

function nativeBrowserCapabilitiesAvailable() {
  return Boolean(WebContentsView && mainWindow?.contentView?.addChildView);
}

function emitNativeBrowserEvent(rec, event) {
  if (!rec?.owner || rec.owner.isDestroyed()) return;
  rec.owner.webContents.send("cesium:browser-event", {
    sessionId: rec.id,
    ...event,
  });
}

function nativeNavigationState(rec, patch = {}) {
  const wc = rec.view.webContents;
  return {
    type: "navigation",
    url: wc.getURL() || null,
    title: wc.getTitle() || null,
    canGoBack: wc.canGoBack(),
    canGoForward: wc.canGoForward(),
    isLoading: wc.isLoading(),
    ...patch,
  };
}

function emitNativeNavigationState(rec, patch = {}) {
  emitNativeBrowserEvent(rec, nativeNavigationState(rec, patch));
}

function setNativeBrowserViewAttached(rec, attached) {
  if (!rec?.owner || rec.owner.isDestroyed() || !rec.view || rec.view.webContents.isDestroyed()) {
    return;
  }
  if (attached && !rec.attached) {
    rec.owner.contentView.addChildView(rec.view);
    rec.attached = true;
    return;
  }
  if (!attached && rec.attached) {
    try {
      rec.owner.contentView.removeChildView(rec.view);
    } catch {
      /* ignore */
    }
    rec.attached = false;
  }
}

function setNativeBrowserBounds(rec, bounds) {
  rec.bounds = normalizedBounds(bounds, rec.owner);
  if (!hasVisibleBounds(rec.bounds)) {
    try {
      rec.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    } catch {
      /* ignore */
    }
    setNativeBrowserViewAttached(rec, false);
    return;
  }
  if (!rec.readyToAttach) {
    return;
  }
  setNativeBrowserViewAttached(rec, true);
  rec.view.setBounds(rec.bounds);
}

function markNativeBrowserReadyToAttach(rec) {
  if (!rec || rec.readyToAttach) {
    return;
  }
  rec.readyToAttach = true;
  if (hasVisibleBounds(rec.bounds)) {
    setNativeBrowserBounds(rec, rec.bounds);
  }
}

function setNativeBrowserDevtoolsAttached(rec, attached) {
  if (!rec?.owner || rec.owner.isDestroyed() || !rec.devtoolsView || rec.devtoolsView.webContents.isDestroyed()) {
    return;
  }
  if (attached && !rec.devtoolsAttached) {
    rec.owner.contentView.addChildView(rec.devtoolsView);
    rec.devtoolsAttached = true;
    return;
  }
  if (!attached && rec.devtoolsAttached) {
    try {
      rec.owner.contentView.removeChildView(rec.devtoolsView);
    } catch {
      /* ignore */
    }
    rec.devtoolsAttached = false;
  }
}

function setNativeBrowserDevtoolsBounds(rec, bounds) {
  rec.devtoolsBounds = normalizedBounds(bounds, rec.owner);
  if (!rec.devtoolsView || !hasVisibleBounds(rec.devtoolsBounds)) {
    if (rec.devtoolsView) {
      try {
        rec.devtoolsView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      } catch {
        /* ignore */
      }
    }
    setNativeBrowserDevtoolsAttached(rec, false);
    return;
  }
  setNativeBrowserDevtoolsAttached(rec, true);
  rec.devtoolsView.setBounds(rec.devtoolsBounds);
}

function installNativeBrowserContextMenu(rec) {
  rec.view.webContents.on("context-menu", (_event, params) => {
    const template = [];
    if (params.linkURL) {
      template.push({
        label: "Open Link Externally",
        click: () => shell.openExternal(params.linkURL).catch(() => undefined),
      });
    }
    if (params.isEditable) {
      template.push(
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      );
    } else if (params.selectionText) {
      template.push({ role: "copy" });
    } else {
      template.push(
        { label: "Back", enabled: rec.view.webContents.canGoBack(), click: () => rec.view.webContents.goBack() },
        { label: "Forward", enabled: rec.view.webContents.canGoForward(), click: () => rec.view.webContents.goForward() },
        { label: "Reload", click: () => rec.view.webContents.reload() }
      );
    }
    template.push(
      { type: "separator" },
      {
        label: "Inspect Element",
        click: () => rec.view.webContents.inspectElement(params.x, params.y),
      }
    );
    Menu.buildFromTemplate(template).popup({ window: rec.owner });
  });
}

function installNativeBrowserDebugger(rec) {
  const wc = rec.view.webContents;
  try {
    wc.debugger.attach("1.3");
    wc.debugger.sendCommand("Runtime.enable").catch(() => undefined);
    wc.debugger.sendCommand("Log.enable").catch(() => undefined);
  } catch {
    return;
  }
  wc.debugger.on("message", (_event, method, params) => {
    if (method === "Runtime.consoleAPICalled") {
      const text = (params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.type ?? "")
        .filter(Boolean)
        .join(" ");
      emitNativeBrowserEvent(rec, {
        type: "console",
        entry: {
          id: `console-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          ts: Date.now(),
          level: params.type === "error" ? "error" : params.type === "warning" ? "warning" : "log",
          source: "console",
          text,
          url: params.stackTrace?.callFrames?.[0]?.url,
          lineNumber: params.stackTrace?.callFrames?.[0]?.lineNumber,
          columnNumber: params.stackTrace?.callFrames?.[0]?.columnNumber,
        },
      });
    } else if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails ?? {};
      emitNativeBrowserEvent(rec, {
        type: "console",
        entry: {
          id: `exception-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          ts: Date.now(),
          level: "error",
          source: "exception",
          text: details.text || details.exception?.description || "Uncaught exception",
          url: details.url,
          lineNumber: details.lineNumber,
          columnNumber: details.columnNumber,
        },
      });
    } else if (method === "Log.entryAdded") {
      const entry = params.entry ?? {};
      emitNativeBrowserEvent(rec, {
        type: "console",
        entry: {
          id: `log-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          ts: Date.now(),
          level: entry.level === "error" ? "error" : entry.level === "warning" ? "warning" : "info",
          source: "log",
          text: entry.text ?? "",
          url: entry.url,
          lineNumber: entry.lineNumber,
        },
      });
    } else if (method === "Network.responseReceived") {
      const response = params.response ?? {};
      if (response.status && response.status < 400) return;
      emitNativeBrowserEvent(rec, {
        type: "network",
        entry: {
          id: params.requestId ?? `network-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          ts: Date.now(),
          url: response.url ?? "",
          status: response.status,
          statusText: response.statusText,
          resourceType: params.type,
        },
      });
    }
  });
}

function createNativeBrowserSession(owner, tabId, url) {
  if (!nativeBrowserCapabilitiesAvailable()) {
    throw new Error("Native browser views are not available in this Electron runtime.");
  }
  const browserProcessName = `Cesium Browser Tab${tabId ? ` ${tabId}` : ""}`;
  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: true,
      additionalArguments: [`--cesium-process-name=${browserProcessName}`],
    },
  });
  const id = `nb-${randomUUID()}`;
  const rec = {
    id,
    tabId,
    owner,
    view,
    devtoolsView: null,
    attached: false,
    devtoolsAttached: false,
    readyToAttach: false,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    devtoolsBounds: { x: 0, y: 0, width: 0, height: 0 },
    unresponsiveTimer: null,
  };
  nativeBrowserSessions.set(id, rec);
  view.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
    void view.webContents.loadURL(nextUrl).catch((error) => {
      emitNativeBrowserEvent(rec, { type: "error", message: browserErrorMessage(error) });
    });
    return { action: "deny" };
  });
  view.webContents.on("did-start-loading", () => emitNativeNavigationState(rec, { isLoading: true }));
  view.webContents.on("dom-ready", () => {
    markNativeBrowserReadyToAttach(rec);
    emitNativeNavigationState(rec, { isLoading: rec.view.webContents.isLoading() });
  });
  view.webContents.on("did-stop-loading", () => {
    markNativeBrowserReadyToAttach(rec);
    emitNativeNavigationState(rec, { isLoading: false });
  });
  view.webContents.on("did-finish-load", () => {
    markNativeBrowserReadyToAttach(rec);
    emitNativeNavigationState(rec, { isLoading: false });
  });
  view.webContents.on("did-navigate", () => emitNativeNavigationState(rec));
  view.webContents.on("did-navigate-in-page", () => emitNativeNavigationState(rec));
  view.webContents.on("page-title-updated", (_event, title) => emitNativeNavigationState(rec, { title }));
  view.webContents.on("page-favicon-updated", (_event, favicons) => {
    emitNativeNavigationState(rec, { faviconUrl: Array.isArray(favicons) ? favicons[0] : null });
  });
  view.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    markNativeBrowserReadyToAttach(rec);
    emitNativeNavigationState(rec, { isLoading: false });
    emitNativeBrowserEvent(rec, {
      type: "error",
      message: `${errorDescription || "Navigation failed"} (${errorCode}) for ${validatedURL || url}`,
    });
  });
  view.webContents.on("unresponsive", () => {
    if (rec.unresponsiveTimer) {
      clearTimeout(rec.unresponsiveTimer);
    }
    rec.unresponsiveTimer = setTimeout(() => {
      rec.unresponsiveTimer = null;
      emitNativeBrowserEvent(rec, {
        type: "error",
        message: "Browser renderer stayed unresponsive for 12s.",
      });
    }, 12_000);
  });
  view.webContents.on("responsive", () => {
    if (rec.unresponsiveTimer) {
      clearTimeout(rec.unresponsiveTimer);
      rec.unresponsiveTimer = null;
    }
  });
  view.webContents.on("render-process-gone", (_event, details) => {
    console.error("[cesium-desktop] native browser renderer gone", rec.id, details);
    try {
      setNativeBrowserViewAttached(rec, false);
      rec.readyToAttach = false;
    } catch {
      /* ignore */
    }
    emitNativeBrowserEvent(rec, {
      type: "error",
      message: `Browser renderer exited: ${details.reason}`,
    });
    destroyNativeBrowserSession(rec.id);
  });
  installNativeBrowserContextMenu(rec);
  installNativeBrowserDebugger(rec);
  view.webContents.loadURL(url).catch((error) => {
    emitNativeBrowserEvent(rec, { type: "error", message: browserErrorMessage(error) });
  });
  return rec;
}

function destroyNativeBrowserSession(id) {
  const rec = nativeBrowserSessions.get(id);
  if (!rec) return;
  nativeBrowserSessions.delete(id);
  try {
    if (rec.unresponsiveTimer) {
      clearTimeout(rec.unresponsiveTimer);
      rec.unresponsiveTimer = null;
    }
  } catch {
    /* ignore */
  }
  try {
    if (rec.devtoolsView) {
      setNativeBrowserDevtoolsAttached(rec, false);
      rec.devtoolsView.webContents.close();
    }
  } catch {
    /* ignore */
  }
  try {
    setNativeBrowserViewAttached(rec, false);
  } catch {
    /* ignore */
  }
  try {
    if (rec.view.webContents.debugger.isAttached()) {
      rec.view.webContents.debugger.detach();
    }
  } catch {
    /* ignore */
  }
  try {
    rec.view.webContents.close();
  } catch {
    /* ignore */
  }
}

function destroyNativeBrowserSessionsForWindow(win) {
  for (const rec of nativeBrowserSessions.values()) {
    if (rec.owner === win) {
      destroyNativeBrowserSession(rec.id);
    }
  }
}

function attachRendererNavigationGuards(webContents) {
  webContents.on("will-navigate", (event, url) => {
    if (isExpectedRendererNavigation(url)) {
      return;
    }
    console.warn("[cesium-desktop] blocked top-level navigation", url);
    event.preventDefault();
  });
  webContents.setWindowOpenHandler(({ url }) => {
    console.warn("[cesium-desktop] blocked renderer popup", url);
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url).catch(() => undefined);
    }
    return { action: "deny" };
  });
}

const RECOVERY_HTML =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    "<!doctype html><html><body style='margin:0;background:#191919;color:#e5e5e5;font:14px system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh'>Recovering Cesium…</body></html>"
  );

function clearMainRendererRecoveryTimer() {
  if (mainRendererRecoveryTimer) {
    clearTimeout(mainRendererRecoveryTimer);
    mainRendererRecoveryTimer = null;
  }
}

async function recoverMainRenderer(win, reason) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed() || mainRendererRecovering) {
    return;
  }
  if (!backend?.baseUrl) {
    console.warn("[cesium-desktop] renderer recovery skipped before backend ready", reason);
    return;
  }
  mainRendererRecovering = true;
  mainRendererCrashReloading = false;
  clearMainRendererRecoveryTimer();
  console.warn("[cesium-desktop] recovering main renderer", reason);
  destroyNativeBrowserSessionsForWindow(win);
  try {
    if (typeof win.webContents.forcefullyCrashRenderer === "function") {
      mainRendererCrashReloading = true;
      win.webContents.forcefullyCrashRenderer();
      win.webContents.reload();
      return;
    }
    await win.webContents.loadURL(RECOVERY_HTML);
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      await loadMainRenderer(win);
    }
  } catch (error) {
    mainRendererCrashReloading = false;
    console.error("[cesium-desktop] failed to recover main renderer", error);
  } finally {
    if (!mainRendererCrashReloading) {
      mainRendererRecovering = false;
    }
  }
}

function scheduleMainRendererRecovery(win, reason) {
  if (mainRendererRecoveryTimer || mainRendererRecovering) {
    return;
  }
  mainRendererRecoveryTimer = setTimeout(() => {
    mainRendererRecoveryTimer = null;
    void recoverMainRenderer(win, reason);
  }, MAIN_RENDERER_UNRESPONSIVE_RECOVERY_MS);
}

async function probeMainRenderer(win, reason) {
  if (
    !win ||
    win.isDestroyed() ||
    win.webContents.isDestroyed() ||
    win.webContents.isLoading() ||
    mainRendererRecovering ||
    mainRendererProbeInFlight
  ) {
    return;
  }
  mainRendererProbeInFlight = true;
  try {
    await Promise.race([
      win.webContents.executeJavaScript("globalThis.__cesiumDesktopProbeAt = Date.now(); true", true),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("renderer probe timed out")), MAIN_RENDERER_PROBE_TIMEOUT_MS)
      ),
    ]);
  } catch (error) {
    console.warn("[cesium-desktop] renderer probe failed", reason, error);
    await recoverMainRenderer(win, reason);
  } finally {
    mainRendererProbeInFlight = false;
  }
}

function installRendererHealthRecovery(win) {
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("[cesium-desktop] renderer process gone", details);
    clearMainRendererRecoveryTimer();
    destroyNativeBrowserSessionsForWindow(win);
    if (mainRendererCrashReloading) {
      return;
    }
    if (win.isDestroyed()) {
      return;
    }
    setTimeout(() => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) {
        return;
      }
      void win.webContents
        .loadURL(RECOVERY_HTML)
        .catch(() => undefined)
        .finally(() => {
          if (win.isDestroyed() || win.webContents.isDestroyed()) {
            return;
          }
          void loadMainRenderer(win).catch((error) => {
            console.error("[cesium-desktop] failed to reload renderer after crash", error);
          });
        });
    }, 250);
  });
  win.webContents.on("unresponsive", () => {
    console.warn("[cesium-desktop] renderer became unresponsive");
    scheduleMainRendererRecovery(win, "renderer stayed unresponsive");
  });
  win.webContents.on("responsive", () => {
    console.info("[cesium-desktop] renderer became responsive");
    mainRendererRecovering = false;
    mainRendererCrashReloading = false;
    clearMainRendererRecoveryTimer();
  });
  win.webContents.on("did-finish-load", () => {
    mainRendererRecovering = false;
    mainRendererCrashReloading = false;
    clearMainRendererRecoveryTimer();
  });
  win.webContents.on(
    "did-fail-load",
    (_event, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame) {
        return;
      }
      mainRendererRecovering = false;
      mainRendererCrashReloading = false;
      clearMainRendererRecoveryTimer();
    }
  );
}

function createRendererBrowserWindow(options = {}) {
  return new BrowserWindow({
    title: options.title ?? "Cesium",
    icon: APP_ICON_PATH,
    show: options.show ?? true,
    width: options.width ?? 1440,
    height: options.height ?? 960,
    minWidth: options.minWidth ?? 980,
    minHeight: options.minHeight ?? 640,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: "#191919",
    webPreferences: {
      preload: resolve(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
}

function resolvePackagedRendererIndexPath() {
  return resolve(process.resourcesPath, "desktop-renderer/index.html");
}

function buildDocsRendererUrl(sourceWebContents) {
  const configuredRendererUrl = process.env.OPENCURSOR_DESKTOP_RENDERER_URL;
  if (configuredRendererUrl) {
    const url = new URL(configuredRendererUrl);
    url.pathname = DOCS_PATH;
    url.hash = "";
    if (backend?.baseUrl) {
      url.searchParams.set("serverUrl", backend.baseUrl);
    } else {
      url.search = "";
    }
    return url.toString();
  }

  try {
    const url = new URL(sourceWebContents.getURL());
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.pathname = DOCS_PATH;
      url.search = "";
      url.hash = "";
      return url.toString();
    }
  } catch {
    // Fall through to packaged file renderer.
  }

  return null;
}

function docsUrlLooksLoaded(rawUrl) {
  if (!rawUrl) {
    return false;
  }
  return (
    rawUrl.includes(DOCS_PATH) ||
    rawUrl.includes(`${DOCS_ROUTE_QUERY_PARAM}=${DOCS_ROUTE_QUERY_VALUE}`)
  );
}

async function loadDocsInWindow(targetWindow, sourceWebContents) {
  const docsUrl = buildDocsRendererUrl(sourceWebContents);
  if (docsUrl) {
    await targetWindow.loadURL(docsUrl);
    return;
  }

  const rendererIndex = resolvePackagedRendererIndexPath();
  await targetWindow.loadFile(rendererIndex, {
    query: { [DOCS_ROUTE_QUERY_PARAM]: DOCS_ROUTE_QUERY_VALUE },
  });
}

async function openDocsWindow(sourceWebContents) {
  if (docsWindow && !docsWindow.isDestroyed()) {
    docsWindow.focus();
    const currentUrl = docsWindow.webContents.getURL();
    if (!docsUrlLooksLoaded(currentUrl)) {
      await loadDocsInWindow(docsWindow, sourceWebContents);
    }
    return;
  }

  docsWindow = createRendererBrowserWindow({
    title: "Cesium Docs",
    width: 1080,
    height: 820,
    minWidth: 720,
    minHeight: 520,
  });
  Menu.setApplicationMenu(null);
  attachRendererNavigationGuards(docsWindow.webContents);
  docsWindow.on("closed", () => {
    docsWindow = null;
  });
  await loadDocsInWindow(docsWindow, sourceWebContents);
}

function isExpectedRendererNavigation(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "file:") {
      return true;
    }
    const configuredRendererUrl = process.env.OPENCURSOR_DESKTOP_RENDERER_URL;
    if (configuredRendererUrl) {
      const renderer = new URL(configuredRendererUrl);
      return url.origin === renderer.origin;
    }
  } catch {
    return false;
  }
  return false;
}

function buildConfiguredRendererUrl(rendererUrl, backendBaseUrl) {
  try {
    const url = new URL(rendererUrl);
    if (url.pathname === "" || url.pathname === "/") {
      url.pathname = WORKSPACE_ROUTE;
    }
    url.searchParams.set("serverUrl", backendBaseUrl);
    return url.toString();
  } catch {
    const separator = rendererUrl.includes("?") ? "&" : "?";
    return `${rendererUrl}${separator}serverUrl=${encodeURIComponent(backendBaseUrl)}`;
  }
}

console.log("[cesium-desktop] main starting", {
  isPackaged: app.isPackaged,
  smokeMode,
  argv: process.argv,
});

function showRendererLoadFailure(win, details) {
  const code = details?.errorCode ?? "unknown";
  const description = details?.errorDescription ?? "Unknown load failure";
  const url = details?.validatedURL ?? details?.url ?? "unknown URL";
  console.error("[cesium-desktop] renderer load failed", { code, description, url });
  dialog.showMessageBox(win, {
    type: "error",
    title: "Cesium failed to load",
    message: "The desktop UI could not be loaded.",
    detail: `${description}\n\n${url}\n\nIf you launched from a terminal, run npm run dev:desktop from the repo root instead of electron . alone.`,
  }).catch(() => undefined);
}

async function loadMainRenderer(win) {
  const configuredRendererUrl = process.env.OPENCURSOR_DESKTOP_RENDERER_URL;
  const devRendererUrl = app.isPackaged ? null : "http://127.0.0.1:5173";
  const rendererUrl = configuredRendererUrl ?? devRendererUrl;

  if (!rendererLoadFailureHandlers.has(win.webContents)) {
    rendererLoadFailureHandlers.add(win.webContents);
    win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) {
        return;
      }
      showRendererLoadFailure(win, {
        errorCode,
        errorDescription,
        validatedURL,
      });
    });
  }

  if (rendererUrl) {
    const url = configuredRendererUrl
      ? buildConfiguredRendererUrl(rendererUrl, backend.baseUrl)
      : `${rendererUrl}${WORKSPACE_ROUTE}?serverUrl=${encodeURIComponent(backend.baseUrl)}`;
    console.log("[cesium-desktop] loading renderer", url);
    await win.loadURL(url);
    return;
  }

  const rendererIndex = resolvePackagedRendererIndexPath();
  console.log("[cesium-desktop] loading packaged renderer", rendererIndex, backend.baseUrl);
  await win.loadFile(rendererIndex, {
    query: { serverUrl: backend.baseUrl },
  });
}

async function createMainWindow(options = {}) {
  const userDataPath = app.getPath("userData");
  const dataDir = app.isPackaged
    ? resolvePackagedDesktopDataDir(userDataPath)
    : resolve(userDataPath, "server-data");

  mainWindow = createRendererBrowserWindow({ show: false });
  mainWindow.on("closed", () => {
    destroyNativeBrowserSessionsForWindow(mainWindow);
    mainWindow = null;
  });
  Menu.setApplicationMenu(null);

  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error("[cesium-desktop] preload failed", preloadPath, error);
  });
  attachRendererNavigationGuards(mainWindow.webContents);
  installRendererHealthRecovery(mainWindow);

  console.log("[cesium-desktop] starting backend");
  backend = await startCesiumBackend({ dataDir });
  console.log("[cesium-desktop] backend ready", backend.baseUrl);

  await loadMainRenderer(mainWindow);
  if (options.show ?? true) {
    mainWindow.show();
  }
  if (options.closeAfterLoad) {
    mainWindow.close();
  }
}

function installDesktopLifecycleHandlers() {
  if (desktopLifecycleHandlersInstalled) {
    return;
  }
  desktopLifecycleHandlersInstalled = true;

  powerMonitor.on("resume", () => {
    console.info("[cesium-desktop] system resumed");
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    setTimeout(() => {
      void probeMainRenderer(mainWindow, "system resume");
    }, 1_000);
  });

  powerMonitor.on("suspend", () => {
    console.info("[cesium-desktop] system suspending");
  });
}

const gotLock = app.isPackaged ? app.requestSingleInstanceLock() : true;
console.log("[cesium-desktop] single instance lock", gotLock);
if (!gotLock && process.env.CESIUM_STRICT_SINGLE_INSTANCE_LOCK === "1") {
  console.error("[cesium-desktop] another desktop instance already has the lock");
  app.quit();
} else {
  if (!gotLock) {
    console.warn("[cesium-desktop] single instance lock unavailable; continuing startup");
  }
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      void probeMainRenderer(mainWindow, "second-instance focus");
    }
  });

  app.whenReady().then(async () => {
    app.setName("Cesium Desktop");
    installDesktopLifecycleHandlers();
    if (smokeMode) {
      await createMainWindow({ show: false, closeAfterLoad: true });
      console.log(`Cesium packaged smoke passed at ${backend?.baseUrl ?? "unknown backend"}`);
      cleanupBackend();
      app.quit();
      return;
    }
    await createMainWindow();
  }).catch((error) => {
    console.error("[cesium-desktop] failed to start", error);
    dialog.showErrorBox(
      "Cesium failed to start",
      error instanceof Error ? error.stack ?? error.message : String(error)
    );
    app.quit();
  });
}

app.on("browser-window-focus", (_event, win) => {
  if (win !== mainWindow) {
    return;
  }
  const now = Date.now();
  if (now - lastRendererFocusProbeAt < MAIN_RENDERER_FOCUS_PROBE_IDLE_MS) {
    return;
  }
  lastRendererFocusProbeAt = now;
  void probeMainRenderer(win, "window focus after idle");
});

ipcMain.handle("cesium:get-backend-info", () => ({
  baseUrl: backend?.baseUrl ?? null,
  port: backend?.port ?? null,
}));

const TASKBAR_GOAL_PROGRESS_MODES = new Set(["normal", "paused", "error", "indeterminate"]);

function normalizeTaskbarGoalProgress(input) {
  if (!input || typeof input !== "object" || input.active === false || input.mode === "none") {
    return { active: false };
  }
  const mode = TASKBAR_GOAL_PROGRESS_MODES.has(input.mode) ? input.mode : "normal";
  if (mode === "indeterminate") {
    return { active: true, progress: 2, mode };
  }
  const rawPercent = Number(input.progressPercent);
  if (!Number.isFinite(rawPercent)) {
    return { active: false };
  }
  const percent = Math.max(0, Math.min(100, Math.round(rawPercent)));
  return {
    active: true,
    progress: percent / 100,
    mode,
  };
}

ipcMain.handle("cesium:set-taskbar-goal-progress", (event, input) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  if (!win || win.isDestroyed()) {
    return false;
  }
  const progress = normalizeTaskbarGoalProgress(input);
  try {
    if (!progress.active) {
      win.setProgressBar(-1);
      return true;
    }
    win.setProgressBar(progress.progress, { mode: progress.mode });
    return true;
  } catch (error) {
    console.warn("[cesium-desktop] failed to set taskbar goal progress", error);
    return false;
  }
});

ipcMain.handle("cesium:open-external", async (_event, url) => {
  if (typeof url !== "string") return false;
  // A compromised renderer must not be able to launch arbitrary protocol
  // handlers (file:, smb:, custom app schemes) through the main process.
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) {
    console.warn("[cesium-desktop] blocked open-external for scheme", parsed.protocol);
    return false;
  }
  await shell.openExternal(url);
  return true;
});

ipcMain.handle("cesium:open-docs-window", async (event) => {
  try {
    await openDocsWindow(event.sender);
    return true;
  } catch (error) {
    console.error("[cesium-desktop] failed to open docs window", error);
    return false;
  }
});

ipcMain.handle("cesium:browser-available", () => nativeBrowserCapabilitiesAvailable());

/** Local file browsing is opt-in: a compromised renderer must not get a native view onto arbitrary disk paths. */
const BROWSER_FILE_URLS_ALLOWED = process.env.OPENCURSOR_BROWSER_ALLOW_FILE_URLS === "1";

function isAllowedBrowserUrl(url) {
  if (typeof url !== "string" || !url) return false;
  if (url === "about:blank") return true;
  if (/^https?:\/\//i.test(url)) return true;
  return BROWSER_FILE_URLS_ALLOWED && /^file:\/\//i.test(url);
}

ipcMain.handle("cesium:browser-create", async (event, input) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner.isDestroyed()) {
    throw new Error("No owning BrowserWindow for native browser session.");
  }
  const url = typeof input?.url === "string" ? input.url : "";
  if (!isAllowedBrowserUrl(url)) {
    throw new Error(
      "Native browser sessions require an absolute http(s) URL (file:// needs OPENCURSOR_BROWSER_ALLOW_FILE_URLS=1)."
    );
  }
  const rec = createNativeBrowserSession(owner, String(input?.tabId ?? ""), url);
  return { id: rec.id, kind: "electron-native", url: rec.view.webContents.getURL() || url };
});

ipcMain.handle("cesium:browser-destroy", async (_event, sessionId) => {
  destroyNativeBrowserSession(String(sessionId ?? ""));
});

ipcMain.handle("cesium:browser-set-bounds", async (_event, sessionId, bounds) => {
  const rec = nativeBrowserSessions.get(String(sessionId ?? ""));
  if (!rec) return false;
  setNativeBrowserBounds(rec, bounds);
  return true;
});

ipcMain.handle("cesium:browser-set-devtools-bounds", async (_event, sessionId, bounds) => {
  const rec = nativeBrowserSessions.get(String(sessionId ?? ""));
  if (!rec?.devtoolsView) return false;
  setNativeBrowserDevtoolsBounds(rec, bounds);
  return true;
});

ipcMain.handle("cesium:browser-devtools", async (_event, sessionId, open) => {
  const rec = nativeBrowserSessions.get(String(sessionId ?? ""));
  if (!rec) return false;
  if (open) {
    if (!rec.devtoolsView) {
      rec.devtoolsView = new WebContentsView({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          devTools: false,
          additionalArguments: ["--cesium-process-name=Cesium Browser DevTools"],
        },
      });
      rec.view.webContents.setDevToolsWebContents(rec.devtoolsView.webContents);
      setNativeBrowserDevtoolsBounds(rec, rec.devtoolsBounds);
    }
    rec.view.webContents.openDevTools({ mode: "detach" });
    return true;
  }
  rec.view.webContents.closeDevTools();
  if (rec.devtoolsView) {
    try {
      setNativeBrowserDevtoolsAttached(rec, false);
      rec.devtoolsView.webContents.close();
    } catch {
      /* ignore */
    }
    rec.devtoolsView = null;
  }
  return true;
});

ipcMain.handle("cesium:browser-command", async (_event, sessionId, command) => {
  const rec = nativeBrowserSessions.get(String(sessionId ?? ""));
  if (!rec) return null;
  const wc = rec.view.webContents;
  const op = command?.op;
  try {
    if (op === "goto") {
      if (typeof command?.url !== "string") throw new Error("Expected url.");
      // Same policy as session creation; otherwise goto trivially bypasses it.
      if (!isAllowedBrowserUrl(command.url)) {
        throw new Error("Blocked navigation to a non-http(s) URL.");
      }
      await wc.loadURL(command.url);
    } else if (op === "reload") {
      wc.reload();
    } else if (op === "stop") {
      wc.stop();
    } else if (op === "back") {
      if (wc.canGoBack()) wc.goBack();
    } else if (op === "forward") {
      if (wc.canGoForward()) wc.goForward();
    } else if (op === "focus") {
      wc.focus();
    } else if (op === "copy") {
      wc.copy();
    } else if (op === "paste") {
      wc.paste();
    } else if (op === "cut") {
      wc.cut();
    } else if (op === "selectAll") {
      wc.selectAll();
    } else if (op === "undo") {
      wc.undo();
    } else if (op === "redo") {
      wc.redo();
    }
    return nativeNavigationState(rec);
  } catch (error) {
    const message = browserErrorMessage(error);
    emitNativeBrowserEvent(rec, { type: "error", message });
    return { type: "error", message };
  }
});

/**
 * Page-scoped inspection domains only. Browser-wide and capability-granting
 * domains (Target, Browser, Storage, Network cookie access, IO, Tracing) stay
 * blocked so a compromised renderer cannot escalate through raw CDP.
 */
const CDP_ALLOWED_DOMAINS = new Set([
  "Runtime",
  "Page",
  "DOM",
  "CSS",
  "Console",
  "Log",
  "Performance",
  "Profiler",
  "Accessibility",
  "Overlay",
  "Emulation",
]);
/** Filesystem-reaching methods inside otherwise-allowed domains. */
const CDP_DENIED_METHODS = new Set(["Page.setDownloadBehavior", "DOM.setFileInputFiles"]);

function isAllowedCdpMethod(method) {
  if (typeof method !== "string" || !method.includes(".")) return false;
  if (CDP_DENIED_METHODS.has(method)) return false;
  return CDP_ALLOWED_DOMAINS.has(method.split(".", 1)[0]);
}

ipcMain.handle("cesium:browser-cdp-command", async (_event, sessionId, method, params = {}) => {
  const rec = nativeBrowserSessions.get(String(sessionId ?? ""));
  if (!rec) return null;
  if (!isAllowedCdpMethod(String(method))) {
    console.warn("[cesium-desktop] blocked CDP method", method);
    return { error: `CDP method not allowed: ${String(method)}` };
  }
  const wc = rec.view.webContents;
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach("1.3");
    }
    return await wc.debugger.sendCommand(String(method), params && typeof params === "object" ? params : {});
  } catch (error) {
    const message = browserErrorMessage(error);
    emitNativeBrowserEvent(rec, { type: "error", message });
    return { error: message };
  }
});

ipcMain.handle("cesium:browser-capture-page", async (_event, sessionId) => {
  const rec = nativeBrowserSessions.get(String(sessionId ?? ""));
  if (!rec) return null;
  try {
    const image = await rec.view.webContents.capturePage();
    return {
      imageDataUrl: image.toDataURL(),
      url: rec.view.webContents.getURL() || null,
    };
  } catch (error) {
    const message = browserErrorMessage(error);
    emitNativeBrowserEvent(rec, { type: "error", message });
    return { error: message };
  }
});

ipcMain.handle("cesium:browser-dispatch-input", async (_event, sessionId, input) => {
  const rec = nativeBrowserSessions.get(String(sessionId ?? ""));
  if (!rec) return false;
  try {
    const wc = rec.view.webContents;
    wc.focus();
    if (input?.type === "mouse") {
      const eventBase = {
        x: Math.max(0, Math.floor(Number(input.x) || 0)),
        y: Math.max(0, Math.floor(Number(input.y) || 0)),
        button: input.button ?? "left",
      };
      if (input.action === "click") {
        wc.sendInputEvent({
          type: "mouseDown",
          ...eventBase,
          clickCount: 1,
        });
        wc.sendInputEvent({
          type: "mouseUp",
          ...eventBase,
          clickCount: 1,
        });
      } else {
        wc.sendInputEvent({
          type:
            input.action === "down"
              ? "mouseDown"
              : input.action === "up"
                ? "mouseUp"
                : "mouseMove",
          ...eventBase,
          clickCount: input.action === "down" || input.action === "up" ? 1 : 0,
        });
      }
      return true;
    }
    if (input?.type === "key") {
      if (input.action === "type") {
        await wc.insertText(String(input.key ?? ""));
      } else {
        const keyCode = String(input.key ?? "");
        if (input.action === "press") {
          wc.sendInputEvent({ type: "keyDown", keyCode });
          wc.sendInputEvent({ type: "keyUp", keyCode });
        } else {
          wc.sendInputEvent({ type: input.action === "up" ? "keyUp" : "keyDown", keyCode });
        }
      }
      return true;
    }
    return false;
  } catch (error) {
    const message = browserErrorMessage(error);
    emitNativeBrowserEvent(rec, { type: "error", message });
    return false;
  }
});

ipcMain.handle("cesium:browser-set-emulation", async (_event, sessionId, metrics) => {
  const rec = nativeBrowserSessions.get(String(sessionId ?? ""));
  if (!rec) return false;
  try {
    if (!rec.view.webContents.debugger.isAttached()) {
      rec.view.webContents.debugger.attach("1.3");
    }
    await rec.view.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: Math.max(1, Math.floor(Number(metrics?.width) || rec.bounds.width || 1280)),
      height: Math.max(1, Math.floor(Number(metrics?.height) || rec.bounds.height || 900)),
      deviceScaleFactor: Number(metrics?.deviceScaleFactor) || 1,
      mobile: Boolean(metrics?.mobile),
    });
    return true;
  } catch (error) {
    const message = browserErrorMessage(error);
    emitNativeBrowserEvent(rec, { type: "error", message });
    return false;
  }
});

ipcMain.handle("cesium:window-minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.handle("cesium:window-toggle-maximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  if (win.isMaximized()) {
    win.unmaximize();
    return false;
  }
  win.maximize();
  return true;
});

ipcMain.handle("cesium:window-close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.handle("cesium:window-reload", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.webContents.isDestroyed()) {
    return false;
  }
  win.webContents.reload();
  return true;
});

ipcMain.handle("cesium:window-is-maximized", (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

function cleanupBackend() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  clearMainRendererRecoveryTimer();
  mainRendererRecovering = false;
  mainRendererCrashReloading = false;
  for (const rec of [...nativeBrowserSessions.values()]) {
    destroyNativeBrowserSession(rec.id);
  }
  try {
    backend?.stop();
  } finally {
    backend = null;
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createMainWindow();
  }
});

app.on("before-quit", () => {
  cleanupBackend();
});

app.on("will-quit", () => {
  cleanupBackend();
});

process.on("exit", () => {
  cleanupBackend();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanupBackend();
    process.exit(0);
  });
}
