import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { readJsonFile, writeJsonFile } from "../persistence.js";
import {
  getProjectDir,
  getProjectRecordPath,
  getProjectsRootDir,
  isValidProjectId,
} from "./paths.js";
import {
  PROJECT_HOME_ENGINE_ID,
  isProjectAgentIsolation,
  type ProjectPullRequest,
  type ProjectRepoBinding,
  type ProjectSettings,
} from "@cesium/core/projects";
import {
  DEFAULT_PROJECT_SETTINGS,
  type ProjectChildRecord,
  type ProjectRecord,
} from "./types.js";

export type ProjectStoreEvent =
  | { type: "project"; project: ProjectRecord }
  | { type: "project_deleted"; projectId: string };

const emitter = new EventEmitter();
emitter.setMaxListeners(0);
const mutationQueues = new Map<string, Promise<unknown>>();

export function subscribeProjectStoreEvents(
  listener: (event: ProjectStoreEvent) => void
): () => void {
  emitter.on("event", listener);
  return () => {
    emitter.off("event", listener);
  };
}

function emit(event: ProjectStoreEvent): void {
  emitter.emit("event", event);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function normalizePullRequest(raw: unknown): ProjectPullRequest | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const pr = raw as Partial<ProjectPullRequest>;
  if (typeof pr.repo !== "string" || typeof pr.number !== "number" || typeof pr.url !== "string") {
    return null;
  }
  return {
    repo: pr.repo,
    number: pr.number,
    url: pr.url,
    title: typeof pr.title === "string" ? pr.title : `#${pr.number}`,
    state: pr.state === "merged" || pr.state === "closed" ? pr.state : "open",
    draft: pr.draft === true,
    headRef: typeof pr.headRef === "string" ? pr.headRef : "",
    baseRef: typeof pr.baseRef === "string" ? pr.baseRef : "",
    headSha: nullableString(pr.headSha),
    ci: pr.ci === "pending" || pr.ci === "success" || pr.ci === "failure" ? pr.ci : null,
    failedChecks: Array.isArray(pr.failedChecks)
      ? pr.failedChecks.filter((name): name is string => typeof name === "string")
      : [],
    review:
      pr.review === "approved" || pr.review === "changes_requested" || pr.review === "commented"
        ? pr.review
        : null,
    mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : null,
    openedByProject: pr.openedByProject === true,
    updatedAt: typeof pr.updatedAt === "number" ? pr.updatedAt : 0,
  };
}

export function normalizeProjectSettings(raw: unknown): ProjectSettings {
  const settings = (raw && typeof raw === "object" ? raw : {}) as Partial<ProjectSettings>;
  return {
    defaultChildBackendId: nullableString(settings.defaultChildBackendId),
    defaultChildModelId: nullableString(settings.defaultChildModelId),
    maxActiveChildren:
      typeof settings.maxActiveChildren === "number" && Number.isFinite(settings.maxActiveChildren)
        ? Math.min(32, Math.max(1, Math.floor(settings.maxActiveChildren)))
        : DEFAULT_PROJECT_SETTINGS.maxActiveChildren,
    mergePolicy: settings.mergePolicy === "when_green" ? "when_green" : "ask",
    prMode: settings.prMode === "draft" ? "draft" : "ready",
    autoCreatePr: settings.autoCreatePr !== false,
    autoSubscribe: settings.autoSubscribe !== false,
  };
}

