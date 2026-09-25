import path from "node:path";
import { DATA_DIR } from "../persistence.js";

export const PROJECT_WORKSPACE_KIND = "project" as const;

const PROJECT_ID_PATTERN = /^prj_[a-f0-9]{12}$/;

export function getProjectsRootDir(): string {
  return path.join(DATA_DIR, "projects");
}

export function isValidProjectId(projectId: string): boolean {
  return PROJECT_ID_PATTERN.test(projectId);
}

function assertProjectId(projectId: string): void {
  if (!isValidProjectId(projectId)) {
    throw new Error(`Invalid project id: ${projectId}`);
  }
}

export function getProjectDir(projectId: string): string {
  assertProjectId(projectId);
  return path.join(getProjectsRootDir(), projectId);
}

export function getProjectRecordPath(projectId: string): string {
  return path.join(getProjectDir(projectId), "project.json");
}

/** The Project's shared context folder; also the orchestrator's workspace root. */
export function getProjectContextDir(projectId: string): string {
  return path.join(getProjectDir(projectId), "context");
}

/** True when `root` sits inside the Projects tree (context folders live there). */
export function isProjectWorkspaceRoot(root: string): boolean {
  const normalized = path.resolve(root).replace(/\\/g, "/");
  const base = path.resolve(getProjectsRootDir()).replace(/\\/g, "/");
  if (normalized === base) {
    return false;
  }
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return normalized.startsWith(prefix);
}
