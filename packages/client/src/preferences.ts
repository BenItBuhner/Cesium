import { clientKeyValueStore } from "./platform";

/**
 * Feature / experiment flags. Persisted account-wide as
 * `GlobalSettingsState.features`; this module only owns the shape, parsing,
 * and the tiny pre-hydration boot cache the inline `<head>` script reads to
 * avoid a layout flash before React mounts.
 */
export type UserPreferences = {
  experimentalIpadMode: boolean;
  experimentalIpadCustomButtons: boolean;
  /** Extra leading padding on editor tabs when the primary sidebar is hidden (iPadOS windowed chrome). */
  experimentalIpadWindowedTabInset: boolean;
  /** Persist enough client state locally to make iPadOS reloads feel like app resume. */
  experimentalIpadResumeCache: boolean;
  /** Desktop-only Beta: enable VS Code extension marketplace/runtime surfaces. */
  vscodeExtensionsBeta: boolean;
};

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  experimentalIpadMode: false,
  experimentalIpadCustomButtons: false,
  experimentalIpadWindowedTabInset: false,
  experimentalIpadResumeCache: false,
  vscodeExtensionsBeta: false,
};

/**
 * Pre-account storage key. Read exactly once (to fold a device's flags into
 * the account) and then removed; nothing writes it anymore.
 */
export const LEGACY_USER_PREFERENCES_STORAGE_KEY = "opencursor-preferences" as const;

/**
 * Write-only mirror of the *effective* feature flags for the inline boot
 * script and the service-worker registrar, which run before (or outside) the
 * settings providers. Never a source of truth: the provider rewrites it from
 * account settings on every change.
 */
export const FEATURES_BOOT_CACHE_STORAGE_KEY = "cesium.boot.features" as const;

/** Broadcast after the effective feature flags change (detail: `UserPreferences`). */
export const USER_PREFERENCES_CHANGED_EVENT = "opencursor:user-preferences-changed" as const;

export function parseUserPreferences(raw: string | null): UserPreferences {
  if (!raw) return DEFAULT_USER_PREFERENCES;

  try {
    const parsed = JSON.parse(raw) as Partial<UserPreferences> | null;
    const experimentalIpadMode = parsed?.experimentalIpadMode === true;
    const hasCustomButtonsPreference =
      parsed != null &&
      Object.prototype.hasOwnProperty.call(parsed, "experimentalIpadCustomButtons");
    const hasWindowedTabInsetPreference =
      parsed != null &&
      Object.prototype.hasOwnProperty.call(parsed, "experimentalIpadWindowedTabInset");
    const hasResumeCachePreference =
      parsed != null &&
      Object.prototype.hasOwnProperty.call(parsed, "experimentalIpadResumeCache");
    const hasVscodeExtensionsBetaPreference =
      parsed != null &&
      Object.prototype.hasOwnProperty.call(parsed, "vscodeExtensionsBeta");

    return {
      experimentalIpadMode,
      experimentalIpadCustomButtons: hasCustomButtonsPreference
        ? parsed?.experimentalIpadCustomButtons === true
        : experimentalIpadMode,
      experimentalIpadWindowedTabInset: hasWindowedTabInsetPreference
        ? parsed?.experimentalIpadWindowedTabInset === true
        : false,
      experimentalIpadResumeCache: hasResumeCachePreference
        ? parsed?.experimentalIpadResumeCache === true
        : false,
      vscodeExtensionsBeta: hasVscodeExtensionsBetaPreference
        ? parsed?.vscodeExtensionsBeta === true
        : false,
    };
  } catch {
    return DEFAULT_USER_PREFERENCES;
  }
}

export function serializeUserPreferences(preferences: UserPreferences): string {
  return JSON.stringify({
    experimentalIpadMode: preferences.experimentalIpadMode,
    experimentalIpadCustomButtons: preferences.experimentalIpadCustomButtons,
    experimentalIpadWindowedTabInset: preferences.experimentalIpadWindowedTabInset,
    experimentalIpadResumeCache: preferences.experimentalIpadResumeCache,
    vscodeExtensionsBeta: preferences.vscodeExtensionsBeta,
  });
}

export function userPreferencesEqual(a: UserPreferences, b: UserPreferences): boolean {
  return (
    a.experimentalIpadMode === b.experimentalIpadMode &&
    a.experimentalIpadCustomButtons === b.experimentalIpadCustomButtons &&
    a.experimentalIpadWindowedTabInset === b.experimentalIpadWindowedTabInset &&
    a.experimentalIpadResumeCache === b.experimentalIpadResumeCache &&
    a.vscodeExtensionsBeta === b.vscodeExtensionsBeta
  );
}

/**
 * Flags a device enabled before they were account-wide, or `null` when the
 * legacy document was never written (so callers can tell "never set" from
 * "explicitly all off").
 */
export function readLegacyUserPreferences(): UserPreferences | null {
  try {
    const raw = clientKeyValueStore().getItem(LEGACY_USER_PREFERENCES_STORAGE_KEY);
    return raw ? parseUserPreferences(raw) : null;
  } catch {
    return null;
  }
}

export function clearLegacyUserPreferences(): void {
  try {
    clientKeyValueStore().removeItem(LEGACY_USER_PREFERENCES_STORAGE_KEY);
  } catch {
    // Storage may be unavailable; the legacy key is only ever read once anyway.
  }
}

/**
 * Fold a device's legacy flags into the account flags. Experiments are opt-in
 * switches, so a flag enabled on this device turns on for the account; the
 * account never loses a flag that is already on.
 */
export function mergeLegacyUserPreferences(
  account: UserPreferences,
  legacy: UserPreferences | null
): UserPreferences {
  if (!legacy) {
    return account;
  }
  const merged: UserPreferences = {
    experimentalIpadMode: account.experimentalIpadMode || legacy.experimentalIpadMode,
    experimentalIpadCustomButtons:
      account.experimentalIpadCustomButtons || legacy.experimentalIpadCustomButtons,
    experimentalIpadWindowedTabInset:
      account.experimentalIpadWindowedTabInset || legacy.experimentalIpadWindowedTabInset,
    experimentalIpadResumeCache:
      account.experimentalIpadResumeCache || legacy.experimentalIpadResumeCache,
    vscodeExtensionsBeta: account.vscodeExtensionsBeta || legacy.vscodeExtensionsBeta,
  };
  return userPreferencesEqual(merged, account) ? account : merged;
}

export function readFeaturesBootCache(): UserPreferences {
  try {
    return parseUserPreferences(clientKeyValueStore().getItem(FEATURES_BOOT_CACHE_STORAGE_KEY));
  } catch {
    return DEFAULT_USER_PREFERENCES;
  }
}

export function writeFeaturesBootCache(preferences: UserPreferences): void {
  try {
    const store = clientKeyValueStore();
    const serialized = serializeUserPreferences(preferences);
    if (store.getItem(FEATURES_BOOT_CACHE_STORAGE_KEY) !== serialized) {
      store.setItem(FEATURES_BOOT_CACHE_STORAGE_KEY, serialized);
    }
  } catch {
    // Quota / private mode: the next boot simply paints without the hint.
  }
}
