import { promises as fs } from "node:fs";
import path from "node:path";
import { PROJECT_HOME_ENGINE_ID, isProjectChildBusy, projectEngineName } from "@cesium/core/projects";
import { readConversationRecord, readRecentConversationEvents } from "../agents/session-store.js";
import type { AgentBackendId } from "../agents/types.js";
import { getWorkspaceById, type WorkspaceRecord } from "../workspace-registry.js";
import {
  lastAssistantReply,
  type ChildCreateResult,
  type ChildPlacement,
  type ChildRef,
} from "./child-host.js";
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
} from "./project-service.js";
import { mutateProject, readProject } from "./project-store.js";
import type { ProjectChildRecord, ProjectRecord } from "./types.js";
import { createDetachedWorktree, removeWorkerWorktree } from "./worktrees.js";

export const HELPER_BRIEF_TAG = "project_helper_brief";
const MAX_ACTIVE_HELPERS = 4;
const EXPLORE_WAIT_MS = 180_000;
const HELPER_POLL_MS = 250;
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

function helperRecord(input: {
  childId: string;
  name: string;
  helperKind: "explore" | "browser";
  created: Awaited<ReturnType<ReturnType<typeof childHostFor>["create"]>>;
  repoId: string | null;
  task: string;
  suppressReports: boolean;
  worktreePath: string | null;
  baseRef: string | null;
  baseSha: string | null;
}): ProjectChildRecord {
  return {
    id: input.childId,
    name: input.name,
    engineId: PROJECT_HOME_ENGINE_ID,
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
    isolation: input.worktreePath ? "worktree" : input.repoId ? "checkout" : "scratch",
    branch: null,
    baseRef: input.baseRef,
    baseSha: input.baseSha,
    worktreePath: input.worktreePath,
    githubRepo: null,
    pr: null,
    task: input.task,
    kind: "helper",
    helperKind: input.helperKind,
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

export function buildExploreBrief(input: {
  projectName: string;
  helperName: string;
  repoName: string;
  root: string;
  baseRef: string | null;
  sha: string | null;
  question: string;
}): string {
  return [
    `<${HELPER_BRIEF_TAG}>`,
    `You are "${input.helperName}", a helper agent in the Cesium Project "${input.projectName}": a read-only code explorer. The coordinator asked you the question below about the "${input.repoName}" repository.`,
    `- The code is at ${input.root}${input.sha ? `, a clean checkout of ${input.baseRef} (${input.sha.slice(0, 12)})` : ""}. Search and read it; change nothing.`,
    "- Answer concisely: the facts, the relevant files as path:line, and anything you are unsure of. Your reply goes to the coordinator as is.",
    `</${HELPER_BRIEF_TAG}>`,
    "",
    `Question: ${input.question}`,
  ].join("\n");
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

async function waitForHelperTurn(ref: ChildRef, timeoutMs: number): Promise<HelperOutcome> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = await readConversationRecord(ref.workspaceId, ref.conversationId);
    if (record && !isProjectChildBusy(record.status) && (record.queuedPrompts?.length ?? 0) === 0) {
      if (record.status === "failed") {
        return { done: true, answer: `The explorer failed: ${record.lastError ?? "unknown error"}.` };
      }
      if (record.status === "cancelled" || record.status === "interrupted") {
        return { done: true, answer: "The explorer was stopped before it answered." };
      }
      const reply = lastAssistantReply(await readRecentConversationEvents(ref.workspaceId, ref.conversationId, 2));
      if (reply) {
        return { done: true, answer: reply };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, helperPollMs));
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
  const observed = await readConversationRecord(child.workspaceId, child.conversationId).catch(() => null);
  await patchChild(projectId, childId, (current) => ({
    deletedAt: Date.now(),
    suppressReports: true,
    lastStatus: observed?.status ?? current.lastStatus,
    lastReportedSeq: observed?.lastEventSeq ?? current.lastReportedSeq,
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
  repoWorkspace: WorkspaceRecord;
  question: string;
  resolvedBase: { baseRef: string; sha: string } | null;
}): Promise<StartedExplorer> {
  const { record, repo, repoWorkspace, question } = input;
  const claim = await claimChildName(record.id, "explore");
  try {
    const { name } = claim;
    const childId = `pca_${randomHex(6)}`;
    const checkout = await createDetachedWorktree({
      projectId: record.id,
      repoWorkspace,
      baseBranch: repo.baseBranch ?? null,
      name: `${name}-${randomHex(2)}`,
      resolvedBase: input.resolvedBase,
    });
    const root = checkout?.path ?? repoWorkspace.root;
    const placement: ChildPlacement = { kind: "root", root };
    let created: ChildCreateResult;
    try {
      created = await childHostFor(PROJECT_HOME_ENGINE_ID).create({
        projectId: record.id,
        childId,
        name,
        promptText: buildExploreBrief({
          projectName: record.name,
          helperName: name,
          repoName: repo.name,
          root,
          baseRef: checkout?.baseRef ?? null,
          sha: checkout?.sha ?? null,
          question,
        }),
        displayText: question,
        placement,
        backendId: "cesium-agent" as AgentBackendId,
        modelId: record.settings.defaultChildModelId ?? record.orchestrator.modelId,
        mode: "ask",
        homeLabel: homeEngineLabel(),
        // Read-only by its mode, so its searches never wait for a person.
        autoApprove: true,
      });
    } catch (error) {
      if (checkout) {
        await removeWorkerWorktree(checkout.workspace).catch(() => undefined);
      }
      throw error;
    }
    await mutateProject(record.id, (existing) => ({
      ...existing,
      children: [
        ...existing.children,
        helperRecord({
          childId,
          name,
          helperKind: "explore",
          created,
          repoId: repo.id,
          task: question,
          suppressReports: true,
          worktreePath: checkout?.path ?? null,
          baseRef: checkout?.baseRef ?? null,
          baseSha: checkout?.sha ?? null,
        }),
      ],
    }));
    return { name, childId, ref: created, base: checkout ? { baseRef: checkout.baseRef, sha: checkout.sha } : null };
  } finally {
    claim.release();
  }
}

/**
 * Runs one read-only explorer per question on a repository (each in a clean
 * checkout of the same base commit), all at once, and waits for their answers.
 * An explorer that is too slow keeps working and reports back as an ordinary
 * agent update.
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
  if (repo.engineId !== PROJECT_HOME_ENGINE_ID) {
    const engines = await listEngineSummaries();
    throw new ProjectError(
      `project_explore reads repositories on this engine; ${repo.name} is on ${projectEngineName(repo.engineId, engines)}. Start a research agent there instead.`
    );
  }
  assertHelperCapacity(record, questions.length);
  const repoWorkspace = await getWorkspaceById(repo.workspaceId);
  if (!repoWorkspace) {
    throw new ProjectError(`${repo.name}'s folder is no longer registered on this engine.`);
  }
  // Checkouts are added one at a time (git locks the repository for each);
  // the explorers then all work at once.
  const slots: Array<{ question: string; explorer: StartedExplorer | null; error: string | null }> = [];
  let resolvedBase: { baseRef: string; sha: string } | null = null;
  for (const question of questions) {
    try {
      const explorer = await startExplorer({ record, repo, repoWorkspace, question, resolvedBase });
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
    slots.map((slot) => (slot.explorer ? waitForHelperTurn(slot.explorer.ref, exploreWaitMs) : null))
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
  const reply = lastAssistantReply(await readRecentConversationEvents(child.workspaceId, child.conversationId, 2));
  return (await finalizeExploreHelper(projectId, childId, reply ?? child.lastReplyPreview ?? "(no answer)")) || null;
}

export function buildBrowserCheckBrief(input: {
  projectName: string;
  helperName: string;
  what: string;
  where: string | null;
  url: string | null;
  mediaDir: string;
}): string {
  return [
    `<${HELPER_BRIEF_TAG}>`,
    `You are "${input.helperName}", a helper agent in the Cesium Project "${input.projectName}": a QA tester with a real browser. Check the behavior below in the running app and capture evidence.`,
    ...(input.where
      ? [
          `- The code is ${input.where}. Don't change it. Start the app from there if it isn't running (the README or package.json says how) and stop whatever you started when you finish.`,
        ]
      : []),
    ...(input.url ? [`- Open ${input.url}.`] : []),
    '- Drive the browser with call_mcp_tool on server "browser": browser_tabs (open a tab), browser_navigate, browser_snapshot, browser_click, browser_type, browser_screenshot, and browser_record (action "start" right before the interaction, "stop" right after). Tool details are under mcp-servers/browser/.',
    `- The tools save screenshots and recordings under artifacts/browser/ in your workspace; copy every one you make into ${input.mediaDir} and list the paths.`,
    "- End with a short report: what you checked, what worked, what failed, and the evidence paths. It reaches the coordinator automatically.",
    `</${HELPER_BRIEF_TAG}>`,
    "",
    `Check: ${input.what}`,
  ].join("\n");
}

/**
 * Starts a browser QA helper, in an agent's working tree (to run its branch)
 * or a scratch folder for a URL. It reports back as an agent update with the
 * evidence saved under `media/<helper>/`.
 */
export async function startBrowserCheck(
  projectId: string,
  input: { what: string; agent?: string | null; url?: string | null }
): Promise<{ helper: string; mediaDir: string }> {
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
  let where: string | null = null;
  let repoId: string | null = null;
  if (input.agent?.trim()) {
    const target = resolveProjectChild(record, input.agent);
    if (target.engineId !== PROJECT_HOME_ENGINE_ID) {
      throw new ProjectError("Browser checks run on this engine; that agent works on another one.");
    }
    const workspace = await getWorkspaceById(target.workspaceId);
    if (!workspace) {
      throw new ProjectError(`Agent ${target.name}'s folder is gone.`);
    }
    placement = { kind: "workspace", workspaceId: target.workspaceId };
    where = `agent ${target.name}'s working tree at ${workspace.root}${target.branch ? ` (branch \`${target.branch}\`)` : ""}`;
    repoId = target.repoId;
  } else if (url) {
    placement = { kind: "scratch", label: `${record.name} · browser check` };
  } else {
    throw new ProjectError("Pass the agent whose work to check, or a url.");
  }
  assertHelperCapacity(record);
  const claim = await claimChildName(projectId, "browser-check");
  try {
    const { name } = claim;
    const childId = `pca_${randomHex(6)}`;
    const mediaDir = path.join(getProjectContextDir(projectId), "media", name);
    await fs.mkdir(mediaDir, { recursive: true });
    let created: ChildCreateResult;
    try {
      created = await childHostFor(PROJECT_HOME_ENGINE_ID).create({
        projectId,
        childId,
        name,
        promptText: buildBrowserCheckBrief({ projectName: record.name, helperName: name, what, where, url, mediaDir }),
        displayText: `Check: ${what}`,
        placement,
        backendId: "cesium-agent" as AgentBackendId,
        modelId: record.settings.defaultChildModelId ?? record.orchestrator.modelId,
        mode: "agent",
        homeLabel: homeEngineLabel(),
        autoApprove: record.settings.autoApproveAgents,
      });
    } catch (error) {
      await fs.rmdir(mediaDir).catch(() => undefined);
      throw error;
    }
    await mutateProject(projectId, (existing) => ({
      ...existing,
      children: [
        ...existing.children,
        helperRecord({
          childId,
          name,
          helperKind: "browser",
          created,
          repoId,
          task: what,
          suppressReports: false,
          worktreePath: null,
          baseRef: null,
          baseSha: null,
        }),
      ],
    }));
    await observeNewChild(projectId, childId);
    return { helper: name, mediaDir };
  } finally {
    claim.release();
  }
}
