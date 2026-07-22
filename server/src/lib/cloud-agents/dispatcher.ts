import { promises as fs } from "node:fs";
import path from "node:path";
import { agentRuntimeManager } from "../agents/runtime-manager.js";
import { subscribeAgentStoreEvents } from "../agents/session-store.js";
import type { AgentBackendId } from "../agents/types.js";
import { createWorkspaceWorktree } from "../git-worktrees.js";
import {
  ensureWorkspaceRegistered,
  getWorkspaceById,
  getWorkspaceProfile,
  listWorkspaces,
  type WorkspaceRecord,
} from "../workspace-registry.js";
import { getCloudAgentSettings } from "./settings.js";
import {
  appendCloudAgentTaskTimeline,
  createCloudAgentTask,
  findCloudAgentTaskByConversation,
  findSteerableCloudAgentTaskBySource,
  getCloudAgentTask,
  updateCloudAgentTask,
} from "./tasks.js";
import type {
  CloudAgentExecutionMode,
  CloudAgentInboundAssignment,
  CloudAgentRoutingRule,
  CloudAgentTaskRecord,
  CloudAgentTaskSource,
} from "./types.js";

export const CLOUD_AGENT_ARTIFACTS_DIR = ".cesium/cloud-artifacts";

export type CloudAgentResolvedRoute = {
  workspaceId: string | null;
  backendId: AgentBackendId;
  modelId: string | null;
  executionMode: CloudAgentExecutionMode;
  matchedRuleId: string | null;
};

