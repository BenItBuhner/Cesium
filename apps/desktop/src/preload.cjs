const { contextBridge, ipcRenderer } = require("electron");

function injectDesktopChrome() {
  if (document.getElementById("cesium-electron-window-controls")) return;

  document.documentElement.dataset.cesiumDesktop = "true";

  const style = document.createElement("style");
  style.id = "cesium-electron-chrome-style";
  style.textContent = `
    html[data-cesium-desktop="true"] #cesium-electron-drag-top {
      -webkit-app-region: drag;
      position: fixed;
      inset: 0 148px auto 0;
      height: 4px;
      z-index: 2147483600;
      pointer-events: auto;
    }

    html[data-cesium-desktop="true"] [data-electron-drag-host] {
      -webkit-app-region: drag;
      cursor: default;
    }

    html[data-cesium-desktop="true"] [data-electron-drag-host] button,
    html[data-cesium-desktop="true"] [data-electron-drag-host] a,
    html[data-cesium-desktop="true"] [data-electron-drag-host] input,
    html[data-cesium-desktop="true"] [data-electron-drag-host] textarea,
    html[data-cesium-desktop="true"] [data-electron-drag-host] select,
    html[data-cesium-desktop="true"] [data-electron-drag-host] summary,
    html[data-cesium-desktop="true"] [data-electron-drag-host] [contenteditable],
    html[data-cesium-desktop="true"] [data-electron-drag-host] [role="button"],
    html[data-cesium-desktop="true"] [data-electron-drag-host] [role="tab"],
    html[data-cesium-desktop="true"] [data-electron-drag-host] [role="menuitem"],
    html[data-cesium-desktop="true"] [data-electron-drag-host] [role="switch"],
    html[data-cesium-desktop="true"] [data-electron-drag-host] [role="searchbox"],
    html[data-cesium-desktop="true"] [data-electron-drag-host] [role="combobox"],
    html[data-cesium-desktop="true"] [data-electron-drag-host] [data-workbench-pane-toggle],
    html[data-cesium-desktop="true"] [data-electron-drag-host] [data-editor-tab-actions],
    html[data-cesium-desktop="true"] [data-electron-drag-host] [data-electron-no-drag],
    html[data-cesium-desktop="true"] [data-electron-no-drag] {
      -webkit-app-region: no-drag;
    }

    html[data-cesium-desktop="true"] #cesium-electron-window-controls {
      -webkit-app-region: no-drag;
      position: fixed;
      top: 6px;
      right: 6px;
      z-index: 2147483601;
      display: flex;
      align-items: center;
      gap: 4px;
      height: 28px;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: var(--text-secondary, #6f6f6f);
      box-shadow: none;
      backdrop-filter: none;
    }

    html[data-cesium-desktop="true"] #cesium-electron-window-controls button {
      -webkit-app-region: no-drag;
      display: flex;
      width: 28px;
      height: 28px;
      align-items: center;
      justify-content: center;
      border: 0;
      padding: 0;
      background: transparent;
      border-radius: var(--radius-tab, 5px);
      color: inherit;
      cursor: default;
      transition: background-color 150ms ease, color 150ms ease;
    }

    html[data-cesium-desktop="true"] #cesium-electron-window-controls button:hover {
      background: var(--bg-card, #393939);
      color: var(--text-primary, #ffffff);
    }

    html[data-cesium-desktop="true"] #cesium-electron-window-controls button[data-window-action="close"]:hover {
      background: #c42b1c;
      color: #ffffff;
    }

    html[data-cesium-desktop="true"] [data-workbench-pane-toggle] {
      right: 112px !important;
      top: 11px !important;
    }

    html[data-cesium-desktop="true"] [data-editor-tab-actions] {
      margin-right: 96px !important;
      padding-left: 4px !important;
      padding-right: 8px !important;
      gap: 2px !important;
    }

    html[data-cesium-desktop="true"] [data-editor-tab-actions] > div:first-child {
      gap: 0 !important;
      margin-right: 2px;
    }

    html[data-cesium-desktop="true"] [data-editor-tab-actions] > div:first-child button:first-child {
      width: 27px !important;
      border-top-right-radius: 0 !important;
      border-bottom-right-radius: 0 !important;
    }

    html[data-cesium-desktop="true"] [data-editor-tab-actions] > div:first-child button:nth-child(2) {
      width: 20px !important;
      margin-left: -1px;
      border-top-left-radius: 0 !important;
      border-bottom-left-radius: 0 !important;
    }

    html[data-cesium-desktop="true"] [data-editor-tab-actions] > div:first-child button:nth-child(2) svg {
      width: 12px;
      height: 12px;
    }

    html[data-cesium-desktop="true"] [data-editor-tab-actions] > button,
    html[data-cesium-desktop="true"] [data-editor-tab-actions] > div:not(:first-child) {
      margin-left: 0;
    }

    html[data-cesium-desktop="true"] [data-editor-tab-actions] > div:last-of-type {
      margin-left: -2px;
      margin-right: 7px;
    }

    html[data-cesium-desktop="true"] [data-editor-tab-actions] > div:last-of-type button {
      width: 26px !important;
    }
  `;

  const dragTop = document.createElement("div");
  dragTop.id = "cesium-electron-drag-top";
  dragTop.setAttribute("aria-hidden", "true");

  const controls = document.createElement("div");
  controls.id = "cesium-electron-window-controls";
  controls.setAttribute("aria-label", "Window controls");

  const icons = {
    minimize:
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 12h14"/></svg>',
    maximize:
      '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
    close:
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  };

  for (const [action, label] of [
    ["minimize", "Minimize"],
    ["maximize", "Maximize"],
    ["close", "Close"],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.windowAction = action;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.innerHTML = icons[action];
    button.addEventListener("click", () => {
      if (action === "minimize") void ipcRenderer.invoke("cesium:window-minimize");
      if (action === "maximize") void ipcRenderer.invoke("cesium:window-toggle-maximize");
      if (action === "close") void ipcRenderer.invoke("cesium:window-close");
    });
    controls.appendChild(button);
  }

  document.head.appendChild(style);
  document.body.append(dragTop, controls);
}

window.addEventListener("DOMContentLoaded", injectDesktopChrome, { once: true });

contextBridge.exposeInMainWorld("cesiumDesktop", {
  isElectron: true,
  getBackendInfo: () => ipcRenderer.invoke("cesium:get-backend-info"),
  openExternal: (url) => ipcRenderer.invoke("cesium:open-external", url),
  openDocsWindow: () => ipcRenderer.invoke("cesium:open-docs-window"),
  minimizeWindow: () => ipcRenderer.invoke("cesium:window-minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("cesium:window-toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("cesium:window-close"),
  isMaximized: () => ipcRenderer.invoke("cesium:window-is-maximized"),
  browser: {
    isAvailable: () => ipcRenderer.invoke("cesium:browser-available"),
    createSession: (input) => ipcRenderer.invoke("cesium:browser-create", input),
    destroySession: (sessionId) => ipcRenderer.invoke("cesium:browser-destroy", sessionId),
    setBounds: (sessionId, bounds) =>
      ipcRenderer.invoke("cesium:browser-set-bounds", sessionId, bounds),
    setDevtoolsBounds: (sessionId, bounds) =>
      ipcRenderer.invoke("cesium:browser-set-devtools-bounds", sessionId, bounds),
    setDevtoolsOpen: (sessionId, open) =>
      ipcRenderer.invoke("cesium:browser-devtools", sessionId, open),
    command: (sessionId, command) =>
      ipcRenderer.invoke("cesium:browser-command", sessionId, command),
    cdpCommand: (sessionId, method, params) =>
      ipcRenderer.invoke("cesium:browser-cdp-command", sessionId, method, params),
    capturePage: (sessionId) => ipcRenderer.invoke("cesium:browser-capture-page", sessionId),
    dispatchInput: (sessionId, input) =>
      ipcRenderer.invoke("cesium:browser-dispatch-input", sessionId, input),
    setEmulation: (sessionId, metrics) =>
      ipcRenderer.invoke("cesium:browser-set-emulation", sessionId, metrics),
    onEvent: (listener) => {
      if (typeof listener !== "function") return () => undefined;
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on("cesium:browser-event", wrapped);
      return () => ipcRenderer.removeListener("cesium:browser-event", wrapped);
    },
  },
});
