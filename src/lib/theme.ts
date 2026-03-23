export const THEME_STORAGE_KEY = "opencursor-theme" as const;

export type ThemePreference = "light" | "dark" | "system";

export function parseThemePreference(raw: string | null): ThemePreference {
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  return "system";
}
