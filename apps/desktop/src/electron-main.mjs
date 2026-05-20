import { app, BrowserWindow, Menu, ipcMain, shell, dialog } from "electron";
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