function normalizeChildRecord(raw: unknown): ProjectChildRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const child = raw as Partial<ProjectChildRecord>;
  if (
    typeof child.id !== "string" ||
    typeof child.name !== "string" ||
    typeof child.workspaceId !== "string" ||
    typeof child.conversationId !== "string"
  ) {
    return null;
  }
  const repoId = typeof child.repoId === "string" ? child.repoId : null;
  return {
    id: child.id,
    name: child.name,
    engineId: typeof child.engineId === "string" ? child.engineId : PROJECT_HOME_ENGINE_ID,
    repoId,
    workspaceId: child.workspaceId,
    conversationId: child.conversationId,
    backendId: typeof child.backendId === "string" ? child.backendId : "cesium-agent",
    modelId: typeof child.modelId === "string" ? child.modelId : null,
    mode: typeof child.mode === "string" ? child.mode : "agent",
    createdBy: child.createdBy === "user" ? "user" : "orchestrator",
    createdAt: typeof child.createdAt === "number" ? child.createdAt : Date.now(),
    deletedAt: typeof child.deletedAt === "number" ? child.deletedAt : null,
    archivedAt: typeof child.archivedAt === "number" ? child.archivedAt : null,
    // Version-1 children ran in the bound repository itself (or a scratch folder).
    isolation: isProjectAgentIsolation(child.isolation)
      ? child.isolation
      : repoId
        ? "checkout"
        : "scratch",
    branch: nullableString(child.branch),
    baseRef: nullableString(child.baseRef),
    baseSha: nullableString(child.baseSha),
    worktreePath: nullableString(child.worktreePath),
    githubRepo: nullableString(child.githubRepo),
    pr: normalizePullRequest(child.pr),
    task: nullableString(child.task),
    lastStatus: typeof child.lastStatus === "string" ? child.lastStatus : "unknown",
    turnsCompleted: typeof child.turnsCompleted === "number" ? child.turnsCompleted : 0,
    lastReportedSeq: typeof child.lastReportedSeq === "number" ? child.lastReportedSeq : 0,
    suppressReports: child.suppressReports === true,
    suppressedThroughSeq:
      typeof child.suppressedThroughSeq === "number" ? child.suppressedThroughSeq : null,
    lastAttentionId: typeof child.lastAttentionId === "string" ? child.lastAttentionId : null,
    lastReplyPreview: typeof child.lastReplyPreview === "string" ? child.lastReplyPreview : null,
    lastSeenAt: typeof child.lastSeenAt === "number" ? child.lastSeenAt : null,
    lastError: typeof child.lastError === "string" ? child.lastError : null,
  };
}

function normalizeProjectRecord(raw: unknown): ProjectRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Partial<ProjectRecord>;
  if (typeof record.id !== "string" || !isValidProjectId(record.id) || !record.orchestrator) {
    return null;
  }
  return {
    schemaVersion: 2,
    id: record.id,
    name: typeof record.name === "string" && record.name.trim() ? record.name : "Project",
    icon: typeof record.icon === "string" ? record.icon : null,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
    archivedAt: typeof record.archivedAt === "number" ? record.archivedAt : null,
    orchestrator: record.orchestrator,
    repos: Array.isArray(record.repos)
      ? record.repos.map((repo: ProjectRepoBinding) => ({
          ...repo,
          baseBranch: nullableString(repo.baseBranch),
          githubRepo: nullableString(repo.githubRepo),
        }))
      : [],
    children: Array.isArray(record.children)
      ? record.children
          .map(normalizeChildRecord)
          .filter((child): child is ProjectChildRecord => child !== null)
      : [],
    settings: normalizeProjectSettings(record.settings),
  };
}

export async function readProject(projectId: string): Promise<ProjectRecord | null> {
  if (!isValidProjectId(projectId)) {
    return null;
  }
  return normalizeProjectRecord(await readJsonFile<unknown>(getProjectRecordPath(projectId), null));
}

export async function listProjectRecords(): Promise<ProjectRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(getProjectsRootDir());
  } catch {
    return [];
  }
  const records = await Promise.all(
    entries.filter(isValidProjectId).map((projectId) => readProject(projectId))
  );
  return records
    .filter((record): record is ProjectRecord => record !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Writes a brand-new record. The Project directory must already exist. */
export async function insertProject(record: ProjectRecord): Promise<ProjectRecord> {
  await writeJsonFile(getProjectRecordPath(record.id), record);
  emit({ type: "project", project: record });
  return record;
}

/**
 * Read-modify-write under a per-Project lock. `mutate` may return the same
 * object to skip the write, or throw to abort.
 */
export async function mutateProject(
  projectId: string,
  mutate: (current: ProjectRecord) => ProjectRecord | Promise<ProjectRecord>,
  options?: { touch?: boolean }
): Promise<ProjectRecord> {
  const previous = mutationQueues.get(projectId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const current = await readProject(projectId);
    if (!current) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    const mutated = await mutate(current);
    if (mutated === current) {
      return current;
    }
    const record: ProjectRecord = {
      ...mutated,
      updatedAt: options?.touch === false ? mutated.updatedAt : Date.now(),
    };
    await writeJsonFile(getProjectRecordPath(projectId), record);
    emit({ type: "project", project: record });
    return record;
  });
  mutationQueues.set(projectId, next);
  try {
    return await next;
  } finally {
    if (mutationQueues.get(projectId) === next) {
      mutationQueues.delete(projectId);
    }
  }
}

export async function removeProjectFiles(projectId: string): Promise<void> {
  await fs.rm(getProjectDir(projectId), { recursive: true, force: true });
  emit({ type: "project_deleted", projectId });
}
