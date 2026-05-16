"use client";

export type NativeShellBridge = {
  platform?: string;
  serverBaseUrl?: string;
  source?: string;
  webBaseUrl?: string;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function sanitizeHttpBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function getNativeShellBridge(): NativeShellBridge | null {
  if (typeof window === "undefined") {
    return null;
  }
  const bridge = (window as Window & { __CESIUM_NATIVE_SHELL__?: unknown })
    .__CESIUM_NATIVE_SHELL__;
  return bridge && typeof bridge === "object" ? (bridge as NativeShellBridge) : null;
}

export function getNativeShellServerBaseUrl(): string | null {
  return sanitizeHttpBaseUrl(getNativeShellBridge()?.serverBaseUrl);
}

export function isLoopbackServerBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
