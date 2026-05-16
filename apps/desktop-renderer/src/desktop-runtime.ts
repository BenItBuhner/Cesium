type CesiumDesktopBridge = {
  isElectron?: boolean;
  getBackendInfo?: () => Promise<{ baseUrl: string | null; port: number | null }>;
};

declare global {
  interface Window {
    cesiumDesktop?: CesiumDesktopBridge;
  }
}

export async function initializeDesktopRuntime() {
  const backendInfo = await window.cesiumDesktop?.getBackendInfo?.();
  if (!backendInfo?.baseUrl) {
    return;
  }

  const now = Date.now();
  const baseUrl = backendInfo.baseUrl.replace(/\/+$/, "");
  const server = {
    id: "desktop-sidecar",
    label: "This device",
    baseUrl,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
  };

  window.localStorage.setItem(
    "opencursor.server-connections",
    JSON.stringify({
      version: 1,
      activeServerId: server.id,
      servers: [server],
    })
  );
  window.dispatchEvent(new CustomEvent("opencursor:server-connections-changed"));
}
