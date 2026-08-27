/**
 * Best-effort client platform detection for the /download page.
 *
 * Chromium exposes structured `navigator.userAgentData` (including CPU
 * architecture via a high-entropy hint); Safari and Firefox fall back to
 * user-agent sniffing plus sensible per-platform defaults. Detection only
 * picks the *preselected* download - every platform stays one click away.
 */

export type DetectedOs = "mac" | "win" | "linux" | "android" | "ios" | "unknown";

export type DetectedPlatform = {
  os: DetectedOs;
  /** Best-effort CPU architecture; null when the browser gives no signal. */
  arch: "arm64" | "x64" | null;
  /** True when the arch came from a real browser signal, not a default. */
  archConfident: boolean;
};

type UserAgentDataLike = {
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{
    architecture?: string;
    bitness?: string;
  }>;
};

/** Pure OS classification from user-agent signals (exported for tests). */
export function detectOs(
  userAgent: string,
  uaDataPlatform: string | undefined,
  maxTouchPoints: number
): DetectedOs {
  const platform = (uaDataPlatform ?? "").toLowerCase();
  if (platform.includes("android") || /android/i.test(userAgent)) {
    return "android";
  }
  // iPadOS masquerades as macOS but reports multi-touch.
  if (
    /iphone|ipad|ipod/i.test(userAgent) ||
    (/mac/i.test(userAgent) && maxTouchPoints > 1)
  ) {
    return "ios";
  }
  if (platform.includes("mac") || /mac os x|macintosh/i.test(userAgent)) {
    return "mac";
  }
  if (platform.includes("win") || /windows/i.test(userAgent)) {
    return "win";
  }
  if (platform.includes("linux") || /linux|x11/i.test(userAgent)) {
    return "linux";
  }
  return "unknown";
}

export async function detectClientPlatform(): Promise<DetectedPlatform> {
  if (typeof navigator === "undefined") {
    return { os: "unknown", arch: null, archConfident: false };
  }
  const uaData = (navigator as { userAgentData?: UserAgentDataLike }).userAgentData;
  const os = detectOs(
    navigator.userAgent,
    uaData?.platform,
    navigator.maxTouchPoints ?? 0
  );

  if (uaData?.getHighEntropyValues) {
    try {
      const { architecture, bitness } = await uaData.getHighEntropyValues([
        "architecture",
        "bitness",
      ]);
      if (architecture === "arm") {
        return { os, arch: "arm64", archConfident: true };
      }
      if (architecture === "x86" && bitness === "64") {
        return { os, arch: "x64", archConfident: true };
      }
    } catch {
      // Fall through to defaults below.
    }
  }
  // Safari on Apple silicon gives no arch signal; default modern Macs to
  // arm64 and everything else to x64.
  if (os === "mac") {
    return { os, arch: "arm64", archConfident: false };
  }
  if (os === "win" || os === "linux") {
    return { os, arch: "x64", archConfident: false };
  }
  return { os, arch: null, archConfident: false };
}
