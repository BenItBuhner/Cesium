import { promises as fs } from "node:fs";
import path from "node:path";
import { PROJECT_HOME_ENGINE_ID, isProjectChildBusy, projectEngineName } from "@cesium/core/projects";
import type { AgentBackendId } from "../agents/types.js";
import type { ChildCreateResult, ChildPlacement, ChildRef } from "./child-host.js";
import { writeContextFile } from "./context-store.js";
import { homeEngineLabel, listEngineSummaries } from "./engine-registry.js";
import { ProjectError } from "./errors.js";
import { getProjectContextDir } from "./paths.js";
import {
  childHostFor,
  claimChildName,
  disposeChildResources,
  patchChild,
  randomHex,
  requireProject,
  resolveProjectChild,
  syncContextToPeer,
} from "./project-service.js";
import { mutateProject, readProject } from "./project-store.js";
import type { ProjectChildRecord, ProjectRecord } from "./types.js";

const MAX_ACTIVE_HELPERS = 4;
const EXPLORE_WAIT_MS = 180_000;
const HELPER_POLL_MS = 250;
/** A helper on another engine is observed over the network, so less often. */
const REMOTE_HELPER_POLL_MS = 1_000;
const ANSWER_MAX_CHARS = 60_000;

let exploreWaitMs = EXPLORE_WAIT_MS;
let helperPollMs = HELPER_POLL_MS;

/** Test hook: how long project_explore waits for answers before handing them to the watcher, and how often it looks. */
export function setExploreWaitForTests(ms: number | null, options: { pollMs?: number } = {}): void {
  exploreWaitMs = ms ?? EXPLORE_WAIT_MS;
  helperPollMs = options.pollMs ?? HELPER_POLL_MS;
}

function findRepo(record: ProjectRecord, ref: string) {
  const wanted = ref.trim().toLowerCase();
  const repo = record.repos.find((entry) => entry.id === ref.trim() || entry.name.toLowerCase() === wanted);
  if (!repo) {
    throw new ProjectError(
      record.repos.length > 0
        ? `Unknown repository "${ref}". Repositories: ${record.repos.map((entry) => entry.name).join(", ")}.`
        : "This Project has no repositories to explore."
    );
  }
  return repo;
}

function assertHelperCapacity(record: ProjectRecord, adding = 1): void {
  const active = record.children.filter(
    (child) => child.kind === "helper" && child.deletedAt == null && isProjectChildBusy(child.lastStatus)
  ).length;
  if (active + adding > MAX_ACTIVE_HELPERS) {
    const room = Math.max(0, MAX_ACTIVE_HELPERS - active);
    throw new ProjectError(
      `${active} helpers are already running (limit ${MAX_ACTIVE_HELPERS}), so ${room === 0 ? "none" : `only ${room}`} can start now. Wait for one to report.`,
      409
    );
  }
}

/** Helpers run the Project's default model at home; another engine picks its own default, like its workers. */
function helperModelId(record: ProjectRecord, engineId: string): string | null {
  return engineId === PROJECT_HOME_ENGINE_ID ? (record.settings.defaultChildModelId ?? record.orchestrator.modelId) : null;
}

function helperRecord(input: {
  childId: string;
  name: string;
  engineId: string;
  helperKind: "explore" | "browser";
  created: ChildCreateResult;
  repoId: string | null;
  task: string;
  suppressReports: boolean;
}): ProjectChildRecord {
  return {
    id: input.childId,
    name: input.name,
    engineId: input.engineId,
    repoId: input.repoId,
    workspaceId: input.created.workspaceId,
    conversationId: input.created.conversationId,
    backendId: input.created.backendId,
    modelId: input.created.modelId,
    mode: input.created.mode,
    createdBy: "orchestrator",
    createdAt: Date.now(),
    deletedAt: null,
    archivedAt: null,
    isolation: input.created.isolation,
    branch: null,
    baseRef: input.created.baseRef,
    baseSha: input.created.baseSha,
    worktreePath: input.created.worktreePath,
    githubRepo: null,
    pr: null,
    task: input.task,
    kind: "helper",
    helperKind: input.helperKind,
    evidence: null,
    lastStatus: "running",
    turnsCompleted: 0,
    lastReportedSeq: 0,
    suppressReports: input.suppressReports,
    suppressedThroughSeq: null,
    lastAttentionId: null,
    lastReplyPreview: null,
    lastSeenAt: Date.now(),
    lastError: null,
  };
}

