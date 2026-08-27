export type SettingsHeaderSegment = {
  label: string;
  onClick?: () => void;
};

export type SettingsHeaderModel = {
  currentLabel: string;
  ancestors: SettingsHeaderSegment[];
  parent: SettingsHeaderSegment | null;
  backLabel: string | null;
  backAriaLabel: string | null;
  showTrail: boolean;
};

/**
 * Resolve settings page chrome: mobile uses a single parent/Agents back
 * control (no crumb trail), desktop shows clickable ancestors only.
 */
export function resolveSettingsHeaderModel(
  segments: SettingsHeaderSegment[],
  options: { isMobile: boolean; canCloseShell: boolean }
): SettingsHeaderModel | null {
  if (segments.length === 0) {
    return null;
  }
  const current = segments[segments.length - 1];
  if (!current) {
    return null;
  }
  const ancestors = segments.slice(0, -1);
  const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1] ?? null : null;
  const backLabel = parent ? parent.label : options.canCloseShell ? "Agents" : null;
  const backAriaLabel = backLabel ? `Back to ${backLabel}` : null;
  return {
    currentLabel: current.label,
    ancestors,
    parent,
    backLabel,
    backAriaLabel,
    showTrail: !options.isMobile && ancestors.length > 0,
  };
}
