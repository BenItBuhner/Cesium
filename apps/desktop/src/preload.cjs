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

    html[data-cesium-desktop="true"] #cesium-electron-drag-main {
      -webkit-app-region: drag;
      position: fixed;
      top: 0;
      left: 0;
      width: 0;
      height: 0;
      z-index: 2147483500;
      pointer-events: none;
    }

    html[data-cesium-desktop="true"] #cesium-electron-drag-main[data-active="true"] {
      pointer-events: auto;
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

  const dragMain = document.createElement("div");
  dragMain.id = "cesium-electron-drag-main";
  dragMain.setAttribute("aria-hidden", "true");

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
  document.body.append(dragTop, dragMain, controls);
  installDynamicDragZones(dragMain);
}

function installDynamicDragZones(dragMain) {
  const interactiveSelector = [
    "button",
    "a",
    "input",
    "textarea",
    "select",
    "summary",
    "[contenteditable]",
    "[role='button']",
    "[role='tab']",
    "[role='menuitem']",
    "[role^='menuitem']",
    "[role='switch']",
    "[role='searchbox']",
    "[role='combobox']",
    "[data-editor-tab-actions]",
    "[data-strip-index]",
    "[data-tab-group-id]",
    "[data-workbench-pane-toggle]",
    "#cesium-electron-window-controls",
  ].join(",");

  const dragOverlayIds = new Set(["cesium-electron-drag-main", "cesium-electron-drag-top"]);

  let raf = 0;
  let lastTarget = null;

  function isInteractive(target) {
    return target instanceof Element && Boolean(target.closest(interactiveSelector));
  }

  /** Top-down hit list with injected drag overlays stripped (see updateForPointer). */
  function elementsUnderPointer(x, y) {
    const out = [];
    for (const node of document.elementsFromPoint(x, y)) {
      if (!(node instanceof Element)) continue;
      if (dragOverlayIds.has(node.id)) continue;
      out.push(node);
    }
    return out;
  }

  function setRect(rect) {
    dragMain.style.left = `${Math.max(0, Math.round(rect.left))}px`;
    dragMain.style.top = `${Math.max(0, Math.round(rect.top))}px`;
    dragMain.style.width = `${Math.max(0, Math.round(rect.width))}px`;
    dragMain.style.height = `${Math.max(0, Math.round(rect.height))}px`;
    dragMain.dataset.active = rect.width > 0 && rect.height > 0 ? "true" : "false";
  }

  function clearRect() {
    dragMain.dataset.active = "false";
    dragMain.style.width = "0px";
    dragMain.style.height = "0px";
  }

  function updateForPointer(event) {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = 0;
      const under = elementsUnderPointer(event.clientX, event.clientY);
      for (const el of under) {
        if (isInteractive(el)) {
          lastTarget = el;
          clearRect();
          return;
        }
      }

      const target = under[0] ?? null;
      lastTarget = target;

      if (!target) {
        clearRect();
        return;
      }

      const header = target.closest?.(
        ".agent-side-pane, [data-ide-browser-surface], [data-cesium-workbench-root], [data-electron-drag-host]"
      );
      const host = header instanceof Element ? header : document.body;
      const rect = host.getBoundingClientRect();
      const windowControlsLeft = window.innerWidth - 110;
      const left = Math.max(rect.left, 0);
      const right = Math.min(rect.right, windowControlsLeft);
      const top = Math.max(rect.top, 0);
      const height = Math.min(32, Math.max(0, rect.bottom - top));

      if (event.clientY > top + height || right <= left) {
        clearRect();
        return;
      }

      setRect({ left, top, width: right - left, height });
    });
  }

  window.addEventListener("pointermove", updateForPointer, true);
  window.addEventListener("pointerdown", (event) => {
    for (const el of elementsUnderPointer(event.clientX, event.clientY)) {
      if (isInteractive(el)) {
        lastTarget = el;
        clearRect();
        return;
      }
    }
    updateForPointer(event);
  }, true);
  window.addEventListener("pointerleave", clearRect, true);
  window.addEventListener("blur", clearRect);
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
});
