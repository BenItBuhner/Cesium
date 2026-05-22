import { bootstrapStoredServerConnection } from "@/lib/server-connections";

export async function initializeMobileRuntime() {
  const backendInfo = await window.cesiumMobile?.getBackendInfo?.();
  if (!backendInfo?.baseUrl) {
    return;
  }

  bootstrapStoredServerConnection(
    {
      id: "mobile-server",
      label: backendInfo.label?.trim() || "Mobile server",
      baseUrl: backendInfo.baseUrl,
    },
    {
      activate: "if-missing",
      defaultServer: "if-missing",
      configuredDefaultBaseUrl: backendInfo.baseUrl,
    }
  );
}
