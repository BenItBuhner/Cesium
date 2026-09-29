import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import {
  PROJECT_HOME_ENGINE_ID,
  isProjectChildBusy,
  normalizeProjectAgentName,
  projectChildBucket,
  projectEngineName,
  projectWorkerBranchName,
  sortProjectChildren,
  type ProjectAgentDelivery,
  type ProjectAgentIsolation,
  type ProjectChildSummary,
  type ProjectEngineListing,
  type ProjectEngineSummary,
  type ProjectHarnessInfo,
  type ProjectRepoBinding,
  type ProjectSettings,
  type ProjectSnapshot,
  type ProjectSummary,
} from "@cesium/core/projects";
import { listAgentBackendsWithCache } from "../agents/providers.js";
import { agentRuntimeManager } from "../agents/runtime-manager.js";
import {
  listWorkspaceConversationRecords,
  readConversationRecord,
  updateConversationRecord,
} from "../agents/session-store.js";
import type { AgentBackendId, AgentBackendInfo } from "../agents/types.js";
import { getCesiumAgentSettings } from "../cesium-agent-settings.js";
import { isEngineManagedWorkspace } from "../standalone-chat-paths.js";
import {
  ensureWorkspaceRegistered,
  getWorkspaceById,
  listWorkspaces,
  removeWorkspace,
} from "../workspace-registry.js";
import {
  LocalChildHost,
  MISSING_CHILD_OBSERVATION,
  TRANSCRIPT_DEFAULT_TURNS,
  TRANSCRIPT_MAX_TURNS,
  observeConversationRecord,
  type ChildHost,
  type ChildObservation,
  type ChildPlacement,
  type ChildRef,
} from "./child-host.js";
import { chooseChildModel, requireRunnableChildModel } from "./child-model.js";
import { seedProjectContext } from "./context-store.js";
import {
  callPeerEngine,
  homeEngineLabel,
  listEngineSummaries,
  listPeerEngines,
  resolveEngineRef,
} from "./engine-registry.js";
import { ProjectError } from "./errors.js";
import { assertProjectsEnabled } from "./feature-flag.js";
import { getProjectContextDir, getProjectDir } from "./paths.js";
import {
  insertProject,
  listProjectRecords,
  mutateProject,
  readProject,
  removeProjectFiles,
} from "./project-store.js";
import { PeerRequestError } from "./peer-client.js";
import { RemoteChildHost } from "./remote-child-host.js";
import type { WorkerBriefInput } from "./worker-brief.js";
import { isGithubRepoSlug } from "./github/repo-identity.js";
import { readProjectSubscriptions, summarizeSubscription } from "./subscriptions-store.js";
import { listPreferenceLines, readPreferences } from "./preferences.js";
import { inspectWorkerRepo } from "./worktrees.js";
import {
  DEFAULT_PROJECT_SETTINGS,
  type ProjectChildRecord,
  type ProjectRecord,
} from "./types.js";

export { ProjectError };

const ORCHESTRATOR_BACKEND_ID = "cesium-agent" as const;
const ENGINE_INFO_TIMEOUT_MS = 5_000;

const localHost = new LocalChildHost(PROJECT_HOME_ENGINE_ID);
const remoteHosts = new Map<string, RemoteChildHost>();

export function childHostFor(engineId: string): ChildHost {
  if (engineId === PROJECT_HOME_ENGINE_ID) {
    return localHost;
  }
  let remote = remoteHosts.get(engineId);
  if (!remote) {
    remote = new RemoteChildHost(engineId);
    remoteHosts.set(engineId, remote);
  }
  return remote;
}

