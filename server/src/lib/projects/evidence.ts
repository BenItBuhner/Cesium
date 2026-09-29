import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isProjectEvidencePath,
  isProjectUiPath,
  projectEvidenceEmbed,
  type ProjectChildEvidence,
} from "@cesium/core/projects";
import { getProjectContextDir } from "./paths.js";
import { childHostFor, messageProjectChild, patchChild } from "./project-service.js";
import { readProject } from "./project-store.js";
import type { ProjectChildRecord, ProjectRecord } from "./types.js";

const EMBEDS_LISTED = 6;
const UI_FILES_LISTED = 4;
const MEDIA_DEPTH = 3;

function listed(files: readonly string[]): string {
  const shown = files.slice(0, UI_FILES_LISTED).join(", ");
  return files.length > UI_FILES_LISTED ? `${shown} and ${files.length - UI_FILES_LISTED} more` : shown;
}

/** Screenshots and recordings under `media/<folder>/` in the Project context, as context paths. */
async function mediaIn(projectId: string, folder: string): Promise<string[]> {
  const contextRoot = getProjectContextDir(projectId);
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < MEDIA_DEPTH) {
        await walk(absolute, depth + 1);
      } else if (entry.isFile() && isProjectEvidencePath(entry.name)) {
        found.push(path.relative(contextRoot, absolute).split(path.sep).join("/"));
      }
    }
  };
  await walk(path.join(contextRoot, "media", folder), 0);
  return found.sort();
}

/** A worker's evidence: its own media folder and those of browser checks that ran in its working tree. */
async function evidenceFiles(record: ProjectRecord, worker: ProjectChildRecord): Promise<string[]> {
  const checks = record.children.filter(
    (child) =>
      child.kind === "helper" &&
      child.helperKind === "browser" &&
      child.engineId === worker.engineId &&
      child.workspaceId === worker.workspaceId
  );
  const lists = await Promise.all([worker, ...checks].map((child) => mediaIn(record.id, child.name)));
  return lists.flat();
}

export function buildEvidenceRequest(agentName: string, uiFiles: readonly string[]): string {
  return [
    `Your change touches what users see (${listed(uiFiles)}), but there are no screenshots or recording of it in your evidence folder (media/${agentName}/ in the Project context, as your brief says), so it doesn't count as done yet.`,
    'Run the app and capture the result. With Cesium\'s browser tools: call_mcp_tool on server "browser" with browser_navigate, then browser_screenshot, and browser_record ("start" before an interaction, "stop" after) for anything that moves. They save under artifacts/browser/ in your workspace, so copy the files into your evidence folder.',
    "Add them to your pull request description, then report their paths.",
  ].join("\n");
}

function embeds(files: readonly string[]): string {
  const shown = files.slice(-EMBEDS_LISTED).map(projectEvidenceEmbed).join(" ");
  return files.length > EMBEDS_LISTED ? `${shown} (and ${files.length - EMBEDS_LISTED} more)` : shown;
}

/**
 * Checks a worker's work after a finished turn: when its branch changes what
 * users see, it counts as done only with screenshots or a recording. Missing
 * evidence is asked for once (queued to the agent, unless `ask` is false).
 * Returns a line for the coordinator's update: the evidence to embed, or that
 * it is missing. Null when the change touches no UI.
 */
export async function checkWorkerEvidence(
  projectId: string,
  childId: string,
  options: { ask: boolean }
): Promise<string | null> {
  const record = await readProject(projectId);
  const child = record?.children.find((entry) => entry.id === childId);
  if (!record || !child || child.kind !== "worker" || child.deletedAt != null || child.isolation === "scratch") {
    return null;
  }
  const changed = await childHostFor(child.engineId)
    .changedFiles({ workspaceId: child.workspaceId, conversationId: child.conversationId }, child.baseSha)
    .catch(() => null);
  if (changed == null) {
    return null;
  }
  const uiFiles = changed.filter(isProjectUiPath);
  if (uiFiles.length === 0) {
    if (child.evidence) {
      await patchChild(projectId, childId, () => ({ evidence: null }));
    }
    return null;
  }
  const files = await evidenceFiles(record, child);
  const now = Date.now();
  if (files.length > 0) {
    await patchChild(projectId, childId, () => ({ evidence: { uiFiles, files, requestedAt: null, checkedAt: now } }));
    return `Evidence for its UI change (${listed(uiFiles)}): ${embeds(files)}. Embed it when you tell the user.`;
  }
  const askedAt = child.evidence?.requestedAt ?? null;
  const evidence: ProjectChildEvidence = { uiFiles, files: [], requestedAt: askedAt, checkedAt: now };
  if (askedAt != null || !options.ask) {
    await patchChild(projectId, childId, () => ({ evidence }));
    return askedAt != null
      ? `Evidence: still missing. It changed UI files (${listed(uiFiles)}) and was asked for screenshots, but media/${child.name}/ is still empty. Don't report this change as done: capture it with project_browser_check, or ask ${child.name} again.`
      : `Evidence: missing. It changed UI files (${listed(uiFiles)}) without screenshots or a recording in media/${child.name}/.`;
  }
  const asked = await messageProjectChild(projectId, child.id, buildEvidenceRequest(child.name, uiFiles), "queue").then(
    () => true,
    (error: unknown) => {
      console.warn(`[projects] could not ask ${child.name} for evidence:`, error instanceof Error ? error.message : error);
      return false;
    }
  );
  await patchChild(projectId, childId, () => ({ evidence: { ...evidence, requestedAt: asked ? now : null } }));
  return asked
    ? `Evidence: missing. It changed UI files (${listed(uiFiles)}) but saved no screenshots or recording in media/${child.name}/, so the Project asked it to capture them. The change is not done until they arrive.`
    : `Evidence: missing. It changed UI files (${listed(uiFiles)}) but saved no screenshots or recording in media/${child.name}/, and asking it for them failed. Ask it yourself.`;
}

/**
 * After a browser check's turn: its screenshots to embed, and the checked
 * worker's evidence refreshed (a check can supply what the worker lacked).
 */
export async function afterBrowserCheck(projectId: string, helperId: string): Promise<string | null> {
  const record = await readProject(projectId);
  const helper = record?.children.find((entry) => entry.id === helperId);
  if (!record || !helper || helper.kind !== "helper" || helper.helperKind !== "browser") {
    return null;
  }
  const worker = record.children.find(
    (child) =>
      child.kind === "worker" &&
      child.deletedAt == null &&
      child.engineId === helper.engineId &&
      child.workspaceId === helper.workspaceId
  );
  if (worker?.evidence) {
    await checkWorkerEvidence(projectId, worker.id, { ask: false });
  }
  const files = await mediaIn(projectId, helper.name);
  return files.length > 0 ? `Evidence: ${embeds(files)}. Embed it when you tell the user.` : null;
}
