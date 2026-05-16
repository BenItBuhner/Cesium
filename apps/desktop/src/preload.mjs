import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("cesiumDesktop", {
  getBackendInfo: () => ipcRenderer.invoke("cesium:get-backend-info"),
  openExternal: (url) => ipcRenderer.invoke("cesium:open-external", url),
  minimizeWindow: () => ipcRenderer.invoke("cesium:window-minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("cesium:window-toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("cesium:window-close"),
  isMaximized: () => ipcRenderer.invoke("cesium:window-is-maximized"),
});
