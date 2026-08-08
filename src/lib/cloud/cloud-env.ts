"use client";

import { clientKeyValueStore } from "@cesium/client";
import { getCloudMode } from "./cloud-flags";

/**
 * Cloud Context environment detection (client side).
 *
 * Mode resolution and the master `NEXT_PUBLIC_CESIUM_CLOUD` switch live in
 * `cloud-flags.ts` (pure, importable from the Next proxy boundary and tests);
 * this module re-exports them and adds the browser-only device identity.
 */
export {
  getClerkPublishableKey,
  getCloudMode,
  getConvexUrl,
  isCloudExplicitlyDisabled,
  isSignInRequired,
  type CloudMode,
} from "./cloud-flags";

export const CLOUD_DEVICE_KEY_STORAGE_KEY = "cesium-cloud-device-key";

const DEVICE_KEY_PATTERN = /^[A-Za-z0-9-]{16,64}$/;

/** Stable per-browser identity for device mode. Created on first use. */
export function getOrCreateDeviceKey(): string {
  const store = clientKeyValueStore();
  const existing = store.getItem(CLOUD_DEVICE_KEY_STORAGE_KEY);
  if (existing && DEVICE_KEY_PATTERN.test(existing)) {
    return existing;
  }
  const created =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  store.setItem(CLOUD_DEVICE_KEY_STORAGE_KEY, created);
  return created;
}

/**
 * Adopt an existing device identity on this browser (device-mode analogue of
 * signing in on a new machine). Only honored in device mode; Clerk mode has
 * real accounts. Returns true when the key was adopted and a reload is needed.
 */
export function adoptDeviceKey(key: string): boolean {
  if (getCloudMode() !== "device" || !DEVICE_KEY_PATTERN.test(key)) {
    return false;
  }
  const store = clientKeyValueStore();
  if (store.getItem(CLOUD_DEVICE_KEY_STORAGE_KEY) === key) {
    return false;
  }
  store.setItem(CLOUD_DEVICE_KEY_STORAGE_KEY, key);
  return true;
}
