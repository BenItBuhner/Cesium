import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  Tray,
} from "electron";
import { statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";

/**
 * Desktop analog of the Android app's native surface: OS notifications for
 * agent runs, a tray icon with live agent status (the foreground-service
 * analog), dock badge / attention signals, `cesium://` deep links, and
 * file "share" intake (macOS open-file / Open With / argv paths).
 *
 * Alert gating (completion / needs-input preferences, focus awareness) lives
 * in the renderer (`src/lib/desktop-agent-notifications.ts`), mirroring how
 * the mobile LiveUpdateController owns policy while the platform layer just
 * posts. This module only renders what the renderer decided.
 */

const DEEP_LINK_SCHEME = "cesium";
const MAX_SHARE_FILES = 10;
const MAX_SHARE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_PENDING_NATIVE_EVENTS = 50;
const TRAY_MENU_MAX_RUNS = 6;

const MIME_BY_EXTENSION = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".log": "text/plain",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".jsx": "text/plain",
  ".py": "text/x-python",
  ".yml": "application/yaml",
  ".yaml": "application/yaml",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

let hooks = {
  getMainWindow: () => null,
  focusMainWindow: () => undefined,
};
let tray = null;
let trayFailed = false;
let appIconPath = null;
/** Notifications kept alive until closed so click handlers stay wired. */
const liveNotifications = new Map();
/** Run keys that already triggered a needs-input attention signal. */
let attentionRunKeys = new Set();
let lastRunsSignature = "";
let lastSyncedRuns = [];

/** Renderer intake sink; events buffer here until the renderer is ready. */
let intakeSink = null;
const pendingNativeEvents = [];

function mainWindow() {
  const win = hooks.getMainWindow();
  return win && !win.isDestroyed() ? win : null;
}

function focusMainWindow() {
  hooks.focusMainWindow();
}

function sinkIsLive() {
  return Boolean(intakeSink && !intakeSink.isDestroyed());
}

export function emitDesktopNativeEvent(event) {
  if (sinkIsLive()) {
    try {
      intakeSink.send("cesium:native-event", event);
      return;
    } catch {
      intakeSink = null;
    }
  }
  pendingNativeEvents.push(event);
  if (pendingNativeEvents.length > MAX_PENDING_NATIVE_EVENTS) {
    pendingNativeEvents.splice(0, pendingNativeEvents.length - MAX_PENDING_NATIVE_EVENTS);
  }
}

function trayIcon() {
  if (!appIconPath) {
    return null;
  }
  try {
    const image = nativeImage.createFromPath(appIconPath);
    if (image.isEmpty()) {
      return null;
    }
    const size = process.platform === "darwin" ? 18 : 16;
    return image.resize({ width: size, height: size });
  } catch {
    return null;
  }
}

function runMenuLabel(run) {
  const title = run.title || "Agent";
  const detail = run.needsInput
    ? "needs input"
    : run.progressLabel || run.detail || "running";
  return `${title} - ${detail}`.slice(0, 80);
}

function rebuildTrayMenu(runs) {
  if (!tray) {
    return;
  }
  const template = [
    {
      label: "Open Cesium",
      click: () => focusMainWindow(),
    },
    { type: "separator" },
  ];
  const active = runs.filter((run) => run.active);
  if (active.length === 0) {
    template.push({ label: "No agents running", enabled: false });
  } else {
    for (const run of active.slice(0, TRAY_MENU_MAX_RUNS)) {
      template.push({
        label: runMenuLabel(run),
        click: () => {
          focusMainWindow();
          emitDesktopNativeEvent({
            kind: "notificationAction",
            actionId: "open",
            conversationId: run.conversationId ?? null,
            workspaceId: run.workspaceId ?? null,
          });
        },
      });
    }
    if (active.length > TRAY_MENU_MAX_RUNS) {
      template.push({
        label: `+${active.length - TRAY_MENU_MAX_RUNS} more agents`,
        enabled: false,
      });
    }
  }
  template.push({ type: "separator" }, {
    label: "Quit Cesium",
    click: () => app.quit(),
  });
  try {
    tray.setContextMenu(Menu.buildFromTemplate(template));
    const activeCount = active.length;
    const needsInput = active.filter((run) => run.needsInput).length;
    tray.setToolTip(
      activeCount === 0
        ? "Cesium"
        : needsInput > 0
          ? `Cesium - ${activeCount} agent${activeCount === 1 ? "" : "s"} running, ${needsInput} need${needsInput === 1 ? "s" : ""} input`
          : `Cesium - ${activeCount} agent${activeCount === 1 ? "" : "s"} running`
    );
  } catch (error) {
    console.warn("[cesium-desktop] failed to update tray", error);
  }
}

function ensureTray() {
  if (tray || trayFailed) {
    return;
  }
  const icon = trayIcon();
  if (!icon) {
    trayFailed = true;
    console.warn("[cesium-desktop] tray icon unavailable; skipping tray");
    return;
  }
  try {
    tray = new Tray(icon);
    tray.on("click", () => focusMainWindow());
    rebuildTrayMenu([]);
  } catch (error) {
    trayFailed = true;
    tray = null;
    console.warn("[cesium-desktop] failed to create tray", error);
  }
}

function applyBadge(runs) {
  const needsInput = runs.filter((run) => run.active && run.needsInput).length;
  try {
    if (process.platform === "darwin") {
      app.dock?.setBadge(needsInput > 0 ? String(needsInput) : "");
    } else if (process.platform === "linux") {
      // Requires a launcher with badge support (Unity/KDE); harmless elsewhere.
      app.setBadgeCount(needsInput);
    }
  } catch {
    /* ignore */
  }
}

function applyAttentionSignals(runs) {
  const nextAttention = new Set(
    runs.filter((run) => run.active && run.needsInput).map((run) => run.runKey)
  );
  const newlyBlocked = [...nextAttention].some((key) => !attentionRunKeys.has(key));
  attentionRunKeys = nextAttention;
  if (!newlyBlocked) {
    return;
  }
  const win = mainWindow();
  const focused = Boolean(win?.isFocused());
  if (focused) {
    return;
  }
  try {
    if (process.platform === "darwin") {
      app.dock?.bounce("critical");
    } else if (win) {
      win.flashFrame(true);
    }
  } catch {
    /* ignore */
  }
}

function normalizeRun(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  const runKey = typeof input.runKey === "string" ? input.runKey : null;
  if (!runKey) {
    return null;
  }
  return {
    runKey,
    conversationId:
      typeof input.conversationId === "string" ? input.conversationId : null,
    workspaceId: typeof input.workspaceId === "string" ? input.workspaceId : null,
    title: typeof input.title === "string" ? input.title : "Agent",
    detail: typeof input.detail === "string" ? input.detail : "",
    progressLabel:
      typeof input.progressLabel === "string" ? input.progressLabel : null,
    needsInput: Boolean(input.needsInput),
    active: input.active !== false,
  };
}

function syncAgentRuns(input) {
  const runs = Array.isArray(input?.runs)
    ? input.runs.map(normalizeRun).filter(Boolean)
    : [];
  const signature = JSON.stringify(runs);
  if (signature === lastRunsSignature) {
    return true;
  }
  lastRunsSignature = signature;
  lastSyncedRuns = runs;
  ensureTray();
  rebuildTrayMenu(runs);
  applyBadge(runs);
  applyAttentionSignals(runs);
  return true;
}

function postNotification(payload) {
  if (!Notification.isSupported()) {
    return false;
  }
  const title = typeof payload?.title === "string" ? payload.title : "Cesium";
  const body = typeof payload?.body === "string" ? payload.body : "";
  const runKey = typeof payload?.runKey === "string" ? payload.runKey : `n-${Date.now()}`;
  const conversationId =
    typeof payload?.conversationId === "string" ? payload.conversationId : null;
  const workspaceId =
    typeof payload?.workspaceId === "string" ? payload.workspaceId : null;
  try {
    // Replace an earlier notification for the same run (e.g. needs-input
    // superseded by the completion notice) instead of stacking them.
    liveNotifications.get(runKey)?.close();
    const notification = new Notification({
      title,
      body,
      silent: Boolean(payload?.silent),
      icon: appIconPath ?? undefined,
      urgency: payload?.kind === "intervention" ? "critical" : "normal",
    });
    notification.on("click", () => {
      focusMainWindow();
      emitDesktopNativeEvent({
        kind: "notificationAction",
        actionId: "open",
        conversationId,
        workspaceId,
      });
      liveNotifications.delete(runKey);
    });
    notification.on("close", () => {
      liveNotifications.delete(runKey);
    });
    liveNotifications.set(runKey, notification);
    notification.show();
    return true;
  } catch (error) {
    console.warn("[cesium-desktop] failed to post notification", error);
    return false;
  }
}

function guessMimeType(filePath) {
  return MIME_BY_EXTENSION[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

async function readSharedFile(filePath) {
  const stats = await stat(filePath);
  if (!stats.isFile() || stats.size > MAX_SHARE_FILE_BYTES) {
    return null;
  }
  const contents = await readFile(filePath);
  return {
    name: basename(filePath),
    mimeType: guessMimeType(filePath),
    base64: contents.toString("base64"),
    byteLength: contents.byteLength,
  };
}

export async function shareFilesWithWorkbench(filePaths) {
  const paths = filePaths.filter((p) => typeof p === "string" && p.length > 0);
  if (paths.length === 0) {
    return;
  }
  const items = [];
  let skippedCount = 0;
  for (const filePath of paths.slice(0, MAX_SHARE_FILES)) {
    try {
      const item = await readSharedFile(filePath);
      if (item) {
        items.push(item);
      } else {
        skippedCount += 1;
      }
    } catch (error) {
      skippedCount += 1;
      console.warn("[cesium-desktop] failed to read shared file", filePath, error);
    }
  }
  skippedCount += Math.max(0, paths.length - MAX_SHARE_FILES);
  if (items.length === 0 && skippedCount === 0) {
    return;
  }
  focusMainWindow();
  emitDesktopNativeEvent({
    kind: "shareIntake",
    payload: {
      text: null,
      subject: null,
      items,
      skippedCount,
    },
  });
}

export function handleDeepLinkUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}:`)) {
    return false;
  }
  focusMainWindow();
  emitDesktopNativeEvent({ kind: "deepLink", url: rawUrl });
  return true;
}

function looksLikeDeepLink(arg) {
  return typeof arg === "string" && new RegExp(`^${DEEP_LINK_SCHEME}://`, "i").test(arg);
}

async function existingFilePath(arg, workingDirectory) {
  if (typeof arg !== "string" || arg.length === 0 || arg.startsWith("-")) {
    return null;
  }
  if (looksLikeDeepLink(arg) || /^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) {
    return null;
  }
  const candidate = isAbsolute(arg)
    ? arg
    : workingDirectory
      ? resolve(workingDirectory, arg)
      : null;
  if (!candidate) {
    return null;
  }
  try {
    const stats = await stat(candidate);
    return stats.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Synchronous argv scan used before startup: does this launch carry a deep
 * link or an openable file? When another instance already holds the
 * single-instance lock, such launches hand their payload to the lock holder
 * (via Electron's second-instance event) and must quit instead of booting a
 * second full app.
 */
export function argvContainsIntakePayload(argv, workingDirectory) {
  const args = Array.isArray(argv) ? argv.slice(1) : [];
  for (const arg of args) {
    if (looksLikeDeepLink(arg)) {
      return true;
    }
    if (typeof arg !== "string" || arg.length === 0 || arg.startsWith("-")) {
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) {
      continue;
    }
    const candidate = isAbsolute(arg)
      ? arg
      : workingDirectory
        ? resolve(workingDirectory, arg)
        : null;
    if (!candidate) {
      continue;
    }
    try {
      if (statSync(candidate).isFile()) {
        return true;
      }
    } catch {
      /* not a file */
    }
  }
  return false;
}

/**
 * Deep links and "Open with Cesium" file paths arrive as plain argv entries
 * on Windows/Linux (both first launch and second-instance). Electron's own
 * flags and the app path are filtered by only accepting cesium:// URLs and
 * paths that resolve to real files.
 */
export async function handleStartupArgv(argv, workingDirectory) {
  const args = Array.isArray(argv) ? argv.slice(1) : [];
  const files = [];
  for (const arg of args) {
    if (looksLikeDeepLink(arg)) {
      handleDeepLinkUrl(arg);
      continue;
    }
    const filePath = await existingFilePath(arg, workingDirectory);
    if (filePath) {
      files.push(filePath);
    }
  }
  if (files.length > 0) {
    await shareFilesWithWorkbench(files);
  }
}

/**
 * Must run before `app.whenReady()` so macOS `open-url` / `open-file`
 * events from a cold launch are not lost.
 */
export function registerDesktopDeepLinkAndFileHandlers() {
  try {
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
    }
  } catch {
    /* ignore */
  }
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLinkUrl(url);
  });
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    void shareFilesWithWorkbench([filePath]);
  });
}