async function resumeProjectChildReports(projectId: string, childId: string, fromSeq: number): Promise<void> {
  const watcher = await import("./project-watcher.js");
  await watcher.resumeProjectChildReports(projectId, childId, fromSeq);
}

async function observeNewChild(projectId: string, childId: string): Promise<void> {
  const watcher = await import("./project-watcher.js");
  watcher.observeNewProjectChild(projectId, childId);
}

type HelperOutcome = { done: true; answer: string } | { done: false };

async function waitForHelperTurn(engineId: string, ref: ChildRef, timeoutMs: number): Promise<HelperOutcome> {
  const host = childHostFor(engineId);
  const pollMs = engineId === PROJECT_HOME_ENGINE_ID ? helperPollMs : Math.max(helperPollMs, REMOTE_HELPER_POLL_MS);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observation = await host.observe(ref).catch(() => null);
    if (observation?.exists && !isProjectChildBusy(observation.status) && observation.queued === 0) {
      if (observation.status === "failed") {
        return { done: true, answer: `The explorer failed: ${observation.lastError ?? "unknown error"}.` };
      }
      if (observation.status === "cancelled" || observation.status === "interrupted") {
        return { done: true, answer: "The explorer was stopped before it answered." };
      }
      const reply = await host.lastReply(ref).catch(() => null);
      if (reply) {
        return { done: true, answer: reply };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { done: false };
}

/**
 * Records an explore helper's answer in the Project context
 * (`internal/explore/<name>.md`) and removes the helper and its checkout.
 */
async function finalizeExploreHelper(projectId: string, childId: string, answer: string): Promise<string> {
  const record = await readProject(projectId);
  const child = record?.children.find((entry) => entry.id === childId);
  if (!record || !child) {
    return "";
  }
  const repo = child.repoId ? record.repos.find((entry) => entry.id === child.repoId) : null;
  const relative = `internal/explore/${child.name}.md`;
  const clipped = answer.length > ANSWER_MAX_CHARS ? `${answer.slice(0, ANSWER_MAX_CHARS)}\n\n[…truncated]` : answer;
  await writeContextFile(
    projectId,
    relative,
    [
      `# ${child.name}`,
      "",
      `Question: ${child.task ?? ""}`,
      "",
      `Repository: ${repo?.name ?? "?"}${child.baseSha ? ` at ${child.baseRef} (${child.baseSha.slice(0, 12)})` : ""}`,
      "",
      "## Answer",
      "",
      clipped,
      "",
    ].join("\n")
  ).catch(() => undefined);
  const observed = await childHostFor(child.engineId)
    .observe({ workspaceId: child.workspaceId, conversationId: child.conversationId })
    .catch(() => null);
  await patchChild(projectId, childId, (current) => ({
    deletedAt: Date.now(),
    suppressReports: true,
    lastStatus: observed?.exists ? observed.status : current.lastStatus,
    lastReportedSeq: observed?.exists ? observed.lastEventSeq : current.lastReportedSeq,
    turnsCompleted: current.turnsCompleted + 1,
    lastReplyPreview: answer.length > 1_200 ? `${answer.slice(0, 1_199)}…` : answer,
  }));
  await disposeChildResources(child, record.children);
  return relative;
}

export type ExploreResult = {
  question: string;
  /** Null when its explorer could not start (see `error`). */
  helper: string | null;
  /** The explorer's answer; null while it is still working (it reports as an agent update). */
  answer: string | null;
  savedTo: string | null;
  error: string | null;
};

type StartedExplorer = {
  name: string;
  childId: string;
  ref: ChildRef;
  base: { baseRef: string; sha: string } | null;
};

async function startExplorer(input: {
  record: ProjectRecord;
  repo: ProjectRecord["repos"][number];
  engineLabel: string;
  question: string;
  resolvedBase: { baseRef: string; sha: string } | null;
}): Promise<StartedExplorer> {
  const { record, repo, question } = input;
  const claim = await claimChildName(record.id, "explore");
  try {
    const { name } = claim;
    const childId = `pca_${randomHex(6)}`;
    const placement: ChildPlacement = {
      kind: "snapshot",
      workspaceId: repo.workspaceId,
      baseBranch: repo.baseBranch ?? null,
      name: `${name}-${randomHex(2)}`,
      base: input.resolvedBase,
    };
    const created = await childHostFor(repo.engineId).create({
      projectId: record.id,
      childId,
      name,
      helperBrief: { kind: "explore", projectName: record.name, helperName: name, repoName: repo.name, question },
      displayText: question,
      placement,
      backendId: "cesium-agent" as AgentBackendId,
      modelId: helperModelId(record, repo.engineId),
      homeLabel: homeEngineLabel(),
      engineLabel: input.engineLabel,
      // It only gets tools that change nothing, so its searches never wait for a person.
      readOnly: true,
      autoApprove: true,
    });
    await mutateProject(record.id, (existing) => ({
      ...existing,
      children: [
        ...existing.children,
        helperRecord({
          childId,
          name,
          engineId: repo.engineId,
          helperKind: "explore",
          created,
          repoId: repo.id,
          task: question,
          suppressReports: true,
        }),
      ],
    }));
    return {
      name,
      childId,
      ref: created,
      base: created.baseRef && created.baseSha ? { baseRef: created.baseRef, sha: created.baseSha } : null,
    };
  } finally {
    claim.release();
  }
}

/**
 * Runs one read-only explorer per question on a repository, on the engine
 * that holds it (each in a clean checkout of the same base commit), all at
 * once, and waits for their answers. An explorer that is too slow keeps
 * working and reports back as an ordinary agent update.
 */
export async function exploreProjectRepo(
  projectId: string,
  input: { repo: string; questions: string[] }
): Promise<ExploreResult[]> {
  const record = await requireProject(projectId);
  const questions = input.questions.map((question) => question.trim()).filter(Boolean);
  if (questions.length === 0) {
    throw new ProjectError("project_explore needs a question.");
  }
  if (questions.length > MAX_ACTIVE_HELPERS) {
    throw new ProjectError(`Ask at most ${MAX_ACTIVE_HELPERS} questions at once.`);
  }
  const repo = findRepo(record, input.repo ?? "");
  assertHelperCapacity(record, questions.length);
  const engineLabel = projectEngineName(repo.engineId, await listEngineSummaries());
  // Checkouts are added one at a time (git locks the repository for each);
  // the explorers then all work at once.
  const slots: Array<{ question: string; explorer: StartedExplorer | null; error: string | null }> = [];
  let resolvedBase: { baseRef: string; sha: string } | null = null;
  for (const question of questions) {
    try {
      const explorer = await startExplorer({ record, repo, engineLabel, question, resolvedBase });
      resolvedBase ??= explorer.base;
      slots.push({ question, explorer, error: null });
    } catch (error) {
      if (questions.length === 1) {
        throw error;
      }
      slots.push({ question, explorer: null, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (slots.every((slot) => !slot.explorer)) {
    throw new ProjectError(`No explorer could start: ${slots[0]?.error ?? "unknown error"}`);
  }
  const outcomes = await Promise.all(
    slots.map((slot) => (slot.explorer ? waitForHelperTurn(repo.engineId, slot.explorer.ref, exploreWaitMs) : null))
  );
  const results: ExploreResult[] = [];
  for (const [index, slot] of slots.entries()) {
    const outcome = outcomes[index];
    const base = { question: slot.question, answer: null, savedTo: null, error: null };
    if (!slot.explorer || !outcome) {
      results.push({ ...base, helper: null, error: slot.error });
    } else if (outcome.done) {
      const savedTo = await finalizeExploreHelper(projectId, slot.explorer.childId, outcome.answer);
      results.push({ ...base, helper: slot.explorer.name, answer: outcome.answer, savedTo: savedTo || null });
    } else {
      // Too slow to wait for: from here it reports like any agent, and is cleaned up then.
      await resumeProjectChildReports(projectId, slot.explorer.childId, 0);
      results.push({ ...base, helper: slot.explorer.name });
    }
  }
  return results;
}

/**
 * Called when the watcher is about to report a helper's turn: an explorer is
 * one-shot, so its answer is saved and it is removed. Returns where the answer
 * was saved.
 */
export async function afterHelperReported(projectId: string, childId: string): Promise<string | null> {
  const record = await readProject(projectId);
  const child = record?.children.find((entry) => entry.id === childId);
  if (!child || child.kind !== "helper" || child.helperKind !== "explore" || child.deletedAt != null) {
    return null;
  }
  const reply = await childHostFor(child.engineId)
    .lastReply({ workspaceId: child.workspaceId, conversationId: child.conversationId })
    .catch(() => null);
  return (await finalizeExploreHelper(projectId, childId, reply ?? child.lastReplyPreview ?? "(no answer)")) || null;
}

/**
 * Starts a browser QA helper: in an agent's working tree on that agent's
 * engine (to run its branch), or in a scratch folder here for a URL. It
 * reports back as an agent update with the evidence saved under
 * `media/<helper>/` in the Project context (copied back from a peer after its
 * turn). Returns where the evidence lands here, or null when the peer has no
 * copy of the context and the files stay there.
 */
export async function startBrowserCheck(
  projectId: string,
  input: { what: string; agent?: string | null; url?: string | null }
): Promise<{ helper: string; mediaDir: string | null; engine: string }> {
  const record = await requireProject(projectId);
  const what = input.what?.trim();
  if (!what) {
    throw new ProjectError("project_browser_check needs what to check.");
  }
  const url = input.url?.trim() || null;
  if (url && !/^https?:\/\//i.test(url)) {
    throw new ProjectError("url must start with http:// or https://.");
  }
  let placement: ChildPlacement;
  let engineId: string = PROJECT_HOME_ENGINE_ID;
  let target: ProjectChildRecord | null = null;
  if (input.agent?.trim()) {
    target = resolveProjectChild(record, input.agent);
    engineId = target.engineId;
    placement = { kind: "agent", workspaceId: target.workspaceId, conversationId: target.conversationId };
  } else if (url) {
    placement = { kind: "scratch", label: `${record.name} · browser check` };
  } else {
    throw new ProjectError("Pass the agent whose work to check, or a url.");
  }
  assertHelperCapacity(record);
  const isHome = engineId === PROJECT_HOME_ENGINE_ID;
  const engines = await listEngineSummaries();
  const claim = await claimChildName(projectId, "browser-check");
  try {
    const { name } = claim;
    const childId = `pca_${randomHex(6)}`;
    const homeMediaDir = path.join(getProjectContextDir(projectId), "media", name);
    const contextSync = isHome ? false : await syncContextToPeer(projectId, engineId);
    if (isHome) {
      await fs.mkdir(homeMediaDir, { recursive: true });
    }
    let created: ChildCreateResult;
    try {
      created = await childHostFor(engineId).create({
        projectId,
        childId,
        name,
        helperBrief: {
          kind: "browser",
          projectName: record.name,
          helperName: name,
          what,
          url,
          agent: target ? { name: target.name, branch: target.branch } : null,
          // A peer puts it in its own copy of the context.
          mediaDir: isHome ? homeMediaDir : null,
          contextSync,
        },
        displayText: `Check: ${what}`,
        placement,
        backendId: "cesium-agent" as AgentBackendId,
        modelId: helperModelId(record, engineId),
        mode: "agent",
        homeLabel: homeEngineLabel(),
        engineLabel: projectEngineName(engineId, engines),
        autoApprove: record.settings.autoApproveAgents,
      });
    } catch (error) {
      if (isHome) {
        await fs.rmdir(homeMediaDir).catch(() => undefined);
      }
      throw error;
    }
    await mutateProject(projectId, (existing) => ({
      ...existing,
      children: [
        ...existing.children,
        helperRecord({
          childId,
          name,
          engineId,
          helperKind: "browser",
          created,
          repoId: target?.repoId ?? null,
          task: what,
          suppressReports: false,
        }),
      ],
    }));
    await observeNewChild(projectId, childId);
    return { helper: name, mediaDir: isHome || contextSync ? homeMediaDir : null, engine: projectEngineName(engineId, engines) };
  } finally {
    claim.release();
  }
}
