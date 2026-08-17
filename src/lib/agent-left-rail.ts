/**
 * Collapsed = the left workspace rail is hidden.
 *
 * Fresh sessions have no explicit preference. On mobile the rail is a
 * full-viewport drawer, so default to collapsed and show the new-chat page.
 * Tablet and desktop keep the rail open.
 */
export function resolveLeftRailCollapsed({
  isMobile,
  persistedLeftRailCollapsed,
}: {
  isMobile: boolean;
  persistedLeftRailCollapsed: boolean | null;
}): boolean {
  if (persistedLeftRailCollapsed != null) {
    return persistedLeftRailCollapsed;
  }
  return isMobile;
}

/** Desktop/tablet restore a stored rail preference; mobile always starts closed. */
export function shouldRestorePersistedLeftRailCollapsed(isMobile: boolean): boolean {
  return !isMobile;
}