/**
 * macOS requires a real application menu for the standard clipboard and
 * window shortcuts (Cmd+C/V/W/Q…) to work at all. Windows/Linux keep the
 * frameless no-menu chrome.
 */
export function applyPlatformApplicationMenu() {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
        { type: "separator" },
        { role: "close" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export function installDesktopNativeIntegrations(options) {
  hooks = {
    getMainWindow: options.getMainWindow ?? (() => null),
    focusMainWindow: options.focusMainWindow ?? (() => undefined),
  };
  appIconPath = options.appIconPath ?? null;

  ensureTray();

  ipcMain.handle("cesium:notifications-supported", () => Notification.isSupported());
  ipcMain.handle("cesium:notify", (_event, payload) => postNotification(payload));
  ipcMain.handle("cesium:sync-agent-runs", (_event, input) => syncAgentRuns(input));
  ipcMain.handle("cesium:intake-ready", (event) => {
    intakeSink = event.sender;
    event.sender.once("destroyed", () => {
      if (intakeSink === event.sender) {
        intakeSink = null;
      }
    });
    const drained = pendingNativeEvents.splice(0, pendingNativeEvents.length);
    return drained;
  });

  // Stop flashing the Windows/Linux taskbar once the user comes back.
  app.on("browser-window-focus", (_event, win) => {
    try {
      win.flashFrame(false);
    } catch {
      /* ignore */
    }
  });
}

export function destroyDesktopNativeIntegrations() {
  for (const notification of liveNotifications.values()) {
    try {
      notification.close();
    } catch {
      /* ignore */
    }
  }
  liveNotifications.clear();
  try {
    tray?.destroy();
  } catch {
    /* ignore */
  }
  tray = null;
}

/** Test/introspection hook. */
export function getDesktopNativeState() {
  return {
    trayCreated: Boolean(tray),
    lastSyncedRuns,
    pendingNativeEvents: [...pendingNativeEvents],
  };
}
