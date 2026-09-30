import {
  PROJECT_HOME_ENGINE_ID,
  type ProjectEngineSummary,
  type ProjectPeerTokenSummary,
} from "@cesium/core/projects";
import { promises as fs } from "node:fs";
import { closeMirrorFeed } from "./context-feed.js";
import { forgetContextHashes } from "./context-sync.js";
import { listEngineSummaries, registerPeerEngine, removePeerEngine } from "./engine-registry.js";
import { ProjectError } from "./errors.js";
import { assertProjectsEnabled } from "./feature-flag.js";
import { getPeerMirrorsDir } from "./paths.js";
import { listPeerTokens, mintPeerToken, revokePeerToken } from "./peer-tokens.js";
import { listProjectRecords } from "./project-store.js";

/** Engine pairing for Projects: peers this engine drives, and tokens that let others drive it. */

export async function listProjectEngineSummaries(): Promise<ProjectEngineSummary[]> {
  await assertProjectsEnabled();
  return listEngineSummaries();
}

export async function addProjectEngine(input: {
  baseUrl: string;
  token: string;
  label?: string | null;
}): Promise<ProjectEngineSummary> {
  await assertProjectsEnabled();
  return (await registerPeerEngine(input)).engine;
}

export async function deleteProjectEngine(engineId: string): Promise<void> {
  await assertProjectsEnabled();
  if (engineId === PROJECT_HOME_ENGINE_ID) {
    throw new ProjectError("The home engine cannot be removed.");
  }
  const users = (await listProjectRecords())
    .filter(
      (record) =>
        record.repos.some((repo) => repo.engineId === engineId) ||
        record.children.some((child) => child.deletedAt == null && child.engineId === engineId)
    )
    .map((record) => record.name);
  if (users.length > 0) {
    throw new ProjectError(
      `Projects still use this engine: ${users.join(", ")}. Remove its repositories and agents first.`,
      409,
      "engine_in_use"
    );
  }
  if (!(await removePeerEngine(engineId))) {
    throw new ProjectError(`Unknown engine: ${engineId}`, 404, "engine_not_found");
  }
}

export async function listProjectPeerTokens(): Promise<ProjectPeerTokenSummary[]> {
  await assertProjectsEnabled();
  return listPeerTokens();
}

export async function mintProjectPeerToken(
  label: string
): Promise<{ token: ProjectPeerTokenSummary; secret: string }> {
  await assertProjectsEnabled();
  return mintPeerToken(label);
}

export async function revokeProjectPeerToken(tokenId: string): Promise<void> {
  await assertProjectsEnabled();
  if (!(await revokePeerToken(tokenId))) {
    throw new ProjectError(`Unknown peer token: ${tokenId}`, 404, "peer_token_not_found");
  }
  // No home can reach the Project context copies kept for this token any more.
  try {
    await closeMirrorFeed(tokenId).catch(() => undefined);
    const mirrors = getPeerMirrorsDir(tokenId);
    await fs.rm(mirrors, { recursive: true, force: true });
    forgetContextHashes(mirrors);
  } catch (error) {
    console.warn(
      `[projects] could not remove the context copies kept for peer token ${tokenId}:`,
      error instanceof Error ? error.message : error
    );
  }
}
