import type { ApiClientRuntime, KeyValueStorage, LocationLike, WebSocketLike } from "./runtime";

const webStorage: KeyValueStorage = {
  getItem(key) {
    return globalThis.localStorage?.getItem(key) ?? null;
  },
  setItem(key, value) {
    globalThis.localStorage?.setItem(key, value);
  },
  removeItem(key) {
    globalThis.localStorage?.removeItem(key);
  },
};

function getLocation(): LocationLike | null {
  if (typeof globalThis.location === "undefined") {
    return null;
  }
  return {
    protocol: globalThis.location.protocol,
    hostname: globalThis.location.hostname,
    host: globalThis.location.host,
    origin: globalThis.location.origin,
    search: globalThis.location.search,
  };
}

export function createWebRuntime(): ApiClientRuntime {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    createWebSocket(url: string): WebSocketLike {
      return new WebSocket(url);
    },
    storage: webStorage,
    location: getLocation,
    env(name: string) {
      return (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
        .process?.env?.[name];
    },
    now() {
      return globalThis.performance?.now?.() ?? Date.now();
    },
  };
}
