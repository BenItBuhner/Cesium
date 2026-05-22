const DEFAULT_SERVER_PORT = "9100";

/**
 * Build-time / env default for the Cesium API (matches server `PORT` default in server/.env.example).
 */
export function getConfiguredServerBaseUrl(): string {
  const fromMobileRuntime =
    typeof window !== "undefined"
      ? window.__CESIUM_MOBILE_SERVER__?.baseUrl?.trim() ||
        window.cesiumMobile?.server?.baseUrl?.trim()
      : "";
  if (fromMobileRuntime) {
    return fromMobileRuntime.replace(/\/+$/, "");
  }
  const fromEnv = process.env.NEXT_PUBLIC_SERVER_URL?.trim();
  if (fromEnv) {
    return fromEnv.replace(/\/+$/, "");
  }
  return `http://localhost:${DEFAULT_SERVER_PORT}`;
}

export function getConfiguredServerPort(): string {
  try {
    const port = new URL(getConfiguredServerBaseUrl()).port;
    return port || DEFAULT_SERVER_PORT;
  } catch {
    return DEFAULT_SERVER_PORT;
  }
}

export function isLoopbackServerBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}
