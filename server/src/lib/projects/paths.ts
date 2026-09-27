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

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

/** On a peer engine: every Project context mirror held for one peer token. */
export function getPeerMirrorsDir(peerTokenId: string): string {
  if (!SAFE_SEGMENT.test(peerTokenId)) {
    throw new Error("Invalid peer token id for a context mirror.");
  }
  return path.join(DATA_DIR, "projects-mirror", peerTokenId);
}

/**
 * On a peer engine: the copy of a home engine's Project context that its
 * agents here read and write, one per peer token so homes never share one.
 */
export function getPeerMirrorContextDir(peerTokenId: string, projectId: string): string {
  if (!SAFE_SEGMENT.test(projectId)) {
    throw new Error("Invalid project id for a context mirror.");
  }
  return path.join(getPeerMirrorsDir(peerTokenId), projectId, "context");
}

/** The Project context folder a Project agent may use with its file tools, if any. */
export function projectAgentContextDir(
  origin: { kind: string; projectId?: string; peerTokenId?: string | null } | null | undefined
): string | null {
  if (origin?.kind !== "project-child" || !origin.projectId) {
    return null;
  }
  try {
    return origin.peerTokenId
      ? getPeerMirrorContextDir(origin.peerTokenId, origin.projectId)
      : getProjectContextDir(origin.projectId);
  } catch {
    return null;
  }
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

/**
 * True for a Project worker's own worktree (`projects/<id>/worktrees/<name>`).
 * Engine helpers must not edit tracked files such as `.gitignore` there: a
 * worker commits everything it changes, so those edits would land in its PR.
 */
export function isWorkerWorktreeRoot(root: string): boolean {
  if (!isProjectWorkspaceRoot(root)) {
    return false;
  }
  const relative = path
    .relative(getProjectsRootDir(), path.resolve(root))
    .replace(/\\/g, "/");
  return /^prj_[a-f0-9]{12}\/worktrees\/[^/]+$/.test(relative);
}
