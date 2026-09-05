/**
 * Filenames under `/integration-icons/` (public/).
 *
 * Theme-agnostic brand marks for Cloud Agents providers (and related
 * integration surfaces): Light SVGs use dark fills for light backgrounds,
 * Dark SVGs use light fills for `html.dark`.
 */
export type IntegrationIconId = "github" | "linear" | "slack" | "manual";

export type IntegrationIconFilenames = {
  light: string;
  dark: string;
};

export const INTEGRATION_ICON_FILES: Record<
  IntegrationIconId,
  IntegrationIconFilenames
> = {
  github: { light: "GitHub-Light.svg", dark: "GitHub-Dark.svg" },
  linear: { light: "Linear-Light.svg", dark: "Linear-Dark.svg" },
  slack: { light: "Slack-Light.svg", dark: "Slack-Dark.svg" },
  // Manual / test-dispatched Cloud Agents tasks use the Cesium mark.
  manual: { light: "Cesium-Light.svg", dark: "Cesium-Dark.svg" },
};

export const INTEGRATION_ICON_LABELS: Record<IntegrationIconId, string> = {
  github: "GitHub",
  linear: "Linear",
  slack: "Slack",
  manual: "Cloud Agents",
};

export function normalizeIntegrationIconId(
  providerId: string | null | undefined
): IntegrationIconId | null {
  const id = String(providerId ?? "")
    .trim()
    .toLowerCase();
  if (id === "github" || id === "linear" || id === "slack" || id === "manual") {
    return id;
  }
  return null;
}

export function hasIntegrationIconAsset(providerId: string): boolean {
  return normalizeIntegrationIconId(providerId) != null;
}

export function integrationIconLabel(providerId: string): string {
  const id = normalizeIntegrationIconId(providerId);
  if (!id) {
    return providerId;
  }
  return INTEGRATION_ICON_LABELS[id];
}
