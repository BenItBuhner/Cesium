import { bootstrapStoredServerConnection } from "@/lib/server-connections";

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

  bootstrapStoredServerConnection(
    {
      id: "desktop-sidecar",
      label: "This device",
      baseUrl: backendInfo.baseUrl,
    },
    {
      // Packaged Electron always spawns a fresh loopback sidecar on a new port.
      // Preserve other saved servers, but force API/WebSocket traffic to this device.
      activate: "always",
    }
  );
}
