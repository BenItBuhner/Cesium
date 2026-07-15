import { Appearance } from "react-native";
import { MMKV } from "react-native-mmkv";
import {
  createMemoryKeyValueStore,
  setClientPlatform,
  type KeyValueStore,
  type ClientPlatform,
} from "@cesium/client";

/**
 * React Native implementation of the @cesium/client platform adapter.
 * Storage is backed by MMKV so auth, server, workspace, session, and theme
 * state survive process restarts. Events use an in-process emitter since RN
 * has no cross-tab concept; the server base URL comes from runtime config.
 */

const listeners = new Map<string, Set<() => void>>();
let runtimeServerBaseUrl: string | null = null;

function createPersistentKeyValueStore(): KeyValueStore {
  try {
    const storage = new MMKV({ id: "cesium.mobile.client" });
    return {
      getItem(key) {
        return storage.getString(key) ?? null;
      },
      setItem(key, value) {
        storage.set(key, value);
      },
      removeItem(key) {
        storage.delete(key);
      },
    };
  } catch {
    // Unit tests and unsupported remote-debug runtimes do not expose JSI.
    return createMemoryKeyValueStore();
  }
}

export function setRuntimeServerBaseUrl(baseUrl: string | null): void {
  runtimeServerBaseUrl = baseUrl?.trim() || null;
}

const reactNativePlatform: ClientPlatform = {
  keyValueStore: createPersistentKeyValueStore(),
  getLocation() {
    return null;
  },
  getRuntimeConfiguredServerBaseUrl() {
    return runtimeServerBaseUrl;
  },
  emitEvent(name) {
    listeners.get(name)?.forEach((listener) => listener());
  },
  addEventListener(name, listener) {
    let bucket = listeners.get(name);
    if (!bucket) {
      bucket = new Set();
      listeners.set(name, bucket);
    }
    bucket.add(listener);
    return () => {
      bucket.delete(listener);
    };
  },
  prefersDarkColorScheme() {
    return Appearance.getColorScheme() === "dark";
  },
};

export function installReactNativeClientPlatform(): void {
  setClientPlatform(reactNativePlatform);
}
