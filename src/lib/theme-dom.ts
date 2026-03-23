import type { ThemePreference } from "@/lib/theme";

/** Applies `dark` class on `<html>` from a stored preference (call only in the browser). */
export function applyDomTheme(pref: ThemePreference): void {
  if (typeof document === "undefined") return;
  const dark =
    pref === "dark"
      ? true
      : pref === "light"
        ? false
        : window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", dark);
}
