export type KeyValueStorage = {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
};

export type LocationLike = {
  protocol: string;
  hostname: string;
  host: string;
  origin?: string;
  search?: string;
};

export type WebSocketLike = {
  readonly readyState: number;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    event: "open" | "close" | "error" | "message",
    listener: (event: unknown) => void
  ): void;
};

export type ApiClientRuntime = {
  fetch: typeof fetch;
  createWebSocket(url: string): WebSocketLike;
  storage: KeyValueStorage;
  location(): LocationLike | null;
  env(name: string): string | undefined;
  now(): number;
};

export type ApiClientConfig = {
  serverBaseUrl: string;
  runtime: ApiClientRuntime;
};

export function toWebSocketUrl(url: string, location: LocationLike | null): string {
  if (url.startsWith("https://")) {
    return `wss://${url.slice("https://".length)}`;
  }
  if (url.startsWith("http://")) {
    return `ws://${url.slice("http://".length)}`;
  }
  if (url === "" || url.startsWith("/")) {
    if (!location) {
      return url;
    }
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const suffix = url.startsWith("/") ? url : "";
    return `${scheme}//${location.host}${suffix}`;
  }
  return url;
}

export function resolveClientServerBaseUrl(
  raw: string,
  location: LocationLike | null
): string {
  if (!location) {
    return raw;
  }

  try {
    const configured = new URL(raw);
    const currentHost = location.hostname;
    const isLocalHost = currentHost === "127.0.0.1" || currentHost === "localhost";

    if (location.protocol === "https:" && configured.protocol === "http:") {
      return "";
    }

    if (
      currentHost &&
      isLocalHost &&
      (configured.hostname !== currentHost || configured.protocol !== location.protocol)
    ) {
      configured.protocol = location.protocol;
      configured.hostname = currentHost;
      configured.port = configured.port || "9100";
      return configured.toString().replace(/\/+$/, "");
    }

    const configuredIsLoopback =
      configured.hostname === "localhost" || configured.hostname === "127.0.0.1";

    if (currentHost && !isLocalHost && configuredIsLoopback && location.protocol === "http:") {
      const next = new URL(raw);
      next.protocol = "http:";
      next.hostname = currentHost;
      next.port = "9100";
      return next.toString().replace(/\/+$/, "");
    }
  } catch {
    return raw;
  }
  return raw;
}
