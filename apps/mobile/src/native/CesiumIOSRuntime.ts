import { NativeModules, Platform } from "react-native";
import type { WindowInsetsSnapshot } from "./CesiumWindowInsets";

type CesiumIOSRuntimeConstants = {
  /** file:// URL of the bundled workbench index.html inside the .app, or null. */
  workbenchUrl?: string | null;
  /** file:// URL of the .app bundle root (WKWebView read-access scope). */
  bundleRootUrl?: string | null;
};

type CesiumIOSRuntimeModule = CesiumIOSRuntimeConstants & {
  getConstants?: () => CesiumIOSRuntimeConstants;
  getInsets(): Promise<
    WindowInsetsSnapshot & {
      safeAreaBottom?: number;
    }
  >;
};

const nativeModule = NativeModules.CesiumIOSRuntime as CesiumIOSRuntimeModule | undefined;

// Constants are synchronous in both worlds: TurboModule interop exposes
// getConstants(), the legacy bridge spreads them onto the module object.
function readConstants(): CesiumIOSRuntimeConstants {
  if (Platform.OS !== "ios" || !nativeModule) {
    return {};
  }
  try {
    if (typeof nativeModule.getConstants === "function") {
      return nativeModule.getConstants() ?? {};
    }
  } catch {
    // Fall through to the spread-constants shape.
  }
  return nativeModule;
}

function normalizeUrl(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export const CesiumIOSRuntime = {
  isAvailable: Platform.OS === "ios" && nativeModule != null,

  /** The bundled workbench entry point, or null when assets were not bundled. */
  getWorkbenchUrl(): string | null {
    return normalizeUrl(readConstants().workbenchUrl);
  },

  /** The .app bundle root; WKWebView needs it as allowingReadAccessToURL. */
  getBundleRootUrl(): string | null {
    return normalizeUrl(readConstants().bundleRootUrl);
  },

  async getInsets(): Promise<WindowInsetsSnapshot> {
    if (Platform.OS !== "ios" || !nativeModule) {
      return { safeAreaTop: 0, statusBarTop: 0, displayCutoutTop: 0 };
    }
    const snapshot = await nativeModule.getInsets();
    const safeAreaTop = normalizeInset(snapshot.safeAreaTop);
    return {
      safeAreaTop,
      statusBarTop: normalizeInset(snapshot.statusBarTop) || safeAreaTop,
      displayCutoutTop: normalizeInset(snapshot.displayCutoutTop),
    };
  },
};

function normalizeInset(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : 0;
}
