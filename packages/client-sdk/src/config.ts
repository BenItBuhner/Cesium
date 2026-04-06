export type RuntimeConfigSource = {
  serverUrl?: string | null;
};

export type RuntimeClientConfig = RuntimeConfigSource & {
  currentHostname?: string | null;
};

declare global {
  interface Window {
    __OPENCURSOR_RUNTIME_CONFIG__?: RuntimeConfigSource;
  }
}

const DEFAULT_SERVER_URL = "http://localhost:9100";

function trimUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  const trimmed = url.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

export function getDefaultServerUrl(): string {
  return DEFAULT_SERVER_URL;
}

export function resolveRuntimeServerUrl(explicitUrl?: string | null): string {
  const explicit = trimUrl(explicitUrl);
  if (explicit) {
    return explicit;
  }

  if (typeof window !== "undefined") {
    const runtime = trimUrl(window.__OPENCURSOR_RUNTIME_CONFIG__?.serverUrl);
    if (runtime) {
      return runtime;
    }
  }

  const envCandidates = [
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_SERVER_URL : undefined,
    typeof process !== "undefined" ? process.env.EXPO_PUBLIC_SERVER_URL : undefined,
    typeof process !== "undefined" ? process.env.OPENCURSOR_SERVER_URL : undefined,
  ];

  for (const candidate of envCandidates) {
    const normalized = trimUrl(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return DEFAULT_SERVER_URL;
}

export function resolveClientBaseUrl(options?: {
  serverUrl?: string | null;
  currentHostname?: string | null;
}): string {
  const baseUrl = resolveRuntimeServerUrl(options?.serverUrl);
  const currentHostname =
    options?.currentHostname ??
    (typeof window !== "undefined" ? window.location.hostname : null);

  if (!currentHostname) {
    return baseUrl;
  }

  try {
    const configured = new URL(baseUrl);
    if (
      currentHostname !== configured.hostname &&
      (currentHostname === "127.0.0.1" || currentHostname === "localhost")
    ) {
      configured.hostname = currentHostname;
      configured.port = configured.port || "9100";
      return configured.toString().replace(/\/+$/, "");
    }
  } catch {
    return baseUrl;
  }

  return baseUrl;
}

export function resolveBaseUrl(options?: RuntimeClientConfig): string {
  return resolveClientBaseUrl(options);
}

export function toWebSocketUrl(url: string): string {
  if (url.startsWith("https://")) {
    return `wss://${url.slice("https://".length)}`;
  }
  if (url.startsWith("http://")) {
    return `ws://${url.slice("http://".length)}`;
  }
  return url;
}
