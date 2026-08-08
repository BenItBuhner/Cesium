"use client";

import { clientKeyValueStore } from "@cesium/client";

/**
 * Cloud Context environment detection.
 *
 * Three modes, chosen purely from build-time env so every platform can dial
 * in its own posture (Electron ships with cloud disabled by default; a hosted
 * web deployment ships Clerk + Convex):
 *
 * - "disabled": no `NEXT_PUBLIC_CONVEX_URL`. Fully local-first, zero cloud.
 * - "device":   Convex configured, Clerk not. Identity is a per-browser
 *               device key honored only by deployments that opt in with
 *               `CESIUM_ALLOW_DEVICE_KEYS=1` (local dev / self-hosted).
 * - "clerk":    Convex + Clerk. Production path — sign in anywhere, your
 *               servers/preferences/conversations follow you.
 */
export type CloudMode = "disabled" | "device" | "clerk";

export function getConvexUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
  return url ? url : null;
}

export function getClerkPublishableKey(): string | null {
  const key = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim();
  return key ? key : null;
}

export function getCloudMode(): CloudMode {
  if (!getConvexUrl()) {
    return "disabled";
  }
  return getClerkPublishableKey() ? "clerk" : "device";
}

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
