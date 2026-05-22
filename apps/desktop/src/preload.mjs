import { contextBridge, ipcRenderer } from "electron";

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
