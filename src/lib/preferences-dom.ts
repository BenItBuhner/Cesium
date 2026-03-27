import type { UserPreferences } from "@/lib/preferences";

const EXPERIMENTAL_IPAD_MODE_ATTR = "data-experimental-ipad-mode";
const EXPERIMENTAL_IPAD_MODE_CLASS = "experimental-ipad-mode";

export function applyDomUserPreferences(preferences: UserPreferences): void {
  if (typeof document === "undefined") return;

  const enabled = preferences.experimentalIpadMode;
  document.documentElement.setAttribute(
    EXPERIMENTAL_IPAD_MODE_ATTR,
    enabled ? "true" : "false"
  );
  document.documentElement.classList.toggle(
    EXPERIMENTAL_IPAD_MODE_CLASS,
    enabled
  );
}
