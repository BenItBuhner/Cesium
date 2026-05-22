import { app, BrowserWindow, Menu, WebContentsView, ipcMain, shell, dialog } from "electron";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startCesiumBackend } from "./main.mjs";

const here = dirname(fileURLToPath(import.meta.url));
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

function browserErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizedBounds(bounds) {
  if (!bounds || typeof bounds !== "object") return { x: 0, y: 0, width: 0, height: 0 };
  const n = (value) => Math.max(0, Math.round(Number(value) || 0));
  return {
    x: n(bounds.x),
    y: n(bounds.y),
    width: n(bounds.width),
    height: n(bounds.height),
  };
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
    wc.debugger.sendCommand("Network.enable").catch(() => undefined);
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
  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: true,
    },
  });
  const id = `nb-${randomUUID()}`;
  const rec = {
    id,
    tabId,
    owner,
    view,
    devtoolsView: null,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    devtoolsBounds: { x: 0, y: 0, width: 0, height: 0 },
  };
  nativeBrowserSessions.set(id, rec);
  owner.contentView.addChildView(view);
  view.setBounds(rec.bounds);
  view.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
    void view.webContents.loadURL(nextUrl).catch((error) => {
      emitNativeBrowserEvent(rec, { type: "error", message: browserErrorMessage(error) });
    });
    return { action: "deny" };
  });
  view.webContents.on("did-start-loading", () => emitNativeNavigationState(rec, { isLoading: true }));
  view.webContents.on("did-stop-loading", () => emitNativeNavigationState(rec, { isLoading: false }));
  view.webContents.on("did-navigate", () => emitNativeNavigationState(rec));
  view.webContents.on("did-navigate-in-page", () => emitNativeNavigationState(rec));
  view.webContents.on("page-title-updated", (_event, title) => emitNativeNavigationState(rec, { title }));
  view.webContents.on("page-favicon-updated", (_event, favicons) => {
    emitNativeNavigationState(rec, { faviconUrl: Array.isArray(favicons) ? favicons[0] : null });
  });
  view.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    emitNativeBrowserEvent(rec, {
      type: "error",
      message: `${errorDescription || "Navigation failed"} (${errorCode}) for ${validatedURL || url}`,
    });
  });
  view.webContents.on("render-process-gone", (_event, details) => {
    emitNativeBrowserEvent(rec, {
      type: "error",
      message: `Browser renderer exited: ${details.reason}`,
    });
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
    if (rec.devtoolsView) {
      rec.owner.contentView.removeChildView(rec.devtoolsView);
      rec.devtoolsView.webContents.close();
    }
  } catch {
    /* ignore */
  }
  try {
    rec.owner.contentView.removeChildView(rec.view);
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

function createRendererBrowserWindow(options = {}) {
  return new BrowserWindow({
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

async function createMainWindow(options = {}) {
  console.log("[cesium-desktop] starting backend");
  const userDataPath = app.getPath("userData");
  backend = await startCesiumBackend({
    cwd: userDataPath,
    dataDir: resolve(userDataPath, "server-data"),
  });
  console.log("[cesium-desktop] backend ready", backend.baseUrl);

  mainWindow = createRendererBrowserWindow({ show: options.show ?? true });
  mainWindow.on("closed", () => {
    destroyNativeBrowserSessionsForWindow(mainWindow);
    mainWindow = null;
  });
  Menu.setApplicationMenu(null);

  const rendererUrl =
    process.env.OPENCURSOR_DESKTOP_RENDERER_URL ??
    (app.isPackaged ? null : "http://127.0.0.1:5173");
  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error("[cesium-desktop] preload failed", preloadPath, error);
  });
  attachRendererNavigationGuards(mainWindow.webContents);
  if (rendererUrl) {
    console.log("[cesium-desktop] loading renderer", rendererUrl);
    const url =
      process.env.OPENCURSOR_DESKTOP_RENDERER_URL != null
        ? buildConfiguredRendererUrl(rendererUrl, backend.baseUrl)
        : rendererUrl;
    await mainWindow.loadURL(url);
    if (options.closeAfterLoad) {
      mainWindow.close();
    }
    return;
  }

  const rendererIndex = resolvePackagedRendererIndexPath();
  console.log("[cesium-desktop] loading packaged renderer", rendererIndex);
  await mainWindow.loadFile(rendererIndex);
  if (options.closeAfterLoad) {
    mainWindow.close();
  }
}

const gotLock = app.isPackaged ? app.requestSingleInstanceLock() : true;
console.log("[cesium-desktop] single instance lock", gotLock);
if (!gotLock) {
  console.error("[cesium-desktop] another desktop instance already has the lock");
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
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

ipcMain.handle("cesium:get-backend-info", () => ({
  baseUrl: backend?.baseUrl ?? null,
  port: backend?.port ?? null,
}));

ipcMain.handle("cesium:open-external", async (_event, url) => {
  if (typeof url !== "string") return false;
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

ipcMain.handle("cesium:browser-create", async (event, input) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner.isDestroyed()) {
    throw new Error("No owning BrowserWindow for native browser session.");
  }
  const url = typeof input?.url === "string" ? input.url : "";
  if (!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url)) {
    throw new Error("Native browser sessions require an absolute http(s) or file URL.");
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
  rec.bounds = normalizedBounds(bounds);
  rec.view.setBounds(rec.bounds);
  return true;
});

ipcMain.handle("cesium:browser-set-devtools-bounds", async (_event, sessionId, bounds) => {
  const rec = nativeBrowserSessions.get(String(sessionId ?? ""));
  if (!rec?.devtoolsView) return false;
  rec.devtoolsBounds = normalizedBounds(bounds);
  rec.devtoolsView.setBounds(rec.devtoolsBounds);
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
        },
      });
      rec.owner.contentView.addChildView(rec.devtoolsView);
      rec.devtoolsView.setBounds(rec.devtoolsBounds);
      rec.view.webContents.setDevToolsWebContents(rec.devtoolsView.webContents);
    }
    rec.view.webContents.openDevTools({ mode: "detach" });
    return true;
  }
  rec.view.webContents.closeDevTools();
  if (rec.devtoolsView) {
    try {
      rec.owner.contentView.removeChildView(rec.devtoolsView);
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

ipcMain.handle("cesium:browser-cdp-command", async (_event, sessionId, method, params = {}) => {
  const rec = nativeBrowserSessions.get(String(sessionId ?? ""));
  if (!rec) return null;
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
    if (!rec.view.webContents.debugger.isAttached()) {
      rec.view.webContents.debugger.attach("1.3");
    }
    if (input?.type === "mouse") {
      const action = input.action === "down" ? "mousePressed" : input.action === "up" ? "mouseReleased" : "mouseMoved";
      await rec.view.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: input.action === "click" ? "mousePressed" : action,
        x: Math.max(0, Math.floor(Number(input.x) || 0)),
        y: Math.max(0, Math.floor(Number(input.y) || 0)),
        button: input.button ?? "left",
        clickCount: input.action === "click" ? 1 : 0,
      });
      if (input.action === "click") {
        await rec.view.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: Math.max(0, Math.floor(Number(input.x) || 0)),
          y: Math.max(0, Math.floor(Number(input.y) || 0)),
          button: input.button ?? "left",
          clickCount: 1,
        });
      }
      return true;
    }
    if (input?.type === "key") {
      if (input.action === "type") {
        await rec.view.webContents.insertText(String(input.key ?? ""));
      } else {
        await rec.view.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
          type: input.action === "up" ? "keyUp" : "keyDown",
          key: String(input.key ?? ""),
        });
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

ipcMain.handle("cesium:window-is-maximized", (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

function cleanupBackend() {
  if (cleanupStarted) return;
  cleanupStarted = true;
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
