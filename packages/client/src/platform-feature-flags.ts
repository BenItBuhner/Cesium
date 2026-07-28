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

function isCesiumDesktopRenderer(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return Boolean(
    (window as Window & { cesiumDesktop?: { isElectron?: boolean } }).cesiumDesktop
      ?.isElectron
  );
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
    experimentalIpadWindowedTabInset: flags.ipadExperimentalUi
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