function sourceHaystack(source: CloudAgentTaskSource): string {
  return [
    source.repo,
    source.teamKey,
    source.project,
    source.channel,
    ...(source.labels ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function ruleMatches(rule: CloudAgentRoutingRule, source: CloudAgentTaskSource): boolean {
  if (rule.providerId !== "any" && rule.providerId !== source.providerId) {
    return false;
  }
  const match = rule.match.trim().toLowerCase();
  if (!match) {
    return true;
  }
  return sourceHaystack(source).includes(match);
}

/**
 * Filters an assignment down to its target workspace + harness/model using the
 * configured routing rules; falls back to the Cloud Agents defaults and then
 * the profile's default workspace.
 */
export async function resolveCloudAgentRoute(
  source: CloudAgentTaskSource
): Promise<CloudAgentResolvedRoute> {
  const settings = await getCloudAgentSettings();
  const rule = settings.routingRules.find((candidate) => ruleMatches(candidate, source));
  let workspaceId = rule?.workspaceId ?? settings.defaults.workspaceId;
  if (!workspaceId) {
    const profile = await getWorkspaceProfile().catch(() => null);
    workspaceId = profile?.defaultWorkspaceId ?? profile?.lastOpenedWorkspaceId ?? null;
  }
  return {
    workspaceId,
    backendId: rule?.backendId ?? settings.defaults.backendId,
    modelId: rule?.modelId ?? settings.defaults.modelId,
    executionMode: rule?.executionMode ?? settings.defaults.executionMode,
    matchedRuleId: rule?.id ?? null,
  };
}

function slugify(text: string, maxLength = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "task";
}

export function buildCloudAgentBranchName(task: Pick<CloudAgentTaskRecord, "id" | "title">): string {
  return `cloud/${slugify(task.title)}-${task.id.slice(0, 8)}`;
}

/** Short provenance label for rail badges, e.g. "owner/repo#42" or "OSP". */
export function buildCloudAgentOriginLabel(source: CloudAgentTaskSource): string | undefined {
  switch (source.providerId) {
    case "github":
      return source.repo
        ? `${source.repo}${source.externalId ? `#${source.externalId}` : ""}`
        : undefined;
    case "linear":
      return source.teamKey ?? source.project;
    case "slack":
      return source.channel ? `#${source.channel}` : undefined;
    default:
      return undefined;
  }
}

function describeSource(source: CloudAgentTaskSource): string {
  const parts: string[] = [];
  if (source.providerId !== "manual") {
    parts.push(`Source: ${source.providerId}`);
  } else {
    parts.push("Source: manual dispatch");
  }
  if (source.repo) parts.push(`Repository: ${source.repo}`);
  if (source.teamKey) parts.push(`Linear team: ${source.teamKey}`);
  if (source.project) parts.push(`Project: ${source.project}`);
  if (source.channel) parts.push(`Slack channel: ${source.channel}`);
  if (source.labels?.length) parts.push(`Labels: ${source.labels.join(", ")}`);
  if (source.sender) parts.push(`Requested by: ${source.sender}`);
  if (source.url) parts.push(`Link: ${source.url}`);
  return parts.join("\n");
}

/**
 * Composes the harness prompt for the working agent: the task itself plus the
 * Cloud Agents operating contract (branch discipline, demo artifacts, and how
 * steering follow-ups arrive).
 */
export function buildCloudAgentTaskPrompt(
  task: CloudAgentTaskRecord,
  options: { branch: string | null; artifactsDir: string }
): string {
  const lines: string[] = [
    `You are working on a Cloud Agents task offloaded from an external tracker.`,
    ``,
    `# Task: ${task.title}`,
    ``,
    describeSource(task.source),
    ``,
    `## Instructions`,
    task.prompt.trim() || "(No further body was provided; use the title and source link.)",
    ``,
    `## Cloud Agents operating contract`,
    options.branch
      ? `- You are working on an isolated git branch (\`${options.branch}\`) inside a dedicated worktree. Commit your work here; never touch the main checkout. Push the branch and open a PR when the repository has a remote configured, so the requester can review and merge when comfortable.`
      : `- You are working directly in the workspace ("local" mode was requested). Make focused commits and describe exactly what changed.`,
    `- When a visual or behavioral change is worth demonstrating, save demonstration media (screen recordings, screenshots, generated GIFs, or annotated logs) under \`${options.artifactsDir}\` in the workspace. Files placed there are surfaced back to Linear, GitHub, or Slack by the Cloud Agents panel.`,
    `- Summarize what you did, how you verified it, and any open questions at the end of each turn. The requester can steer you with follow-up messages, so ask concrete questions when you are blocked instead of guessing.`,
  ];
  return lines.join("\n");
}

async function prepareIsolatedWorkspace(
  task: CloudAgentTaskRecord,
  workspace: WorkspaceRecord
): Promise<{ runWorkspace: WorkspaceRecord; branch: string; worktreePath: string } | null> {
  const branch = buildCloudAgentBranchName(task);
  const workspaces = await listWorkspaces();
  try {
    const worktree = await createWorkspaceWorktree({
      workspace,
      workspaces,
      branch,
      newBranch: true,
      runSetup: false,
    });
    const runWorkspace = await ensureWorkspaceRegistered(
      worktree.path,
      `${workspace.name} · ${branch}`,
      { trackOpen: false }
    );
    return { runWorkspace, branch: worktree.branch, worktreePath: worktree.path };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Non-git workspaces cannot be isolated; fall back to local mode with a note.
    await appendCloudAgentTaskTimeline(task.id, {
      kind: "status",
      message: `Isolated worktree unavailable (${message}); running in local mode instead.`,
    });
    return null;
  }
}

export async function ingestCloudAgentAssignment(
  assignment: CloudAgentInboundAssignment
): Promise<{ task: CloudAgentTaskRecord; dispatched: boolean; steered?: boolean }> {
  // Follow-up comments/replies on an already-tracked issue or thread steer the
  // existing conversation — the "communicative" loop — instead of duplicating.
  const steerable = await findSteerableCloudAgentTaskBySource(assignment.source);
  if (steerable) {
    try {
      const attribution = assignment.source.sender
        ? `Follow-up from ${assignment.source.sender} via ${assignment.providerId}:`
        : `Follow-up via ${assignment.providerId}:`;
      const task = await steerCloudAgentTask(
        steerable.id,
        `${attribution}\n\n${assignment.body}`
      );
      return { task, dispatched: false, steered: true };
    } catch {
      // Conversation may be gone; fall through and treat it as a new task.
    }
  }

  const settings = await getCloudAgentSettings();
  const route = await resolveCloudAgentRoute(assignment.source);
  let task = await createCloudAgentTask({
    title: assignment.title,
    prompt: assignment.body,
    status: "inbox",
    source: assignment.source,
    ...(assignment.verified ? {} : { unverified: true }),
    workspaceId: route.workspaceId,
    conversationId: null,
    backendId: route.backendId,
    modelId: route.modelId,
    executionMode: route.executionMode,
    timeline: [
      {
        at: Date.now(),
        kind: "received",
        message: `Received from ${assignment.providerId}${
          assignment.verified ? "" : " (signature not verified)"
        }${route.matchedRuleId ? `; matched routing rule ${route.matchedRuleId}` : ""}.`,
      },
    ],
  });

  if (settings.defaults.autoDispatch && task.workspaceId) {
    try {
      task = await dispatchCloudAgentTask(task.id, {});
      return { task, dispatched: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      task = await updateCloudAgentTask(task.id, { lastError: message });
      await appendCloudAgentTaskTimeline(task.id, {
        kind: "error",
        message: `Auto-dispatch failed: ${message}`,
      });
      task = (await getCloudAgentTask(task.id)) ?? task;
      return { task, dispatched: false };
    }
  }
  return { task, dispatched: false };
}

export async function dispatchCloudAgentTask(
  taskId: string,
  overrides: {
    workspaceId?: string;
    backendId?: AgentBackendId;
    modelId?: string;
    executionMode?: CloudAgentExecutionMode;
  }
): Promise<CloudAgentTaskRecord> {
  let task = await getCloudAgentTask(taskId);
  if (!task) {
    throw new Error(`Unknown Cloud Agent task: ${taskId}`);
  }
  if (task.status !== "inbox" && task.status !== "failed") {
    throw new Error(`Task is ${task.status}; only inbox or failed tasks can be dispatched.`);
  }

  const workspaceId = overrides.workspaceId ?? task.workspaceId;
  if (!workspaceId) {
    throw new Error(
      "No target workspace. Add a routing rule or set a default workspace in Cloud Agents settings."
    );
  }
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace: ${workspaceId}`);
  }

  const backendId = overrides.backendId ?? task.backendId ?? "cesium-agent";
  const modelId = overrides.modelId ?? task.modelId;
  const executionMode = overrides.executionMode ?? task.executionMode;

  task = await updateCloudAgentTask(taskId, {
    status: "dispatching",
    workspaceId,
    backendId,
    modelId: modelId ?? null,
    executionMode,
    lastError: null,
  });

  try {
    let runWorkspace = workspace;
    let branch: string | null = null;
    let worktreePath: string | null = null;
    if (executionMode === "isolated") {
      const isolated = await prepareIsolatedWorkspace(task, workspace);
      if (isolated) {
        runWorkspace = isolated.runWorkspace;
        branch = isolated.branch;
        worktreePath = isolated.worktreePath;
      }
    }

    const prompt = buildCloudAgentTaskPrompt(task, {
      branch,
      artifactsDir: `${CLOUD_AGENT_ARTIFACTS_DIR}/${task.id}`,
    });
    const originLabel = buildCloudAgentOriginLabel(task.source);
    const snapshot = await agentRuntimeManager.createConversationWithPrompt(
      runWorkspace,
      {
        title: task.title.slice(0, 120),
        backendId,
        ...(modelId ? { modelId } : {}),
        origin: {
          kind: "cloud",
          providerId: task.source.providerId,
          taskId: task.id,
          ...(originLabel ? { label: originLabel } : {}),
          ...(task.source.url ? { url: task.source.url } : {}),
        },
      },
      { text: prompt }
    );

    task = await updateCloudAgentTask(taskId, {
      status: "running",
      runWorkspaceId: runWorkspace.id,
      conversationId: snapshot.conversation.id,
      branch,
      worktreePath,
    });
    await appendCloudAgentTaskTimeline(taskId, {
      kind: "dispatched",
      message: `Dispatched to ${backendId}${modelId ? ` (${modelId})` : ""} in workspace "${runWorkspace.name}"${branch ? ` on branch ${branch}` : ""}.`,
    });
    return (await getCloudAgentTask(taskId)) ?? task;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateCloudAgentTask(taskId, { status: "failed", lastError: message });
    await appendCloudAgentTaskTimeline(taskId, {
      kind: "error",
      message: `Dispatch failed: ${message}`,
    });
    throw error;
  }
}

/**
 * Sends a steering/follow-up message from the upper Cloud Agents abstraction
 * to the working agent. Queued as a steer when a turn is already running.
 */
export async function steerCloudAgentTask(
  taskId: string,
  text: string
): Promise<CloudAgentTaskRecord> {
  const task = await getCloudAgentTask(taskId);
  if (!task) {
    throw new Error(`Unknown Cloud Agent task: ${taskId}`);
  }
  if (!task.conversationId || !(task.runWorkspaceId ?? task.workspaceId)) {
    throw new Error("Task has no active conversation to steer.");
  }
  const workspace = await getWorkspaceById(task.runWorkspaceId ?? task.workspaceId!);
  if (!workspace) {
    throw new Error("The task's workspace no longer exists.");
  }
  await agentRuntimeManager.promptConversation(
    workspace,
    task.conversationId,
    text,
    undefined,
    { delivery: "steer" }
  );
  await updateCloudAgentTask(taskId, { status: "running", lastError: null });
  await appendCloudAgentTaskTimeline(taskId, {
    kind: "steered",
    message: `Steering message sent: ${text.slice(0, 140)}${text.length > 140 ? "…" : ""}`,
  });
  return (await getCloudAgentTask(taskId))!;
}

export async function cancelCloudAgentTask(taskId: string): Promise<CloudAgentTaskRecord> {
  const task = await getCloudAgentTask(taskId);
  if (!task) {
    throw new Error(`Unknown Cloud Agent task: ${taskId}`);
  }
  if (task.conversationId && (task.runWorkspaceId ?? task.workspaceId)) {
    const workspace = await getWorkspaceById(task.runWorkspaceId ?? task.workspaceId!);
    if (workspace) {
      await agentRuntimeManager
        .cancelConversation(workspace, task.conversationId)
        .catch(() => undefined);
    }
  }
  await updateCloudAgentTask(taskId, { status: "cancelled" });
  await appendCloudAgentTaskTimeline(taskId, {
    kind: "status",
    message: "Task cancelled.",
  });
  return (await getCloudAgentTask(taskId))!;
}

export async function completeCloudAgentTask(taskId: string): Promise<CloudAgentTaskRecord> {
  const task = await getCloudAgentTask(taskId);
  if (!task) {
    throw new Error(`Unknown Cloud Agent task: ${taskId}`);
  }
  await updateCloudAgentTask(taskId, { status: "completed" });
  await appendCloudAgentTaskTimeline(taskId, {
    kind: "status",
    message: "Task marked completed.",
  });
  return (await getCloudAgentTask(taskId))!;
}

/** Lists demonstration artifacts the agent saved for a task. */
export async function listCloudAgentTaskArtifacts(
  taskId: string
): Promise<Array<{ name: string; size: number; modifiedAt: number }>> {
  const task = await getCloudAgentTask(taskId);
  if (!task) {
    throw new Error(`Unknown Cloud Agent task: ${taskId}`);
  }
  const workspaceId = task.runWorkspaceId ?? task.workspaceId;
  if (!workspaceId) {
    return [];
  }
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    return [];
  }
  const dir = path.join(workspace.root, CLOUD_AGENT_ARTIFACTS_DIR, task.id);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const stat = await fs.stat(path.join(dir, entry.name));
          return { name: entry.name, size: stat.size, modifiedAt: stat.mtimeMs };
        })
    );
    return files.sort((a, b) => b.modifiedAt - a.modifiedAt);
  } catch {
    return [];
  }
}

let taskSyncStarted = false;

/**
 * Mirrors the working conversation's status onto its Cloud Agent task:
 * running turns keep the task `running`, a finished turn flips it to
 * `awaiting_review` so the requester can inspect, steer, or complete it.
 */
export function startCloudAgentTaskSyncListener(): void {
  if (taskSyncStarted) {
    return;
  }
  taskSyncStarted = true;
  subscribeAgentStoreEvents((event) => {
    if (event.type !== "conversation") {
      return;
    }
    const conversation = event.conversation;
    void (async () => {
      const task = await findCloudAgentTaskByConversation(conversation.id).catch(() => null);
      if (!task) {
        return;
      }
      if (
        conversation.status === "idle" &&
        task.status === "running"
      ) {
        // A finished turn supersedes any earlier failure (e.g. a task revived
        // through steering); clear the stale error alongside the status flip.
        await updateCloudAgentTask(task.id, {
          status: "awaiting_review",
          lastError: null,
        }).catch(() => undefined);
        await appendCloudAgentTaskTimeline(task.id, {
          kind: "turn_completed",
          message: "Agent turn finished; task is awaiting review. Steer it or mark it complete.",
        }).catch(() => undefined);
      } else if (conversation.status === "failed" && task.status === "running") {
        await updateCloudAgentTask(task.id, {
          status: "failed",
          lastError: conversation.lastError ?? "Agent turn failed.",
        }).catch(() => undefined);
        await appendCloudAgentTaskTimeline(task.id, {
          kind: "error",
          message: conversation.lastError ?? "Agent turn failed.",
        }).catch(() => undefined);
      } else if (
        (conversation.status === "running" || conversation.status === "awaiting_permission" || conversation.status === "awaiting_question") &&
        task.status === "awaiting_review"
      ) {
        await updateCloudAgentTask(task.id, { status: "running" }).catch(() => undefined);
      }
    })();
  });
}
