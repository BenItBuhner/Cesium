import type {
  BrowserControlCapabilities,
  BrowserControlEngineKind,
  BrowserControlViewport,
  BrowserControlViewportPreset,
} from "./types.js";

export const BROWSER_CONTROL_VIEWPORT_PRESETS: Record<
  Exclude<BrowserControlViewportPreset, "custom">,
  BrowserControlViewport
> = {
  watch: { preset: "watch", width: 390, height: 390, deviceScaleFactor: 2, mobile: true, touch: true },
  mobile: { preset: "mobile", width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true },
  tablet: { preset: "tablet", width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, touch: true },
  laptop: { preset: "laptop", width: 1366, height: 768, deviceScaleFactor: 1, mobile: false, touch: false },
  desktop: { preset: "desktop", width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, touch: false },
};

export const DEFAULT_BROWSER_CONTROL_VIEWPORT: BrowserControlViewport =
  BROWSER_CONTROL_VIEWPORT_PRESETS.desktop;

const baseCapabilities: BrowserControlCapabilities = {
  tabLifecycle: true,
  navigation: true,
  lock: true,
  screenshot: false,
  snapshot: false,
  contentSearch: false,
  jsEvaluate: false,
  mouseInput: false,
  keyboardInput: false,
  viewportEmulation: false,
  events: false,
};

export function browserControlCapabilitiesForEngine(
  engine: BrowserControlEngineKind
): BrowserControlCapabilities {
  if (engine === "server-chromium") {
    return {
      ...baseCapabilities,
      screenshot: true,
      snapshot: true,
      contentSearch: true,
      jsEvaluate: true,
      mouseInput: true,
      keyboardInput: true,
      viewportEmulation: true,
      events: true,
    };
  }
  if (engine === "electron-native") {
    return {
      ...baseCapabilities,
      screenshot: true,
      snapshot: true,
      contentSearch: true,
      jsEvaluate: true,
      mouseInput: true,
      keyboardInput: true,
      viewportEmulation: true,
      events: true,
    };
  }
  return baseCapabilities;
}

export function normalizeBrowserControlViewport(input?: {
  preset?: BrowserControlViewportPreset;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  touch?: boolean;
} | null): BrowserControlViewport {
  if (!input) return DEFAULT_BROWSER_CONTROL_VIEWPORT;
  if (input.preset && input.preset !== "custom") {
    return BROWSER_CONTROL_VIEWPORT_PRESETS[input.preset];
  }
  const width = Number.isFinite(input.width) ? Math.floor(input.width ?? 0) : 0;
  const height = Number.isFinite(input.height) ? Math.floor(input.height ?? 0) : 0;
  return {
    preset: "custom",
    width: Math.max(64, Math.min(width || DEFAULT_BROWSER_CONTROL_VIEWPORT.width, 2400)),
    height: Math.max(64, Math.min(height || DEFAULT_BROWSER_CONTROL_VIEWPORT.height, 2400)),
    deviceScaleFactor: input.deviceScaleFactor,
    mobile: input.mobile,
    touch: input.touch,
  };
}
