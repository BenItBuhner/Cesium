import type { UserPreferences } from "./preferences";

export type CesiumRendererFeatureFlags = {
  /** Show the iPad subsection under Settings → Beta. */
  ipadBetaSettings: boolean;
  /** Honor iPad-only UI preference toggles and DOM experiment attrs. */
  ipadExperimentalUi: boolean;
  /** Register the iPad fast-resume service worker and IndexedDB cache. */
  ipadResumeCache: boolean;
  /** Show and honor the VS Code extension Beta runtime. */
  vscodeExtensionsBetaSettings: boolean;
};

type CesiumShellGlobals = {
  cesiumDesktop?: { isElectron?: boolean };
  cesiumMobile?: unknown;
  __CESIUM_MOBILE_SERVER__?: unknown;
};

function shellGlobals(): CesiumShellGlobals | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window as Window & CesiumShellGlobals;
}

function isCesiumDesktopRenderer(): boolean {
  return Boolean(shellGlobals()?.cesiumDesktop?.isElectron);
}

/**
 * True inside the official Android / iOS app WebView (the RN shell injects
 * `window.cesiumMobile` / `__CESIUM_MOBILE_SERVER__`). Regular mobile
 * browsers and installed PWAs do not set these.
 */
export function isCesiumMobileApp(): boolean {
  const globals = shellGlobals();
  return Boolean(globals?.cesiumMobile || globals?.__CESIUM_MOBILE_SERVER__);
}

/**
 * Electron desktop (Windows / Linux / macOS) or the native mobile app.
 * These surfaces ship their own official engines and must not surface the
 * tab-local browser machine.
 */
export function isNativeCesiumShell(): boolean {
  return isCesiumDesktopRenderer() || isCesiumMobileApp();
}

/**
 * The in-tab "Use this browser" engine is only for hosted web and PWA
 * surfaces. Native shells already have a real local/remote server.
 */
export function isBrowserMachineOffered(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return !isNativeCesiumShell();
}

/**
 * True inside the Electron shell on macOS, where the window uses
 * `titleBarStyle: "hiddenInset"` and the native traffic lights overlay the
 * top-left of the renderer - the same geometry the iPadOS windowed-mode
 * leading inset was built for.
 */
export function isMacElectronRenderer(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const bridge = (
    window as Window & { cesiumDesktop?: { isElectron?: boolean; platform?: string } }
  ).cesiumDesktop;
  return Boolean(bridge?.isElectron) && bridge?.platform === "darwin";
}

/**
 * The VS Code extension Beta is desktop-first, but can be force-enabled for
 * web renderers via `NEXT_PUBLIC_VSCODE_EXTENSIONS_WEB=1` (build-time) or by
 * setting `localStorage["cesium.vscodeExtensionsWeb"] = "1"` (runtime).
 */
function isVscodeExtensionsWebOverrideEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_VSCODE_EXTENSIONS_WEB === "1") {
    return true;
  }
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem("cesium.vscodeExtensionsWeb") === "1";
  } catch {
    return false;
  }
}

export function getCesiumRendererFeatureFlags(): CesiumRendererFeatureFlags {
  const desktop = isCesiumDesktopRenderer();
  return {
    ipadBetaSettings: !desktop,
    ipadExperimentalUi: !desktop,
    ipadResumeCache: !desktop,
    vscodeExtensionsBetaSettings: desktop || isVscodeExtensionsWebOverrideEnabled(),
  };
}

export function areIpadBetaFeaturesEnabled(): boolean {
  return getCesiumRendererFeatureFlags().ipadExperimentalUi;
}

export function resolveEffectiveUserPreferences(
  preferences: UserPreferences
): UserPreferences {
  const flags = getCesiumRendererFeatureFlags();
  return {
    ...preferences,
    experimentalIpadMode: flags.ipadExperimentalUi
      ? preferences.experimentalIpadMode
      : false,
    experimentalIpadCustomButtons: flags.ipadExperimentalUi
      ? preferences.experimentalIpadCustomButtons
      : false,
    // macOS Electron always needs the leading window-chrome inset: the
    // native traffic lights overlay the top-left of the frameless content.
    experimentalIpadWindowedTabInset: isMacElectronRenderer()
      ? true
      : flags.ipadExperimentalUi
        ? preferences.experimentalIpadWindowedTabInset
        : false,
    experimentalIpadResumeCache: flags.ipadResumeCache
      ? preferences.experimentalIpadResumeCache
      : false,
    vscodeExtensionsBeta: flags.vscodeExtensionsBetaSettings
      ? preferences.vscodeExtensionsBeta
      : false,
  };
}
