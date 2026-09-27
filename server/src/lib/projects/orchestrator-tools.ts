import {
  isProjectAgentIsolation,
  projectChildBucketLabel,
  projectEngineName,
  type ProjectChildSummary,
  type ProjectEngineListing,
  type ProjectPullRequestListing,
} from "@cesium/core/projects";
import {
  listProjectSubscriptionSummaries,
  subscribeProject,
  unsubscribeProject,
  type SubscribeInput,
} from "./listening.js";
import { listProjectPullRequests, mergeProjectPullRequest } from "./pull-requests.js";
import { readProjectSubscriptions, summarizeSubscription } from "./subscriptions-store.js";
import type { ProjectRecord } from "./types.js";
import {
  PROJECT_NOTES_FILE,
  listContextFiles,
  readContextFile,
  writeContextFile,
} from "./context-store.js";
import {
  ProjectError,
  adoptProjectChild,
  createProjectChild,
  deleteProjectChild,
  getProjectChild,
  listProjectChildSummaries,
  listProjectChildren,
  listProjectEngines,
  messageProjectChild,
  readProjectChildTranscript,
  requireProject,
  setProjectChildArchived,
  stopProjectChild,
  updateProjectChild,
} from "./project-service.js";
import { listEngineSummaries } from "./engine-registry.js";
import { PROJECT_ORCHESTRATOR_TOOL_NAMES } from "./orchestrator-tool-definitions.js";

const NOTES_REMINDER_MAX_CHARS = 6_000;
const PREVIEW_IN_TABLE_MAX_CHARS = 160;
const REPEAT_CHECK_WINDOW_MS = 90_000;

const WAIT_FOR_UPDATES_NOTE =
  "Agents report back on their own with a <project_agent_updates> message, delivered after your turn ends and never during it. Do not check on them in the meantime: finish any other delegation, then end your turn.";

type AgentCheck = { at: number; fingerprint: string; repeats: number };
const lastAgentChecks = new Map<string, AgentCheck>();
let repeatCheckWindowMs = REPEAT_CHECK_WINDOW_MS;

/** Test hook: how long an unchanged repeat of project_list_agents gets the short answer; `null` restores it. */
export function setProjectAgentCheckWindowForTests(ms: number | null): void {
  repeatCheckWindowMs = ms ?? REPEAT_CHECK_WINDOW_MS;
  lastAgentChecks.clear();
}

/**
 * Nothing reaches the orchestrator mid-turn, so polling project_list_agents
 * can never show progress. A repeat check that finds the same state within
 * the window gets a short reminder to end the turn instead of the full list.
 */
function answerAgentCheck(key: string, payload: Record<string, unknown>): string {
  const fingerprint = JSON.stringify(payload);
  const now = Date.now();
  const previous = lastAgentChecks.get(key);
  if (previous && previous.fingerprint === fingerprint && now - previous.at < repeatCheckWindowMs) {
    const secondsAgo = Math.max(1, Math.round((now - previous.at) / 1000));
    previous.at = now;
    previous.repeats += 1;
    return json({
      unchanged: true,
      checksWithoutChange: previous.repeats,
      note: `Nothing has changed since your last check ${secondsAgo}s ago, and nothing can change while your turn is running. ${WAIT_FOR_UPDATES_NOTE}`,
    });
  }
  lastAgentChecks.set(key, { at: now, fingerprint, repeats: 0 });
  return json(payload);
}

function arg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredArg(args: Record<string, unknown>, key: string, tool: string): string {
  const value = arg(args, key);
  if (!value) {
    throw new ProjectError(`${tool}.${key} is required.`);
  }
  return value;
}

