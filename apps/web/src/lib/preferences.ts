export const USER_PREFERENCES_STORAGE_KEY = "opencursor-preferences" as const;

export type UserPreferences = {
  experimentalIpadMode: boolean;
  experimentalIpadCustomButtons: boolean;
};

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  experimentalIpadMode: false,
  experimentalIpadCustomButtons: false,
};

export function parseUserPreferences(raw: string | null): UserPreferences {
  if (!raw) return DEFAULT_USER_PREFERENCES;

  try {
    const parsed = JSON.parse(raw) as Partial<UserPreferences> | null;
    const experimentalIpadMode = parsed?.experimentalIpadMode === true;
    const hasCustomButtonsPreference =
      parsed != null &&
      Object.prototype.hasOwnProperty.call(parsed, "experimentalIpadCustomButtons");

    return {
      experimentalIpadMode,
      experimentalIpadCustomButtons: hasCustomButtonsPreference
        ? parsed?.experimentalIpadCustomButtons === true
        : experimentalIpadMode,
    };
  } catch {
    return DEFAULT_USER_PREFERENCES;
  }
}

export function serializeUserPreferences(preferences: UserPreferences): string {
  return JSON.stringify({
    experimentalIpadMode: preferences.experimentalIpadMode,
    experimentalIpadCustomButtons: preferences.experimentalIpadCustomButtons,
  });
}
