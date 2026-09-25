import { getGlobalSettings } from "../global-settings-store.js";

/**
 * Projects is a Beta: on when the account flag `features.projects` is set, or
 * when `CESIUM_PROJECTS_ENABLED=1` (tests and headless peer engines).
 */
export async function isProjectsEnabled(): Promise<boolean> {
  if (process.env.CESIUM_PROJECTS_ENABLED?.trim() === "1") {
    return true;
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
    super("Projects is disabled. Turn it on in Settings → Advanced → Beta.");
    this.name = "ProjectsDisabledError";
  }
}

export async function assertProjectsEnabled(): Promise<void> {
  if (!(await isProjectsEnabled())) {
    throw new ProjectsDisabledError();
  }
}
