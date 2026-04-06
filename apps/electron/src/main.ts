import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_SERVER_URL = process.env.OPENCURSOR_SERVER_URL?.trim() || "http://localhost:9100";
const DEV_URL = process.env.OPENCURSOR_ELECTRON_DEV_URL?.trim() || "";

function getRendererEntryUrl(): string {
  if (DEV_URL) {
    return DEV_URL;
  }

  const indexPath = path.join(__dirname, "renderer", "index.html");
  return pathToFileURL(indexPath).toString();
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#191919",
    title: "OpenCursor Desktop",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      additionalArguments: [`--opencursor-server-url=${DEFAULT_SERVER_URL}`],
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  void window.loadURL(getRendererEntryUrl());
  return window;
}

app.whenReady().then(() => {
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
