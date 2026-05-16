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

  mainWindow = new BrowserWindow({
    show: options.show ?? true,
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: "#191919",
    webPreferences: {
      preload: resolve(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  Menu.setApplicationMenu(null);

  const rendererUrl =
    process.env.OPENCURSOR_DESKTOP_RENDERER_URL ??
    (app.isPackaged ? null : "http://127.0.0.1:5173");
  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error("[cesium-desktop] preload failed", preloadPath, error);
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isExpectedRendererNavigation(url)) {
      return;
    }
    console.warn("[cesium-desktop] blocked top-level navigation", url);
    event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.warn("[cesium-desktop] blocked renderer popup", url);
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url).catch(() => undefined);
    }
    return { action: "deny" };
  });
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

  const rendererIndex = resolve(process.resourcesPath, "desktop-renderer/index.html");
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
