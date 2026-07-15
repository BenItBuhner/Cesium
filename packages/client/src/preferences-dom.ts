import type { UserPreferences } from "./preferences";
import { resolveEffectiveUserPreferences } from "./platform-feature-flags";

const EXPERIMENTAL_IPAD_MODE_ATTR = "data-experimental-ipad-mode";
const EXPERIMENTAL_IPAD_MODE_CLASS = "experimental-ipad-mode";
const EXPERIMENTAL_IPAD_RESUME_CACHE_ATTR = "data-experimental-ipad-resume-cache";
const EXPERIMENTAL_IPAD_RESUME_CACHE_CLASS = "experimental-ipad-resume-cache";

export function applyDomUserPreferences(preferences: UserPreferences): void {
  if (typeof document === "undefined") return;

  const effective = resolveEffectiveUserPreferences(preferences);
  const enabled = effective.experimentalIpadMode;
  const resumeCacheEnabled = effective.experimentalIpadResumeCache;
  document.documentElement.setAttribute(
    EXPERIMENTAL_IPAD_MODE_ATTR,
    enabled ? "true" : "false"
  );
  document.documentElement.classList.toggle(
    EXPERIMENTAL_IPAD_MODE_CLASS,
    enabled
  );
  document.documentElement.setAttribute(
    EXPERIMENTAL_IPAD_RESUME_CACHE_ATTR,
    resumeCacheEnabled ? "true" : "false"
  );
  document.documentElement.classList.toggle(
    EXPERIMENTAL_IPAD_RESUME_CACHE_CLASS,
    resumeCacheEnabled
  );
}