function compactChild(child: ProjectChildSummary) {
  return {
    name: child.name,
    id: child.id,
    status: child.status,
    bucket: child.bucket,
    engine: child.engineLabel,
    harness: child.backendId,
    model: child.modelId,
    mode: child.mode,
    repo: child.repoName,
    isolation: child.isolation,
    ...(child.branch ? { branch: child.branch, base: child.baseRef } : {}),
    ...(child.worktreePath ? { worktree: child.worktreePath } : {}),
    queued: child.queued,
    turnsCompleted: child.turnsCompleted,
    needs: child.attention ? `${child.attention.kind}: ${child.attention.title}` : null,
    lastReply: child.lastReplyPreview,
    lastError: child.lastError,
    ...(child.archivedAt != null ? { archivedAt: new Date(child.archivedAt).toISOString() } : {}),
    ...(child.deletedAt != null ? { deletedAt: new Date(child.deletedAt).toISOString() } : {}),
  };
}

/** Engines by name; ids, URLs and bindable folders are for people setting the Project up. */
function compactEngine(engine: ProjectEngineListing, engines: readonly ProjectEngineListing[]) {
  return {
    engine: projectEngineName(engine.id, engines),
    ...(engine.kind === "home" ? { thisEngine: true } : {}),
    online: engine.online,
    ...(engine.error ? { error: engine.error } : {}),
    repos: engine.repos.map((repo) => ({ name: repo.name, root: repo.root })),
    harnesses: engine.harnesses.map((harness) => ({
      id: harness.id,
      label: harness.label,
      defaultModel: harness.defaultModelId,
    })),
  };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function compactPullRequest(pr: ProjectPullRequestListing) {
  return {
    pr: `${pr.repo}#${pr.number}`,
    url: pr.url,
    title: pr.title,
    agent: pr.agent,
    state: pr.draft && pr.state === "open" ? "draft" : pr.state,
    ci: pr.ci,
    ...(pr.failedChecks.length > 0 ? { failedChecks: pr.failedChecks } : {}),
    review: pr.review,
    mergeable: pr.mergeable,
    branch: pr.headRef,
    base: pr.baseRef,
    ...(pr.openedByProject ? { openedByProject: true } : {}),
  };
}

/** `owner/repo#N`, a PR URL, or `#N` when the Project's agents push to one GitHub repo. */
function parsePrRef(record: ProjectRecord, raw: string): { repo: string; number: number } {
  const url = raw.match(/\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/);
  if (url) {
    return { repo: url[1]!, number: Number(url[2]) };
  }
  const slug = raw.match(/^([^/\s#]+\/[^/\s#]+)#(\d+)$/);
  if (slug) {
    return { repo: slug[1]!, number: Number(slug[2]) };
  }
  const bare = raw.match(/^#?(\d+)$/);
  const repos = [
    ...new Set(
      [...record.repos.map((repo) => repo.githubRepo), ...record.children.map((child) => child.githubRepo)].filter(
        (entry): entry is string => Boolean(entry)
      )
    ),
  ];
  if (bare && repos.length === 1) {
    return { repo: repos[0]!, number: Number(bare[1]) };
  }
  throw new ProjectError(`Pass the PR as owner/repo#N or its URL (got "${raw}").`);
}

function subscribeInputFromArgs(record: ProjectRecord, args: Record<string, unknown>): SubscribeInput {
  switch (args.kind) {
    case "github_pr": {
      const ref = parsePrRef(record, requiredArg(args, "pr", "project_subscribe"));
      return { kind: "github_pr", ...ref, keepAfterClose: args.keep_after_close === true };
    }
    case "github_ci":
      return {
        kind: "github_ci",
        repo: requiredArg(args, "repo", "project_subscribe"),
        branch: requiredArg(args, "branch", "project_subscribe"),
      };
    case "timer": {
      const everyMinutes = typeof args.every_minutes === "number" ? args.every_minutes : null;
      const inMinutes = typeof args.in_minutes === "number" ? args.in_minutes : null;
      const cron = arg(args, "cron") ?? null;
      if (!cron && everyMinutes == null && inMinutes == null) {
        throw new ProjectError("A timer needs cron, every_minutes or in_minutes.");
      }
      return {
        kind: "timer",
        name: requiredArg(args, "name", "project_subscribe"),
        prompt: requiredArg(args, "prompt", "project_subscribe"),
        cron,
        intervalSeconds: everyMinutes != null ? Math.round(everyMinutes * 60) : null,
        delaySeconds: inMinutes != null ? Math.max(1, Math.round(inMinutes * 60)) : null,
        once: !cron && everyMinutes == null,
      };
    }
    default:
      throw new ProjectError('kind must be "github_pr", "github_ci" or "timer".');
  }
}

/** Dispatches one orchestrator tool call. Throws on bad input; the harness reports it. */
export async function executeProjectOrchestratorTool(
  projectId: string,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  if (!PROJECT_ORCHESTRATOR_TOOL_NAMES.has(name)) {
    throw new ProjectError(`${name} is not a Project tool.`);
  }
  switch (name) {
    case "project_list_engines": {
      const engines = await listProjectEngines(projectId);
      return json({ engines: engines.map((engine) => compactEngine(engine, engines)) });
    }
    case "project_create_agent": {
      const { agent, warning } = await createProjectChild(
        projectId,
        {
          name: requiredArg(args, "name", name),
          instructions: requiredArg(args, "instructions", name),
          repo: arg(args, "repo") ?? null,
          engine: arg(args, "engine") ?? null,
          harness: arg(args, "harness") ?? null,
          model: arg(args, "model") ?? null,
          mode: arg(args, "mode") ?? null,
          isolation: isProjectAgentIsolation(args.isolation) ? args.isolation : null,
          base: arg(args, "base") ?? null,
        },
        "orchestrator"
      );
      return json({
        created: compactChild(agent),
        ...(warning ? { warning } : {}),
        note: `The agent is working on its first task. ${WAIT_FOR_UPDATES_NOTE}`,
      });
    }
    case "project_list_agents": {
      const agent = arg(args, "agent");
      if (agent) {
        const child = compactChild(await getProjectChild(projectId, agent));
        return answerAgentCheck(`${projectId}:agent:${child.id}`, {
          agent: child,
          ...(child.bucket === "working" ? { note: WAIT_FOR_UPDATES_NOTE } : {}),
        });
      }
      const includeDeleted = args.include_deleted === true;
      const includeArchived = args.include_archived === true;
      const agents = (await listProjectChildren(projectId, { includeDeleted, includeArchived })).map(
        compactChild
      );
      return answerAgentCheck(`${projectId}:all:${includeDeleted}:${includeArchived}`, {
        agents,
        ...(agents.some((child) => child.bucket === "working") ? { note: WAIT_FOR_UPDATES_NOTE } : {}),
      });
    }
    case "project_steer_agent":
    case "project_queue_agent": {
      const result = await messageProjectChild(
        projectId,
        requiredArg(args, "agent", name),
        requiredArg(args, "message", name),
        name === "project_steer_agent" ? "steer" : "queue"
      );
      return json({ ...result, note: WAIT_FOR_UPDATES_NOTE });
    }
    case "project_stop_agent":
      return json(await stopProjectChild(projectId, requiredArg(args, "agent", name)));
    case "project_update_agent": {
      const child = await updateProjectChild(projectId, requiredArg(args, "agent", name), {
        name: arg(args, "name") ?? null,
        model: arg(args, "model") ?? null,
        mode: arg(args, "mode") ?? null,
      });
      return json({ updated: compactChild(child) });
    }
    case "project_delete_agent":
      return json(await deleteProjectChild(projectId, requiredArg(args, "agent", name)));
    case "project_archive_agent": {
      const archived = args.unarchive !== true;
      const child = await setProjectChildArchived(projectId, requiredArg(args, "agent", name), archived);
      return json({ [archived ? "archived" : "restored"]: compactChild(child) });
    }
    case "project_adopt_agent": {
      const child = await adoptProjectChild(projectId, {
        conversation: requiredArg(args, "conversation", name),
        name: arg(args, "name") ?? null,
      });
      return json({ adopted: compactChild(child) });
    }
    case "project_read_transcript": {
      const result = await readProjectChildTranscript(
        projectId,
        requiredArg(args, "agent", name),
        args.turns
      );
      return `Agent ${result.agent} (status: ${result.status})\n\n${result.transcript}`;
    }
    case "project_list_prs": {
      await requireProject(projectId);
      const prs = await listProjectPullRequests(projectId);
      return json({
        prs: prs.map(compactPullRequest),
        ...(prs.length === 0
          ? { note: "No pull requests yet. Agents' PRs appear here once they push and open one." }
          : {}),
      });
    }
    case "project_merge_pr": {
      await requireProject(projectId);
      const result = await mergeProjectPullRequest(projectId, {
        pr: requiredArg(args, "pr", name),
        userQuote: arg(args, "user_quote") ?? null,
      });
      return json({ merged: compactPullRequest(result.pr), commit: result.sha });
    }
    case "project_subscribe": {
      const record = await requireProject(projectId);
      const input = subscribeInputFromArgs(record, args);
      const expiresInDays = typeof args.expires_in_days === "number" ? args.expires_in_days : null;
      const { subscription, created } = await subscribeProject(
        projectId,
        { ...input, expiresInMs: expiresInDays ? expiresInDays * 86_400_000 : null },
        "coordinator"
      );
      return json({
        [created ? "subscribed" : "alreadySubscribed"]: summarizeSubscription(subscription, record.children),
        note: "Events arrive as <project_events> turns. Say what you are waiting for and end your turn.",
      });
    }
    case "project_list_subscriptions": {
      await requireProject(projectId);
      return json({
        subscriptions: await listProjectSubscriptionSummaries(projectId, {
          includeClosed: args.include_closed === true,
        }),
      });
    }
    case "project_unsubscribe": {
      const record = await requireProject(projectId);
      const closed = await unsubscribeProject(projectId, requiredArg(args, "id", name));
      return json({ unsubscribed: summarizeSubscription(closed, record.children) });
    }
    case "project_context_list": {
      await requireProject(projectId);
      return json({ files: await listContextFiles(projectId) });
    }
    case "project_context_read": {
      await requireProject(projectId);
      const file = await readContextFile(projectId, requiredArg(args, "path", name));
      return `${file.path} (${file.size} bytes)\n\n${file.content}`;
    }
    case "project_context_write": {
      await requireProject(projectId);
      const content = typeof args.content === "string" ? args.content : "";
      if (!content.trim() && args.mode === "append") {
        throw new ProjectError("project_context_write.content is required.");
      }
      const written = await writeContextFile(
        projectId,
        requiredArg(args, "path", name),
        content,
        args.mode === "append" ? "append" : "replace"
      );
      return json({ written });
    }
    default:
      throw new ProjectError(`${name} is not implemented.`);
  }
}

function oneLine(text: string | null, max: number): string {
  if (!text) {
    return "-";
  }
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat || "-";
}

/** Per-turn state the orchestrator sees ahead of each user message. */
export async function buildProjectOrchestratorReminder(
  projectId: string,
  context: { dateLabel: string; modelName: string }
): Promise<string> {
  const record = await requireProject(projectId);
  const [children, files, notes, engines, subscriptions] = await Promise.all([
    listProjectChildSummaries(record),
    listContextFiles(projectId).catch(() => []),
    readContextFile(projectId, PROJECT_NOTES_FILE).catch(() => null),
    listEngineSummaries(),
    readProjectSubscriptions(projectId).catch(() => []),
  ]);
  const prs = await listProjectPullRequests(projectId).catch(() => []);
  const working = children.filter((child) => child.bucket === "working").length;
  const lines: string[] = [
    "<project>",
    `Project: ${record.name} (${record.id})`,
    `Date: ${context.dateLabel}`,
    `Your model: ${context.modelName}`,
    `Agents working: ${working} of max ${record.settings.maxActiveChildren}`,
    ...(working > 0
      ? ["Working agents report back with <project_agent_updates> after this turn ends. Do not poll them."]
      : []),
    "",
    "Engines (refer to them by these names):",
    ...engines.map(
      (engine) =>
        `- ${projectEngineName(engine.id, engines)}${engine.kind === "home" ? " (this engine)" : engine.online ? "" : ` · OFFLINE${engine.error ? `: ${oneLine(engine.error, PREVIEW_IN_TABLE_MAX_CHARS)}` : ""}`}`
    ),
    "",
    "Repositories:",
    ...(record.repos.length > 0
      ? record.repos.map(
          (repo) => `- ${repo.name} (engine ${projectEngineName(repo.engineId, engines)}) ${repo.root}`
        )
      : ["- none bound; agents without a repo get an empty scratch folder"]),
    "",
    "Agents:",
    ...(children.length > 0
      ? children.map(
          (child) =>
            `- ${child.name}: ${projectChildBucketLabel(child.bucket)} (${child.status}) · ${child.backendId}${child.modelId ? ` / ${child.modelId}` : ""} · engine ${child.engineLabel}${child.repoName ? ` · repo ${child.repoName}` : ""}${child.branch ? ` · branch ${child.branch}` : child.isolation === "checkout" ? " · in the repo checkout" : ""}${child.queued ? ` · ${child.queued} queued` : ""}${child.attention ? ` · NEEDS ${child.attention.kind}: ${child.attention.title}` : ""} · last reply: ${oneLine(child.lastReplyPreview, PREVIEW_IN_TABLE_MAX_CHARS)}`
        )
      : ["- none yet"]),
    "",
    `Merge policy: ${record.settings.mergePolicy === "when_green" ? "you may merge green PRs" : "merge only when the user explicitly says so (quote them in project_merge_pr)"}`,
    "",
    "Pull requests:",
    ...(prs.length > 0
      ? prs.map(
          (pr) =>
            `- ${pr.repo}#${pr.number} ${pr.draft && pr.state === "open" ? "draft" : pr.state}${pr.agent ? ` · agent ${pr.agent}` : ""} · CI ${pr.ci ?? "unknown"}${pr.failedChecks.length ? ` (${pr.failedChecks.join(", ")})` : ""}${pr.review ? ` · review ${pr.review.replace(/_/g, " ")}` : ""} · ${oneLine(pr.title, PREVIEW_IN_TABLE_MAX_CHARS)} ${pr.url}`
        )
      : ["- none yet"]),
    "",
    "Listening:",
    ...(subscriptions.some((entry) => entry.closedAt == null)
      ? subscriptions
          .filter((entry) => entry.closedAt == null)
          .map((entry) => {
            const summary = summarizeSubscription(entry, record.children);
            return `- ${summary.label}${summary.agent ? ` (agent ${summary.agent})` : ""} [${summary.id}]`;
          })
      : ["- nothing"]),
    "</project>",
  ];
  if (notes) {
    const body =
      notes.content.length > NOTES_REMINDER_MAX_CHARS
        ? `${notes.content.slice(0, NOTES_REMINDER_MAX_CHARS)}\n[…truncated; read ${PROJECT_NOTES_FILE} for the rest]`
        : notes.content;
    lines.push("", `<project_notes path="${PROJECT_NOTES_FILE}">`, body.trim(), "</project_notes>");
  }
  const otherFiles = files.filter((file) => file.path !== PROJECT_NOTES_FILE);
  if (otherFiles.length > 0) {
    lines.push(
      "",
      "<project_context_files>",
      ...otherFiles.map((file) => `- ${file.path} (${file.size} bytes)`),
      "</project_context_files>"
    );
  }
  return lines.join("\n");
}
