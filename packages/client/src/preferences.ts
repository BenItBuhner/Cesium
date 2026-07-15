export const USER_PREFERENCES_STORAGE_KEY = "opencursor-preferences" as const;

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