export function childRef(child: Pick<ProjectChildRecord, "workspaceId" | "conversationId">): ChildRef {
  return { workspaceId: child.workspaceId, conversationId: child.conversationId };
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export async function requireProject(projectId: string): Promise<ProjectRecord> {
  await assertProjectsEnabled();
  const record = await readProject(projectId);
  if (!record) {
    throw new ProjectError(`Unknown project: ${projectId}`, 404, "project_not_found");
  }
  return record;
}

function engineLabel(engineId: string, engines: ProjectEngineSummary[]): string {
  return projectEngineName(engineId, engines);
}

async function observeChild(child: ProjectChildRecord): Promise<ChildObservation> {
  if (child.deletedAt != null) {
    return MISSING_CHILD_OBSERVATION;
  }
  try {
    return await childHostFor(child.engineId).observe(childRef(child));
  } catch {
    return MISSING_CHILD_OBSERVATION;
  }
}

export function summarizeChild(
  record: ProjectRecord,
  child: ProjectChildRecord,
  observation: ChildObservation,
  engines: ProjectEngineSummary[]
): ProjectChildSummary {
  const status =
    child.deletedAt != null
      ? child.lastStatus
      : observation.exists
        ? observation.status
        : "unknown";
  const repo = child.repoId ? record.repos.find((entry) => entry.id === child.repoId) : null;
  return {
    id: child.id,
    name: child.name,
    engineId: child.engineId,
    engineLabel: engineLabel(child.engineId, engines),
    repoId: child.repoId,
    repoName: repo?.name ?? null,
    workspaceId: child.workspaceId,
    conversationId: child.conversationId,
    backendId: observation.backendId ?? child.backendId,
    modelId: observation.modelId ?? child.modelId,
    modelName: observation.modelName,
    mode: observation.mode ?? child.mode,
    status,
    bucket: projectChildBucket({ status, deletedAt: child.deletedAt }),
    queued: observation.queued,
    turnsCompleted: child.turnsCompleted,
    lastReplyPreview: child.lastReplyPreview,
    lastError: observation.exists ? observation.lastError : child.lastError,
    attention: observation.attention
      ? { kind: observation.attention.kind, title: observation.attention.title }
      : null,
    createdBy: child.createdBy,
    createdAt: child.createdAt,
    updatedAt: observation.updatedAt,
    deletedAt: child.deletedAt,
    isolation: child.isolation,
    branch: child.branch,
    baseRef: child.baseRef,
    worktreePath: child.worktreePath,
    archivedAt: child.archivedAt,
    githubRepo: child.githubRepo,
    pr: child.pr,
    kind: child.kind,
    helperKind: child.helperKind,
  };
}

/** Children the Project counts as present: not deleted and not archived. */
export function isLiveProjectChild(child: Pick<ProjectChildRecord, "deletedAt" | "archivedAt">): boolean {
  return child.deletedAt == null && child.archivedAt == null;
}

export async function listProjectChildSummaries(
  record: ProjectRecord,
  options?: { includeDeleted?: boolean; includeArchived?: boolean }
): Promise<ProjectChildSummary[]> {
  const engines = await listEngineSummaries();
  const children = record.children.filter(
    (child) =>
      (options?.includeDeleted || child.deletedAt == null) &&
      (options?.includeArchived || options?.includeDeleted || child.archivedAt == null)
  );
  const observations = await Promise.all(children.map(observeChild));
  return sortProjectChildren(
    children.map((child, index) => summarizeChild(record, child, observations[index]!, engines))
  );
}

export async function buildProjectSnapshot(record: ProjectRecord): Promise<ProjectSnapshot> {
  const [orchestrator, children, subscriptions] = await Promise.all([
    readConversationRecord(record.orchestrator.workspaceId, record.orchestrator.conversationId),
    listProjectChildSummaries(record, { includeDeleted: true }),
    readProjectSubscriptions(record.id).catch(() => []),
  ]);
  return {
    id: record.id,
    name: record.name,
    icon: record.icon,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    archivedAt: record.archivedAt,
    contextRoot: getProjectContextDir(record.id),
    orchestrator: {
      conversationId: record.orchestrator.conversationId,
      workspaceId: record.orchestrator.workspaceId,
      status: orchestrator?.status ?? "unknown",
      modelId: orchestrator?.config.modelId ?? record.orchestrator.modelId,
      modelName: orchestrator?.config.modelName ?? null,
      queued: orchestrator?.queuedPrompts?.length ?? 0,
    },
    repos: record.repos,
    children,
    engines: await listEngineSummaries(),
    settings: record.settings,
    subscriptions: subscriptions
      .filter((entry) => entry.closedAt == null)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((entry) => summarizeSubscription(entry, record.children)),
  };
}

export async function getProjectSnapshot(projectId: string): Promise<ProjectSnapshot> {
  return buildProjectSnapshot(await requireProject(projectId));
}

export async function listProjects(): Promise<ProjectSummary[]> {
  await assertProjectsEnabled();
  const records = await listProjectRecords();
  return Promise.all(
    records.map(async (record) => {
      const orchestrator = await readConversationRecord(
        record.orchestrator.workspaceId,
        record.orchestrator.conversationId
      );
      const live = record.children.filter(isLiveProjectChild);
      return {
        id: record.id,
        name: record.name,
        icon: record.icon,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        archivedAt: record.archivedAt,
        orchestratorStatus: orchestrator?.status ?? "unknown",
        orchestratorConversationId: record.orchestrator.conversationId,
        orchestratorWorkspaceId: record.orchestrator.workspaceId,
        repoCount: record.repos.length,
        agentCount: live.length,
        workingCount: live.filter((child) => isProjectChildBusy(child.lastStatus)).length,
        attentionCount: live.filter(
          (child) =>
            child.lastStatus === "awaiting_permission" || child.lastStatus === "awaiting_question"
        ).length,
        turnsCompleted: record.children.reduce((sum, child) => sum + child.turnsCompleted, 0),
        engineLabel: homeEngineLabel(),
      } satisfies ProjectSummary;
    })
  );
}

export type ProjectRepoInput = {
  root?: string | null;
  workspaceId?: string | null;
  name?: string | null;
  engineId?: string | null;
};

type RepoWorkspace = { id: string; name: string; root: string };

async function resolveLocalRepoWorkspace(
  workspaceId: string | undefined,
  root: string | undefined
): Promise<RepoWorkspace> {
  let workspace = workspaceId ? await getWorkspaceById(workspaceId) : null;
  if (workspaceId && !workspace) {
    throw new ProjectError(`Unknown workspace: ${workspaceId}`);
  }
  if (!workspace) {
    if (!root) {
      throw new ProjectError("A repository needs a folder path or a workspace id.");
    }
    try {
      workspace = await ensureWorkspaceRegistered(root, undefined, { trackOpen: false });
    } catch (error) {
      throw new ProjectError(
        error instanceof Error ? error.message : `Cannot use ${root} as a repository.`
      );
    }
  }
  if (isEngineManagedWorkspace(workspace)) {
    throw new ProjectError("Chat sandboxes and Project folders cannot be added as repositories.");
  }
  return workspace;
}

/** The peer validates the folder (allowed roots, not engine-managed) and registers it. */
async function resolvePeerRepoWorkspace(
  engineId: string,
  workspaceId: string | undefined,
  root: string | undefined
): Promise<RepoWorkspace> {
  try {
    if (workspaceId) {
      const info = await callPeerEngine(engineId, (client) => client.info(ENGINE_INFO_TIMEOUT_MS));
      const workspace = info.workspaces.find((entry) => entry.id === workspaceId);
      if (!workspace) {
        throw new ProjectError(`Unknown workspace on engine ${info.label}: ${workspaceId}`);
      }
      return workspace;
    }
    if (!root) {
      throw new ProjectError("A repository needs a folder path or a workspace id.");
    }
    return await callPeerEngine(engineId, (client) => client.registerWorkspace(root));
  } catch (error) {
    if (error instanceof PeerRequestError && error.status >= 400 && error.status < 500) {
      throw new ProjectError(error.message, 400, error.code);
    }
    throw error;
  }
}

type ResolvedRepo = { engineId: string; workspace: RepoWorkspace; name: string | null };

async function resolveRepo(input: ProjectRepoInput): Promise<ResolvedRepo> {
  const engineId = await resolveEngineRef(input.engineId);
  const workspaceId = input.workspaceId?.trim() || undefined;
  const root = input.root?.trim() || undefined;
  const workspace =
    engineId === PROJECT_HOME_ENGINE_ID
      ? await resolveLocalRepoWorkspace(workspaceId, root)
      : await resolvePeerRepoWorkspace(engineId, workspaceId, root);
  return { engineId, workspace, name: input.name?.trim() || null };
}

function bindRepo(
  record: Pick<ProjectRecord, "repos">,
  { engineId, workspace, name: requestedName }: ResolvedRepo
): ProjectRepoBinding {
  if (record.repos.some((repo) => repo.engineId === engineId && repo.workspaceId === workspace.id)) {
    throw new ProjectError(`${workspace.name} is already part of this Project.`, 409);
  }
  const baseName = requestedName || workspace.name;
  let name = baseName;
  for (let suffix = 2; record.repos.some((repo) => repo.name.toLowerCase() === name.toLowerCase()); suffix += 1) {
    name = `${baseName}-${suffix}`;
  }
  return {
    id: `rep_${randomHex(4)}`,
    name,
    engineId,
    workspaceId: workspace.id,
    root: workspace.root,
  };
}

export type CreateProjectInput = {
  name: string;
  icon?: string | null;
  repos?: ProjectRepoInput[];
  prompt?: string | null;
  modelId?: string | null;
};

export async function createProject(input: CreateProjectInput): Promise<ProjectSnapshot> {
  await assertProjectsEnabled();
  const name = input.name?.trim();
  if (!name) {
    throw new ProjectError("Project name is required.");
  }
  const id = `prj_${randomHex(6)}`;
  const contextDir = getProjectContextDir(id);
  await seedProjectContext(id, name);
  let orchestratorWorkspaceId: string | null = null;
  let record: ProjectRecord;
  try {
    const repos: ProjectRepoBinding[] = [];
    for (const repoInput of input.repos ?? []) {
      repos.push(bindRepo({ repos }, await resolveRepo(repoInput)));
    }
    const workspace = await ensureWorkspaceRegistered(contextDir, name, { trackOpen: false });
    orchestratorWorkspaceId = workspace.id;
    const modelId = input.modelId?.trim() || undefined;
    const now = Date.now();
    const conversation = await agentRuntimeManager.createConversation(workspace, {
      backendId: ORCHESTRATOR_BACKEND_ID,
      mode: "agent",
      title: name,
      ...(modelId ? { modelId } : {}),
      origin: { kind: "project-orchestrator", projectId: id, createdAt: now },
    });
    record = {
      schemaVersion: 2,
      id,
      name,
      icon: input.icon?.trim() || null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      orchestrator: {
        conversationId: conversation.id,
        workspaceId: workspace.id,
        backendId: ORCHESTRATOR_BACKEND_ID,
        modelId: conversation.config.modelId || null,
      },
      repos,
      children: [],
      settings: { ...DEFAULT_PROJECT_SETTINGS },
    };
    await insertProject(record);
  } catch (error) {
    if (orchestratorWorkspaceId) {
      await removeWorkspace(orchestratorWorkspaceId).catch(() => undefined);
    }
    await fs.rm(getProjectDir(id), { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  const prompt = input.prompt?.trim();
  if (prompt) {
    const workspace = await getWorkspaceById(record.orchestrator.workspaceId);
    if (workspace) {
      await agentRuntimeManager.promptConversation(
        workspace,
        record.orchestrator.conversationId,
        prompt
      );
    }
  }
  return buildProjectSnapshot((await readProject(id)) ?? record);
}

export type PatchProjectInput = {
  name?: string | null;
  icon?: string | null;
  archived?: boolean;
  settings?: Partial<ProjectSettings>;
};

function normalizeSettingsPatch(
  current: ProjectSettings,
  patch: Partial<ProjectSettings>
): ProjectSettings {
  const next = { ...current };
  if (patch.defaultChildBackendId !== undefined) {
    next.defaultChildBackendId = patch.defaultChildBackendId?.trim() || null;
  }
  if (patch.defaultChildModelId !== undefined) {
    next.defaultChildModelId = patch.defaultChildModelId?.trim() || null;
  }
  if (typeof patch.maxActiveChildren === "number" && Number.isFinite(patch.maxActiveChildren)) {
    next.maxActiveChildren = Math.min(32, Math.max(1, Math.floor(patch.maxActiveChildren)));
  }
  if (patch.mergePolicy === "ask" || patch.mergePolicy === "when_green") {
    next.mergePolicy = patch.mergePolicy;
  }
  if (patch.prMode === "ready" || patch.prMode === "draft") {
    next.prMode = patch.prMode;
  }
  if (typeof patch.autoCreatePr === "boolean") {
    next.autoCreatePr = patch.autoCreatePr;
  }
  if (typeof patch.autoSubscribe === "boolean") {
    next.autoSubscribe = patch.autoSubscribe;
  }
  if (typeof patch.autoApproveAgents === "boolean") {
    next.autoApproveAgents = patch.autoApproveAgents;
  }
  return next;
}

export async function patchProject(
  projectId: string,
  patch: PatchProjectInput
): Promise<ProjectSnapshot> {
  const current = await requireProject(projectId);
  const nextName = patch.name?.trim();
  if (patch.name !== undefined && !nextName) {
    throw new ProjectError("Project name cannot be empty.");
  }
  const record = await mutateProject(projectId, (existing) => ({
    ...existing,
    ...(nextName ? { name: nextName } : {}),
    ...(patch.icon !== undefined ? { icon: patch.icon?.trim() || null } : {}),
    ...(patch.archived === true && existing.archivedAt == null ? { archivedAt: Date.now() } : {}),
    ...(patch.archived === false ? { archivedAt: null } : {}),
    ...(patch.settings ? { settings: normalizeSettingsPatch(existing.settings, patch.settings) } : {}),
  }));
  if (nextName && nextName !== current.name) {
    const workspace = await getWorkspaceById(record.orchestrator.workspaceId);
    if (workspace) {
      await agentRuntimeManager
        .updateConversationConfig(workspace, record.orchestrator.conversationId, { title: nextName })
        .catch(() => undefined);
    }
  }
  return buildProjectSnapshot(record);
}

export async function disposeChildResources(
  child: ProjectChildRecord,
  siblings: readonly ProjectChildRecord[] = []
): Promise<void> {
  if (child.deletedAt != null) {
    return;
  }
  // Never remove a folder another live agent in this Project still works in.
  const shared = siblings.some(
    (other) =>
      other.id !== child.id &&
      other.deletedAt == null &&
      other.engineId === child.engineId &&
      other.workspaceId === child.workspaceId
  );
  await childHostFor(child.engineId)
    .delete(childRef(child), { keepWorkspace: shared })
    .catch((error) => {
      console.warn(
        `[projects] could not delete child ${child.name}:`,
        error instanceof Error ? error.message : error
      );
    });
}

/** Deletes the Project, its orchestrator chat and every child it created. */
export async function deleteProject(projectId: string): Promise<void> {
  const record = await requireProject(projectId);
  const marked = await mutateProject(projectId, (existing) => ({
    ...existing,
    children: existing.children.map((child) => ({
      ...child,
      suppressReports: true,
    })),
  }));
  // Helpers first: they may share a worker's folder that the worker's deletion removes.
  const ordered = [...marked.children].sort((a, b) => Number(b.kind === "helper") - Number(a.kind === "helper"));
  for (const [index, child] of ordered.entries()) {
    await disposeChildResources(child, ordered.slice(index + 1));
  }
  const { dropProjectContextMirrors } = await import("./context-sync.js");
  await dropProjectContextMirrors(
    projectId,
    marked.children.map((child) => child.engineId)
  );
  const workspace = await getWorkspaceById(record.orchestrator.workspaceId);
  if (workspace) {
    await agentRuntimeManager
      .deleteConversation(workspace, record.orchestrator.conversationId)
      .catch(() => undefined);
    await removeWorkspace(workspace.id).catch(() => undefined);
  }
  await removeProjectFiles(projectId);
}

export async function addProjectRepo(
  projectId: string,
  input: ProjectRepoInput
): Promise<ProjectSnapshot> {
  await requireProject(projectId);
  const resolved = await resolveRepo(input);
  const record = await mutateProject(projectId, (existing) => ({
    ...existing,
    repos: [...existing.repos, bindRepo(existing, resolved)],
  }));
  return buildProjectSnapshot(record);
}

export type PatchProjectRepoInput = {
  baseBranch?: string | null;
  githubRepo?: string | null;
};

/** Sets a repository's base branch (what workers start from) and its GitHub `owner/repo`. */
export async function updateProjectRepo(
  projectId: string,
  repoId: string,
  patch: PatchProjectRepoInput
): Promise<ProjectSnapshot> {
  await requireProject(projectId);
  if (patch.baseBranch && !BASE_BRANCH_PATTERN.test(patch.baseBranch.trim())) {
    throw new ProjectError(`"${patch.baseBranch}" is not a branch name.`);
  }
  if (patch.githubRepo && !isGithubRepoSlug(patch.githubRepo.trim())) {
    throw new ProjectError(`"${patch.githubRepo}" is not a GitHub owner/repo.`);
  }
  const record = await mutateProject(projectId, (existing) => {
    if (!existing.repos.some((repo) => repo.id === repoId)) {
      throw new ProjectError(`Unknown repository: ${repoId}`, 404);
    }
    return {
      ...existing,
      repos: existing.repos.map((repo) =>
        repo.id === repoId
          ? {
              ...repo,
              ...(patch.baseBranch !== undefined ? { baseBranch: patch.baseBranch?.trim() || null } : {}),
              ...(patch.githubRepo !== undefined ? { githubRepo: patch.githubRepo?.trim() || null } : {}),
            }
          : repo
      ),
      // Workers on this repo push to the same place.
      children:
        patch.githubRepo !== undefined
          ? existing.children.map((child) =>
              child.repoId === repoId
                ? { ...child, githubRepo: patch.githubRepo?.trim() || child.githubRepo }
                : child
            )
          : existing.children,
    };
  });
  return buildProjectSnapshot(record);
}

export async function removeProjectRepo(
  projectId: string,
  repoId: string
): Promise<ProjectSnapshot> {
  await requireProject(projectId);
  const record = await mutateProject(projectId, (existing) => {
    if (!existing.repos.some((repo) => repo.id === repoId)) {
      throw new ProjectError(`Unknown repository: ${repoId}`, 404);
    }
    return { ...existing, repos: existing.repos.filter((repo) => repo.id !== repoId) };
  });
  return buildProjectSnapshot(record);
}

/** Finds a child by id or (case-insensitive) name; live children win over deleted ones. */
export function resolveProjectChild(
  record: ProjectRecord,
  agentRef: string,
  options?: { includeDeleted?: boolean }
): ProjectChildRecord {
  const ref = agentRef?.trim() ?? "";
  if (!ref) {
    throw new ProjectError("Which agent? Pass its name or id.");
  }
  const lowered = ref.toLowerCase();
  const normalized = normalizeProjectAgentName(ref);
  const matches = (child: ProjectChildRecord) =>
    child.id === ref ||
    child.name.toLowerCase() === lowered ||
    (normalized !== "" && child.name === normalized);
  const live = record.children.find((child) => child.deletedAt == null && matches(child));
  if (live) {
    return live;
  }
  const deleted = record.children.find((child) => child.deletedAt != null && matches(child));
  if (deleted && options?.includeDeleted) {
    return deleted;
  }
  if (deleted) {
    throw new ProjectError(`Agent "${deleted.name}" was deleted.`, 404, "agent_deleted");
  }
  const known = record.children
    .filter((child) => child.deletedAt == null)
    .map((child) => child.name);
  throw new ProjectError(
    known.length > 0
      ? `No agent named "${ref}". Agents: ${known.join(", ")}.`
      : `No agent named "${ref}". This Project has no agents yet.`,
    404,
    "agent_not_found"
  );
}

/**
 * Copies the Project context to a peer before an agent starts there. An
 * engine without context sync (or one that fails it) just gets no copy; the
 * agent is told so.
 */
export async function syncContextToPeer(projectId: string, engineId: string): Promise<boolean> {
  try {
    const { syncProjectContextWithPeer } = await import("./context-sync.js");
    await syncProjectContextWithPeer(projectId, engineId);
    return true;
  } catch (error) {
    console.warn(
      `[projects] could not copy the context of ${projectId} to engine ${engineId}:`,
      error instanceof Error ? error.message : error
    );
    return false;
  }
}

/** Names of children being created right now; the record lists a child only once it has started. */
const claimedChildNames = new Map<string, Set<string>>();

/**
 * A name no agent of the Project has had, deleted ones included: names key
 * evidence folders (media/<name>/), explorer notes and the coordinator's
 * update history, so they are never reused.
 */
function uniqueChildName(record: ProjectRecord, base: string): string {
  const taken = new Set(record.children.map((child) => child.name));
  for (const claimed of claimedChildNames.get(record.id) ?? []) {
    taken.add(claimed);
  }
  let name = base;
  for (let suffix = 2; taken.has(name); suffix += 1) {
    name = `${base.slice(0, 44)}-${suffix}`;
  }
  return name;
}

export type ChildNameClaim = { name: string; release: () => void };

/**
 * Claims a unique name for a child about to be created, against the latest
 * record, so creations that overlap (the coordinator and the UI, a batch of
 * explorers) never pick the same one. Release it once the child is in the
 * record, or the creation failed.
 */
export async function claimChildName(projectId: string, base: string): Promise<ChildNameClaim> {
  let name = base;
  await mutateProject(projectId, (current) => {
    name = uniqueChildName(current, base);
    const claimed = claimedChildNames.get(projectId) ?? new Set<string>();
    claimed.add(name);
    claimedChildNames.set(projectId, claimed);
    return current;
  });
  let released = false;
  return {
    name,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      const claimed = claimedChildNames.get(projectId);
      claimed?.delete(name);
      if (claimed?.size === 0) {
        claimedChildNames.delete(projectId);
      }
    },
  };
}

/** A harness counts as available only when it is installed and has credentials. */
export async function resolveHarness(
  requested: string | null | undefined,
  fallback: string | null,
  engine: string = homeEngineLabel()
): Promise<AgentBackendInfo> {
  const backends = await listAgentBackendsWithCache();
  const wanted = (requested?.trim() || fallback || ORCHESTRATOR_BACKEND_ID).toLowerCase();
  const backend =
    backends.find((entry) => entry.id === wanted) ??
    backends.find((entry) => entry.label.toLowerCase() === wanted);
  const usable = backends.filter((entry) => entry.available).map((entry) => entry.id);
  const usableList = `Harnesses available on ${engine}: ${usable.join(", ") || "none"}.`;
  if (!backend) {
    throw new ProjectError(`Unknown harness "${requested?.trim() || wanted}". ${usableList}`);
  }
  if (!backend.available) {
    throw new ProjectError(
      `${backend.label} (${backend.id}) cannot run on ${engine}: it is not installed or has no credentials there. ${usableList}`,
      400,
      "harness_unavailable"
    );
  }
  return backend;
}

/**
 * The Project default model belongs to the default harness on the home engine
 * (it names a provider configured there), so another harness or a peer engine
 * falls back to its own default unless a model is requested explicitly.
 */
export function resolveChildModelId(input: {
  requested: string | null | undefined;
  isHome: boolean;
  harness: string;
  settings: Pick<ProjectRecord["settings"], "defaultChildBackendId" | "defaultChildModelId">;
}): string | null {
  const requested = input.requested?.trim();
  if (requested) {
    return requested;
  }
  const defaultHarness = input.settings.defaultChildBackendId || ORCHESTRATOR_BACKEND_ID;
  return input.isHome && input.harness === defaultHarness ? input.settings.defaultChildModelId : null;
}

export type CreateChildInput = {
  name: string;
  instructions: string;
  repo?: string | null;
  engine?: string | null;
  harness?: string | null;
  model?: string | null;
  mode?: string | null;
  /** Default: `worktree` with a repository, else `scratch`. */
  isolation?: ProjectAgentIsolation | null;
  /** Branch a worktree starts from; default: the repo binding's base, else the remote default. */
  base?: string | null;
};

const BASE_BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;
const CHILD_TASK_MAX_CHARS = 2_000;

/** Where a new child goes, from its repo and requested isolation. */
function childPlacement(input: {
  record: ProjectRecord;
  repo: ProjectRepoBinding | null;
  name: string;
  isolation: ProjectAgentIsolation | null;
  base: string | null;
}): ChildPlacement {
  const { record, repo, name } = input;
  if (input.base && !BASE_BRANCH_PATTERN.test(input.base)) {
    throw new ProjectError(`"${input.base}" is not a branch name.`);
  }
  if (!repo) {
    if (input.isolation === "worktree" || input.isolation === "checkout") {
      throw new ProjectError(`isolation "${input.isolation}" needs a repository; pass repo.`);
    }
    return { kind: "scratch", label: `${record.name} · ${name}` };
  }
  switch (input.isolation) {
    case "checkout":
      return { kind: "workspace", workspaceId: repo.workspaceId };
    case "scratch":
      return { kind: "scratch", label: `${record.name} · ${name}` };
    default:
      return {
        kind: "worktree",
        workspaceId: repo.workspaceId,
        branch: projectWorkerBranchName(record.name, name, randomHex(2)),
        baseBranch: input.base || repo.baseBranch || null,
        // Only an explicit request insists on a worktree; the default adapts to plain folders.
        fallbackToCheckout: input.isolation !== "worktree",
      };
  }
}

export type CreatedProjectChild = {
  agent: ProjectChildSummary;
  /** Set when the agent could not start on the requested or default model. */
  warning: string | null;
};

export async function createProjectChild(
  projectId: string,
  input: CreateChildInput,
  createdBy: "orchestrator" | "user"
): Promise<CreatedProjectChild> {
  const record = await requireProject(projectId);
  const baseName = normalizeProjectAgentName(input.name ?? "");
  if (!baseName) {
    throw new ProjectError("Agent name is required (letters, digits and dashes).");
  }
  const instructions = input.instructions?.trim();
  if (!instructions) {
    throw new ProjectError("Agent instructions are required.");
  }
  const busy = record.children.filter(
    (child) => child.deletedAt == null && isProjectChildBusy(child.lastStatus)
  ).length;
  if (busy >= record.settings.maxActiveChildren) {
    throw new ProjectError(
      `This Project already has ${busy} working agents (limit ${record.settings.maxActiveChildren}). Wait for one to finish, stop one, or queue work to an existing agent.`,
      409
    );
  }
  const repoRef = input.repo?.trim();
  const repo = repoRef
    ? record.repos.find(
        (entry) => entry.id === repoRef || entry.name.toLowerCase() === repoRef.toLowerCase()
      )
    : null;
  if (repoRef && !repo) {
    throw new ProjectError(
      `Unknown repository "${repoRef}". Repositories: ${record.repos.map((entry) => entry.name).join(", ") || "none"}.`
    );
  }
  const requestedEngine = input.engine?.trim() ? await resolveEngineRef(input.engine) : null;
  if (repo && requestedEngine && requestedEngine !== repo.engineId) {
    const engines = await listEngineSummaries();
    throw new ProjectError(
      `Repository ${repo.name} lives on engine "${engineLabel(repo.engineId, engines)}", not "${engineLabel(requestedEngine, engines)}".`
    );
  }
  const engineId = repo?.engineId ?? requestedEngine ?? PROJECT_HOME_ENGINE_ID;
  const isHome = engineId === PROJECT_HOME_ENGINE_ID;
  const host = childHostFor(engineId);
  const hostLabel = engineLabel(engineId, await listEngineSummaries());
  // A peer validates the harness and model itself against its own credentials.
  const harness = isHome
    ? (await resolveHarness(input.harness, record.settings.defaultChildBackendId)).id
    : input.harness?.trim() || record.settings.defaultChildBackendId || ORCHESTRATOR_BACKEND_ID;
  const model = isHome
    ? await chooseChildModel({
        harness,
        requested: input.model,
        fallback: resolveChildModelId({ requested: null, isHome, harness, settings: record.settings }),
        engineLabel: hostLabel,
      })
    : {
        modelId: resolveChildModelId({ requested: input.model, isHome, harness, settings: record.settings }),
        warning: null,
      };
  const claim = await claimChildName(projectId, baseName);
  try {
    const { name } = claim;
    const childId = `pca_${randomHex(6)}`;
    const placement = childPlacement({
      record,
      repo: repo ?? null,
      name,
      isolation: input.isolation ?? null,
      base: input.base?.trim() || null,
    });
    const brief: WorkerBriefInput = {
      projectName: record.name,
      agentName: name,
      instructions,
      repoName: repo?.name ?? null,
      contextDir: isHome ? getProjectContextDir(record.id) : null,
      contextEngine: homeEngineLabel(),
      preferences: listPreferenceLines(await readPreferences()),
    };
    await seedProjectContext(record.id, record.name);
    if (!isHome) {
      brief.contextSync = await syncContextToPeer(record.id, engineId);
    }
    const created = await host.create({
      projectId,
      childId,
      name,
      brief,
      displayText: instructions,
      placement,
      backendId: harness as AgentBackendId,
      modelId: model.modelId,
      mode: input.mode?.trim() || null,
      homeLabel: homeEngineLabel(),
      engineLabel: hostLabel,
      autoApprove: record.settings.autoApproveAgents,
    });
    const child: ProjectChildRecord = {
      id: childId,
      name,
      engineId,
      repoId: repo?.id ?? null,
      workspaceId: created.workspaceId,
      conversationId: created.conversationId,
      backendId: created.backendId,
      modelId: created.modelId,
      mode: created.mode,
      createdBy,
      createdAt: Date.now(),
      deletedAt: null,
      archivedAt: null,
      isolation: created.isolation ?? (placement.kind === "scratch" ? "scratch" : "checkout"),
      branch: created.branch ?? null,
      baseRef: created.baseRef ?? null,
      baseSha: created.baseSha ?? null,
      worktreePath: created.worktreePath ?? null,
      githubRepo: repo?.githubRepo ?? created.githubRepo ?? null,
      pr: null,
      task: instructions.slice(0, CHILD_TASK_MAX_CHARS),
      kind: "worker",
      helperKind: null,
      lastStatus: "running",
      turnsCompleted: 0,
      lastReportedSeq: 0,
      suppressReports: false,
      suppressedThroughSeq: null,
      lastAttentionId: null,
      lastReplyPreview: null,
      lastSeenAt: Date.now(),
      lastError: null,
    };
    const updated = await mutateProject(projectId, (existing) => ({
      ...existing,
      children: [...existing.children, child],
    }));
    const { observeNewProjectChild } = await import("./project-watcher.js");
    observeNewProjectChild(projectId, childId);
    const warnings = [model.warning ?? created.modelWarning ?? null, created.placementWarning ?? null].filter(
      (entry): entry is string => Boolean(entry)
    );
    return {
      agent: summarizeChild(updated, child, await observeChild(child), await listEngineSummaries()),
      warning: warnings.length > 0 ? warnings.join(" ") : null,
    };
  } finally {
    claim.release();
  }
}

/**
 * Archives a child: stops its turn and hides it from the Project's lists and
 * the orchestrator's roster. Its conversation, worktree and branch stay, and
 * unarchiving brings it back as it was.
 */
export async function setProjectChildArchived(
  projectId: string,
  agentRef: string,
  archived: boolean
): Promise<ProjectChildSummary> {
  const record = await requireProject(projectId);
  const child = resolveProjectChild(record, agentRef);
  if (archived && child.archivedAt == null) {
    const observation = await observeChild(child);
    if (observation.exists && (isProjectChildBusy(observation.status) || observation.queued > 0)) {
      await stopProjectChild(projectId, child.id);
    }
  }
  const updated = await patchChild(projectId, child.id, (current) => {
    if (archived) {
      return current.archivedAt == null ? { archivedAt: Date.now() } : null;
    }
    return current.archivedAt != null ? { archivedAt: null } : null;
  });
  const next = updated.children.find((entry) => entry.id === child.id) ?? child;
  return summarizeChild(updated, next, await observeChild(next), await listEngineSummaries());
}

export type AdoptChildInput = {
  /** Conversation id on this engine, or its exact title. */
  conversation: string;
  name?: string | null;
};

/**
 * Brings an existing chat on this engine into the Project as a worker: it
 * keeps its workspace (checkout isolation, or scratch for a standalone chat),
 * reports its turns to the orchestrator from now on, and the orchestrator is
 * told it was adopted.
 */
export async function adoptProjectChild(
  projectId: string,
  input: AdoptChildInput
): Promise<ProjectChildSummary> {
  const record = await requireProject(projectId);
  const ref = input.conversation?.trim();
  if (!ref) {
    throw new ProjectError("Which conversation? Pass its id or exact title.");
  }
  const target = await findAdoptableConversation(ref);
  if (!target) {
    throw new ProjectError(`No conversation "${ref}" on this engine.`, 404, "conversation_not_found");
  }
  const { workspace, conversation } = target;
  if (conversation.origin?.kind === "project-orchestrator" || conversation.origin?.kind === "project-child") {
    throw new ProjectError(`"${conversation.title}" already belongs to a Project.`, 409);
  }
  const baseName = normalizeProjectAgentName(input.name?.trim() || conversation.title) || "adopted";
  const repo =
    record.repos.find(
      (entry) => entry.engineId === PROJECT_HOME_ENGINE_ID && entry.workspaceId === workspace.id
    ) ?? null;
  const githubRepo = repo?.githubRepo ?? (await inspectWorkerRepo(workspace.root)).githubRepo;
  const claim = await claimChildName(projectId, baseName);
  const { name } = claim;
  const childId = `pca_${randomHex(6)}`;
  let child: ProjectChildRecord;
  let observation: ReturnType<typeof observeConversationRecord>;
  let updated: ProjectRecord;
  try {
    const adopted = await updateConversationRecord(workspace.id, conversation.id, (current) => ({
      ...current,
      origin: {
        kind: "project-child",
        projectId: record.id,
        childId,
        peerTokenId: null,
        createdAt: Date.now(),
      },
    }));
    observation = observeConversationRecord(adopted);
    child = {
      id: childId,
      name,
      engineId: PROJECT_HOME_ENGINE_ID,
      repoId: repo?.id ?? null,
      workspaceId: workspace.id,
      conversationId: conversation.id,
      backendId: adopted.config.backendId,
      modelId: adopted.config.modelId || null,
      mode: adopted.config.mode,
      createdBy: "user",
      createdAt: Date.now(),
      deletedAt: null,
      archivedAt: null,
      isolation: isEngineManagedWorkspace(workspace) ? "scratch" : "checkout",
      branch: null,
      baseRef: null,
      baseSha: null,
      worktreePath: null,
      githubRepo,
      pr: null,
      task: null,
      kind: "worker",
      helperKind: null,
      lastStatus: observation.status,
      turnsCompleted: 0,
      // Only turns after the adoption are reported.
      lastReportedSeq: adopted.lastEventSeq,
      suppressReports: false,
      suppressedThroughSeq: null,
      lastAttentionId: observation.attention?.id ?? null,
      lastReplyPreview: null,
      lastSeenAt: Date.now(),
      lastError: adopted.lastError,
    };
    const entry = child;
    updated = await mutateProject(projectId, (existing) => ({
      ...existing,
      children: [...existing.children, entry],
    }));
  } finally {
    claim.release();
  }
  const { deliverProjectNotice } = await import("./project-watcher.js");
  await deliverProjectNotice(updated, [
    {
      name,
      event: "adopted",
      status: observation.status,
      detail: `The user added their conversation "${conversation.title}" to this Project as agent ${name} (${child.isolation === "checkout" ? `working in ${workspace.name}` : "in a scratch folder"}). Its future turns report here like any other agent's.`,
    },
  ]);
  return summarizeChild(updated, child, observation, await listEngineSummaries());
}

const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

async function findAdoptableConversation(ref: string) {
  const workspaces = await listWorkspaces();
  if (CONVERSATION_ID_PATTERN.test(ref)) {
    for (const workspace of workspaces) {
      const direct = await readConversationRecord(workspace.id, ref).catch(() => null);
      if (direct) {
        return { workspace, conversation: direct };
      }
    }
  }
  const lowered = ref.toLowerCase();
  for (const workspace of workspaces) {
    const records = await listWorkspaceConversationRecords(workspace.id).catch(() => []);
    const match = records.find((record) => record.title.trim().toLowerCase() === lowered);
    if (match) {
      return { workspace, conversation: match };
    }
  }
  return null;
}

export async function listProjectChildren(
  projectId: string,
  options?: { includeDeleted?: boolean; includeArchived?: boolean }
): Promise<ProjectChildSummary[]> {
  return listProjectChildSummaries(await requireProject(projectId), options);
}

export async function getProjectChild(
  projectId: string,
  agentRef: string
): Promise<ProjectChildSummary> {
  const record = await requireProject(projectId);
  const child = resolveProjectChild(record, agentRef, { includeDeleted: true });
  return summarizeChild(record, child, await observeChild(child), await listEngineSummaries());
}

export async function patchChild(
  projectId: string,
  childId: string,
  patch: (child: ProjectChildRecord) => Partial<ProjectChildRecord> | null
): Promise<ProjectRecord> {
  return mutateProject(
    projectId,
    (existing) => {
      let changed = false;
      const children = existing.children.map((child) => {
        if (child.id !== childId) {
          return child;
        }
        const next = patch(child);
        if (!next) {
          return child;
        }
        changed = true;
        return { ...child, ...next };
      });
      return changed ? { ...existing, children } : existing;
    },
    { touch: false }
  );
}

export async function messageProjectChild(
  projectId: string,
  agentRef: string,
  text: string,
  delivery: "steer" | "queue"
): Promise<{ agent: string; delivery: ProjectAgentDelivery }> {
  const record = await requireProject(projectId);
  const child = resolveProjectChild(record, agentRef);
  const message = text?.trim();
  if (!message) {
    throw new ProjectError("Message text is required.");
  }
  if (child.suppressReports) {
    await patchChild(projectId, child.id, () => ({
      suppressReports: false,
      suppressedThroughSeq: null,
    }));
  }
  const outcome = await childHostFor(child.engineId).message(childRef(child), message, delivery);
  return { agent: child.name, delivery: outcome };
}

export async function stopProjectChild(
  projectId: string,
  agentRef: string
): Promise<{ agent: string; stopped: boolean; status: string }> {
  const record = await requireProject(projectId);
  const child = resolveProjectChild(record, agentRef);
  const host = childHostFor(child.engineId);
  const before = await host.observe(childRef(child));
  if (!before.exists) {
    throw new ProjectError(`Agent "${child.name}" has no conversation on its engine anymore.`, 404);
  }
  const busy = isProjectChildBusy(before.status);
  if (!busy && before.queued === 0) {
    return { agent: child.name, stopped: false, status: before.status };
  }
  if (busy) {
    await patchChild(projectId, child.id, () => ({
      suppressReports: true,
      suppressedThroughSeq: null,
    }));
  }
  await host.stop(childRef(child));
  const after = await host.observe(childRef(child));
  if (busy) {
    await patchChild(projectId, child.id, (current) =>
      current.suppressReports ? { suppressedThroughSeq: after.lastEventSeq } : null
    );
  }
  return { agent: child.name, stopped: true, status: after.status };
}

export type UpdateChildInput = {
  name?: string | null;
  model?: string | null;
  mode?: string | null;
};

export async function updateProjectChild(
  projectId: string,
  agentRef: string,
  input: UpdateChildInput
): Promise<ProjectChildSummary> {
  const record = await requireProject(projectId);
  const child = resolveProjectChild(record, agentRef);
  const requestedName = input.name != null ? normalizeProjectAgentName(input.name) : null;
  if (input.name != null && !requestedName) {
    throw new ProjectError("Agent name must contain letters or digits.");
  }
  const requestedModel = input.model?.trim() || undefined;
  const mode = input.mode?.trim() || undefined;
  const rename = requestedName && requestedName !== child.name ? requestedName : null;
  if (!rename && !requestedModel && !mode) {
    throw new ProjectError("Nothing to update: pass name, model or mode.");
  }
  const claim = rename ? await claimChildName(projectId, rename) : null;
  try {
    return await applyChildUpdate(projectId, child, { name: claim?.name ?? null, model: requestedModel, mode });
  } finally {
    claim?.release();
  }
}

async function applyChildUpdate(
  projectId: string,
  child: ProjectChildRecord,
  input: { name: string | null; model: string | undefined; mode: string | undefined }
): Promise<ProjectChildSummary> {
  const { name: nextName, model: requestedModel, mode } = input;
  const isHome = child.engineId === PROJECT_HOME_ENGINE_ID;
  const hostLabel = engineLabel(child.engineId, await listEngineSummaries());
  // A peer checks the model against its own credentials.
  const model =
    requestedModel && isHome
      ? await requireRunnableChildModel({
          harness: child.backendId,
          requested: requestedModel,
          engineLabel: hostLabel,
        })
      : requestedModel;
  await childHostFor(child.engineId).update(childRef(child), {
    ...(nextName ? { title: nextName } : {}),
    ...(model ? { modelId: model, engineLabel: hostLabel } : {}),
    ...(mode ? { mode } : {}),
  });
  const updated = await patchChild(projectId, child.id, () => ({
    ...(nextName ? { name: nextName } : {}),
    ...(model ? { modelId: model } : {}),
    ...(mode ? { mode } : {}),
  }));
  const next = updated.children.find((entry) => entry.id === child.id) ?? child;
  return summarizeChild(updated, next, await observeChild(next), await listEngineSummaries());
}

export async function deleteProjectChild(
  projectId: string,
  agentRef: string
): Promise<{ agent: string; deleted: true }> {
  const record = await requireProject(projectId);
  const child = resolveProjectChild(record, agentRef);
  const observation = await observeChild(child);
  await patchChild(projectId, child.id, () => ({
    deletedAt: Date.now(),
    suppressReports: true,
    lastStatus: observation.exists ? observation.status : child.lastStatus,
  }));
  await disposeChildResources(child, record.children);
  return { agent: child.name, deleted: true };
}

export function clampTranscriptTurns(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    return TRANSCRIPT_DEFAULT_TURNS;
  }
  return Math.min(TRANSCRIPT_MAX_TURNS, Math.max(1, Math.floor(value)));
}

export async function readProjectChildTranscript(
  projectId: string,
  agentRef: string,
  turns?: unknown
): Promise<{ agent: string; status: string; transcript: string }> {
  const record = await requireProject(projectId);
  const child = resolveProjectChild(record, agentRef);
  const host = childHostFor(child.engineId);
  const [observation, transcript] = await Promise.all([
    host.observe(childRef(child)),
    host.transcript(childRef(child), clampTranscriptTurns(turns ?? TRANSCRIPT_DEFAULT_TURNS)),
  ]);
  return { agent: child.name, status: observation.status, transcript };
}

/**
 * This engine's harnesses. The Cesium Agent's default model lives in its settings
 * (env bootstrap or the user's pick), not in the static registry entry.
 */
export async function listHomeHarnesses(): Promise<ProjectHarnessInfo[]> {
  const [backends, cesiumDefaultModelId] = await Promise.all([
    listAgentBackendsWithCache(),
    getCesiumAgentSettings()
      .then((settings) => settings.defaultModelId)
      .catch(() => null),
  ]);
  return backends.map((backend) => ({
    id: backend.id,
    label: backend.label,
    available: backend.available,
    defaultModelId:
      backend.id === ORCHESTRATOR_BACKEND_ID && cesiumDefaultModelId
        ? cesiumDefaultModelId
        : backend.defaultModelId,
  }));
}

/**
 * Every engine with its bound repos, the harnesses it can run right now and its
 * bindable workspaces (asks each peer); `null` lists them before a Project exists.
 */
export async function listProjectEngines(projectId: string | null): Promise<ProjectEngineListing[]> {
  const record = projectId ? await requireProject(projectId) : null;
  if (!record) {
    await assertProjectsEnabled();
  }
  const harnessesByEngine = new Map<string, ProjectEngineListing["harnesses"]>();
  const workspacesByEngine = new Map<string, ProjectEngineListing["workspaces"]>();
  const [homeHarnesses, homeWorkspaces] = await Promise.all([
    listHomeHarnesses(),
    listWorkspaces(),
  ]);
  harnessesByEngine.set(PROJECT_HOME_ENGINE_ID, homeHarnesses);
  workspacesByEngine.set(
    PROJECT_HOME_ENGINE_ID,
    homeWorkspaces
      .filter((workspace) => !isEngineManagedWorkspace(workspace))
      .map((workspace) => ({ id: workspace.id, name: workspace.name, root: workspace.root }))
  );
  await Promise.all(
    (await listPeerEngines()).map(async (engine) => {
      const info = await callPeerEngine(engine.id, (client) =>
        client.info(ENGINE_INFO_TIMEOUT_MS)
      ).catch(() => null);
      harnessesByEngine.set(engine.id, info?.harnesses ?? []);
      workspacesByEngine.set(engine.id, info?.workspaces ?? []);
    })
  );
  return (await listEngineSummaries()).map((engine) => ({
    ...engine,
    repos: (record?.repos ?? [])
      .filter((repo) => repo.engineId === engine.id)
      .map((repo) => ({ id: repo.id, name: repo.name, root: repo.root })),
    harnesses: (harnessesByEngine.get(engine.id) ?? []).filter((harness) => harness.available),
    workspaces: workspacesByEngine.get(engine.id) ?? [],
  }));
}
