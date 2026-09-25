import { getGlobalSettings } from "../global-settings-store.js";

/**
 * Projects is a Beta that ships on: the account flag `features.projects`
 * defaults to true and turns it off when cleared. `CESIUM_PROJECTS_ENABLED`
 * overrides the account for headless engines and tests (`1` on, `0` off).
 */
export async function isProjectsEnabled(): Promise<boolean> {
  const override = process.env.CESIUM_PROJECTS_ENABLED?.trim();
  if (override === "1") {
    return true;
  }
  if (override === "0") {
    return false;
  }
  try {
    return (await getGlobalSettings()).features.projects === true;
  } catch {
    return false;
  }
}

export class ProjectsDisabledError extends Error {
  readonly code = "projects_disabled";
  constructor() {
    super("Projects is turned off. Turn it on in Settings → Advanced → Beta.");
    this.name = "ProjectsDisabledError";
  }
}

export async function assertProjectsEnabled(): Promise<void> {
  if (!(await isProjectsEnabled())) {
    throw new ProjectsDisabledError();
  }
}
