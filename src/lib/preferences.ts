export const USER_PREFERENCES_STORAGE_KEY = "opencursor-preferences" as const;

export type UserPreferences = {
  experimentalIpadMode: boolean;
};

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  experimentalIpadMode: false,
};

export function parseUserPreferences(raw: string | null): UserPreferences {
  if (!raw) return DEFAULT_USER_PREFERENCES;

  try {
    const parsed = JSON.parse(raw) as Partial<UserPreferences> | null;
    return {
      experimentalIpadMode: parsed?.experimentalIpadMode === true,
    };
  } catch {
    return DEFAULT_USER_PREFERENCES;
  }
}

export function serializeUserPreferences(preferences: UserPreferences): string {
  return JSON.stringify({
    experimentalIpadMode: preferences.experimentalIpadMode,
  });
}
