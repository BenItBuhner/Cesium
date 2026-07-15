/**
 * Platform adapter seam for @cesium/client.
 *
 * All persistence, page-location and cross-tab-event access in this package
 * flows through the active {@link ClientPlatform}. The default implementation
 * reproduces the historical web behavior exactly (guarded `window.localStorage`,
 * `window.location`, `CustomEvent` on `window`), so web and Electron builds are
 * unchanged. React Native swaps in its own platform (MMKV/AsyncStorage-backed
 * store, runtime-config base URL, in-process event emitter) at startup via
 * {@link setClientPlatform}.
 */

export type KeyValueStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type ClientLocation = {
  protocol: string;
  hostname: string;
  host: string;
  origin: string;
  href: string;
  search: string;
};

export type ClientPlatform = {
  keyValueStore: KeyValueStore;
  /** Current page location, or `null` outside a web page (SSR, native). */
  getLocation(): ClientLocation | null;
  /**
   * Runtime-injected API base URL (mobile shell globals today; RN runtime
   * config later). `null` falls through to env/default resolution.
   */
  getRuntimeConfiguredServerBaseUrl(): string | null;
  /** Broadcast an app-level event (cross-component sync; web: window CustomEvent). */
  emitEvent(name: string): void;
  /** Subscribe to {@link emitEvent} broadcasts. Returns an unsubscribe callback. */
  addEventListener(name: string, listener: () => void): () => void;
  prefersDarkColorScheme(): boolean;
};

const memoryStore = new Map<string, string>();

const memoryKeyValueStore: KeyValueStore = {
  getItem: (key) => (memoryStore.has(key) ? memoryStore.get(key)! : null),
  setItem: (key, value) => {
    memoryStore.set(key, value);
  },
  removeItem: (key) => {
    memoryStore.delete(key);
  },
};

function webLocalStorage(): KeyValueStore {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return memoryKeyValueStore;
  }
  return window.localStorage;
}

type CesiumMobileRuntimeGlobals = {
  __CESIUM_MOBILE_SERVER__?: { baseUrl?: string };
  cesiumMobile?: { server?: { baseUrl?: string } };
};

const webPlatform: ClientPlatform = {
  get keyValueStore() {
    return webLocalStorage();
  },
  getLocation() {
    if (typeof window === "undefined" || typeof window.location === "undefined") {
      return null;
    }
    const { protocol, hostname, host, origin, href, search } = window.location;
    return { protocol, hostname, host, origin, href, search };
  },
  getRuntimeConfiguredServerBaseUrl() {
    if (typeof window === "undefined") {
      return null;
    }
    const globals = window as Window & CesiumMobileRuntimeGlobals;
    const fromRuntime =
      globals.__CESIUM_MOBILE_SERVER__?.baseUrl?.trim() ||
      globals.cesiumMobile?.server?.baseUrl?.trim();
    return fromRuntime || null;
  },
  emitEvent(name) {
    if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") {
      return;
    }
    window.dispatchEvent(new CustomEvent(name));
  },
  addEventListener(name, listener) {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
      return () => undefined;
    }
    const handler = () => listener();
    window.addEventListener(name, handler);
    return () => window.removeEventListener(name, handler);
  },
  prefersDarkColorScheme() {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  },
};

let activePlatform: ClientPlatform = webPlatform;

export function setClientPlatform(platform: ClientPlatform): void {
  activePlatform = platform;
}

export function getClientPlatform(): ClientPlatform {
  return activePlatform;
}

export function createMemoryKeyValueStore(): KeyValueStore {
  const store = new Map<string, string>();
  return {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

/** Active platform's key-value store (web default: `window.localStorage`). */
export function clientKeyValueStore(): KeyValueStore {
  return activePlatform.keyValueStore;
}

/** Active platform's location (web default: `window.location`; native: `null`). */
export function clientLocation(): ClientLocation | null {
  return activePlatform.getLocation();
}
