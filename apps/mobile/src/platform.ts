import { Appearance } from "react-native";
import {
  createMemoryKeyValueStore,
  setClientPlatform,
  type ClientPlatform,
} from "@cesium/client";

/**
 * React Native implementation of the @cesium/client platform adapter.
 * Storage is in-memory for now (persistent MMKV/AsyncStorage lands with the
 * native workbench UI); events use an in-process emitter since RN has no
 * cross-tab concept; the server base URL comes from the launch/runtime config.
 */

const listeners = new Map<string, Set<() => void>>();
let runtimeServerBaseUrl: string | null = null;

export function setRuntimeServerBaseUrl(baseUrl: string | null): void {
  runtimeServerBaseUrl = baseUrl?.trim() || null;
}

const reactNativePlatform: ClientPlatform = {
  keyValueStore: createMemoryKeyValueStore(),
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
