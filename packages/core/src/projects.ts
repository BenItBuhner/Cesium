import type { AgentConversationStatus } from "./protocol";

/**
 * Wire types and pure helpers for Cesium Projects: one orchestrator chat that
 * creates, steers and reports on child agents across harnesses and engines.
 */

/** Engine id that always refers to the engine hosting the Project. */
export const PROJECT_HOME_ENGINE_ID = "home";

/** XML tag wrapping coalesced child reports delivered to the orchestrator. */
export const PROJECT_AGENT_UPDATES_TAG = "project_agent_updates";

/** `displayContent` prefix of an orchestrator turn that carries child reports. */
export const PROJECT_NOTICE_DISPLAY_PREFIX = "Agent update · ";

export type ProjectChildBucket =
  | "working"
  | "needs_attention"
  | "idle"
  | "stopped"
  | "failed"
  | "deleted";

/** How a steer or queued message actually landed on a child. */
export type ProjectAgentDelivery = "mid_turn" | "queued_steer" | "queued" | "started";

export type ProjectRepoBinding = {
  id: string;
  name: string;
  engineId: string;
  workspaceId: string;
  root: string;
};

export type ProjectEngineSummary = {
  id: string;
  label: string;
  kind: "home" | "peer";
  baseUrl: string | null;
  online: boolean;
  error: string | null;
  instanceId: string | null;
  lastSeenAt: number | null;
};

export type ProjectHarnessInfo = {
  id: string;
  label: string;
  available: boolean;
  defaultModelId: string;
};

export type ProjectWorkspaceInfo = { id: string; name: string; root: string };

/** One engine as a Project sees it: bound repos, runnable harnesses, bindable workspaces. */
export type ProjectEngineListing = ProjectEngineSummary & {
  repos: Array<Pick<ProjectRepoBinding, "id" | "name" | "root">>;
  harnesses: ProjectHarnessInfo[];
  workspaces: ProjectWorkspaceInfo[];
};

/** A token this engine minted so another engine can run Project agents here. */
export type ProjectPeerTokenSummary = {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
};

export type ProjectChildAttention = {
  kind: "permission" | "question";
  title: string;
};

export type ProjectChildSummary = {
  id: string;
  name: string;
  engineId: string;
  engineLabel: string;
  repoId: string | null;
  repoName: string | null;
  workspaceId: string;
  conversationId: string;
  backendId: string;
  modelId: string | null;
  modelName: string | null;
  mode: string;
  status: AgentConversationStatus | "unknown";
  bucket: ProjectChildBucket;
  queued: number;
  turnsCompleted: number;
  lastReplyPreview: string | null;
  lastError: string | null;
  attention: ProjectChildAttention | null;
  createdBy: "orchestrator" | "user";
  createdAt: number;
  updatedAt: number | null;
  deletedAt: number | null;
};

export type ProjectOrchestratorSummary = {
  conversationId: string;
  workspaceId: string;
  status: AgentConversationStatus | "unknown";
  modelId: string | null;
  modelName: string | null;
  queued: number;
};

export type ProjectSettings = {
  defaultChildBackendId: string | null;
  defaultChildModelId: string | null;
  maxActiveChildren: number;
};

export type ProjectSummary = {
  id: string;
  name: string;
  icon: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  orchestratorStatus: AgentConversationStatus | "unknown";
  orchestratorConversationId: string;
  orchestratorWorkspaceId: string;
  repoCount: number;
  agentCount: number;
  workingCount: number;
  attentionCount: number;
  /** Turns finished across every agent, deleted ones included; it only grows. */
  turnsCompleted: number;
};

export type ProjectSnapshot = {
  id: string;
  name: string;
  icon: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  contextRoot: string;
  orchestrator: ProjectOrchestratorSummary;
  repos: ProjectRepoBinding[];
  children: ProjectChildSummary[];
  engines: ProjectEngineSummary[];
  settings: ProjectSettings;
};

export type ProjectContextFile = {
  path: string;
  size: number;
  updatedAt: number;
};

const BUSY_STATUSES = new Set<string>([
  "running",
  "pause_requested",
  "pausing",
  "paused",
  "awaiting_permission",
  "awaiting_question",
]);

export function isProjectChildBusy(status: string): boolean {
  return BUSY_STATUSES.has(status);
}

export function projectChildBucket(input: {
  status: string;
  deletedAt?: number | null;
}): ProjectChildBucket {
  if (input.deletedAt != null) {
    return "deleted";
  }
  switch (input.status) {
    case "awaiting_permission":
    case "awaiting_question":
      return "needs_attention";
    case "running":
    case "pause_requested":
    case "pausing":
    case "paused":
      return "working";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
    default:
      return "idle";
  }
}

const BUCKET_LABELS: Record<ProjectChildBucket, string> = {
  working: "Working",
  needs_attention: "Needs you",
  idle: "Idle",
  stopped: "Stopped",
  failed: "Failed",
  deleted: "Deleted",
};

export function projectChildBucketLabel(bucket: ProjectChildBucket): string {
  return BUCKET_LABELS[bucket];
}

const BUCKET_ORDER: Record<ProjectChildBucket, number> = {
  needs_attention: 0,
  working: 1,
  failed: 2,
  idle: 3,
  stopped: 4,
  deleted: 5,
};

/** Attention first, then running work, then the rest by recent activity. */
export function sortProjectChildren<
  T extends Pick<ProjectChildSummary, "bucket" | "updatedAt" | "createdAt" | "name">,
>(children: readonly T[]): T[] {
  return [...children].sort(
    (a, b) =>
      BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] ||
      (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt) ||
      a.name.localeCompare(b.name)
  );
}

/** Child handles referenced by an "Agent update · a, b" orchestrator turn. */
export function parseProjectNoticeNames(displayContent: string | null | undefined): string[] {
  if (!displayContent?.startsWith(PROJECT_NOTICE_DISPLAY_PREFIX)) {
    return [];
  }
  return displayContent
    .slice(PROJECT_NOTICE_DISPLAY_PREFIX.length)
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

export function formatProjectNoticeDisplay(names: readonly string[]): string {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  return `${PROJECT_NOTICE_DISPLAY_PREFIX}${unique.join(", ")}`;
}

/** Short status line for a Project row: "3 agents · 1 working · 1 needs you". */
export function projectSummaryStatusLine(
  summary: Pick<ProjectSummary, "agentCount" | "workingCount" | "attentionCount">
): string {
  if (summary.agentCount === 0) {
    return "No agents yet";
  }
  const parts = [`${summary.agentCount} ${summary.agentCount === 1 ? "agent" : "agents"}`];
  if (summary.workingCount > 0) {
    parts.push(`${summary.workingCount} working`);
  }
  if (summary.attentionCount > 0) {
    parts.push(`${summary.attentionCount} ${summary.attentionCount === 1 ? "needs" : "need"} you`);
  }
  return parts.join(" · ");
}

/** A Project as listed by one of the engines the client is connected to. */
export type ProjectListing = ProjectSummary & { serverId: string; serverLabel: string };

/** One engine's answer to a Project list request; `projects` is null when the request failed. */
export type ProjectServerListing = {
  serverId: string;
  serverLabel: string;
  projects: readonly ProjectSummary[] | null;
  error?: string | null;
};

/**
 * Merges per-engine Project lists, newest first. An engine whose request failed
 * keeps what it listed last time so one blip doesn't empty the sidebar, while an
 * engine that wasn't asked drops out. The first engine to list an id owns it, so
 * callers put the active engine first. The error only surfaces when no engine
 * answered.
 */
export function mergeProjectListings(
  previous: readonly ProjectListing[],
  results: readonly ProjectServerListing[]
): { projects: ProjectListing[]; error: string | null } {
  const merged: ProjectListing[] = [];
  const seen = new Set<string>();
  let answered = false;
  let error: string | null = null;
  for (const result of results) {
    const listed: readonly ProjectSummary[] = result.projects
      ? result.projects
      : previous.filter((project) => project.serverId === result.serverId);
    if (result.projects) {
      answered = true;
    } else {
      error ??= result.error?.trim() || `Could not load Projects from ${result.serverLabel}.`;
    }
    for (const project of listed) {
      if (seen.has(project.id)) {
        continue;
      }
      seen.add(project.id);
      merged.push({ ...project, serverId: result.serverId, serverLabel: result.serverLabel });
    }
  }
  merged.sort((a, b) => b.updatedAt - a.updatedAt);
  return { projects: merged, error: answered ? null : error };
}

export type ProjectChildMark = { turnsCompleted: number; bucket: ProjectChildBucket };

export type ProjectChildChange =
  | { kind: "finished"; child: ProjectChildSummary; turns: number }
  | { kind: "attention"; child: ProjectChildSummary };

/**
 * Compares fresh children with the marks from the last look. The first look at
 * a Project only records marks; a child created since the last look counts from
 * zero, so one that started and finished between polls still reports.
 */
export function diffProjectChildren(
  previous: ReadonlyMap<string, ProjectChildMark> | undefined,
  children: readonly ProjectChildSummary[]
): { changes: ProjectChildChange[]; marks: Map<string, ProjectChildMark> } {
  const marks = new Map<string, ProjectChildMark>();
  const changes: ProjectChildChange[] = [];
  for (const child of children) {
    marks.set(child.id, { turnsCompleted: child.turnsCompleted, bucket: child.bucket });
    if (!previous || child.deletedAt != null) {
      continue;
    }
    const before = previous.get(child.id) ?? { turnsCompleted: 0, bucket: "idle" };
    const turns = child.turnsCompleted - before.turnsCompleted;
    if (turns > 0) {
      changes.push({ kind: "finished", child, turns });
    }
    if (child.bucket === "needs_attention" && before.bucket !== "needs_attention") {
      changes.push({ kind: "attention", child });
    }
  }
  return { changes, marks };
}

const NOTICE_PREVIEW_CHARS = 220;

function clipNoticeText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > NOTICE_PREVIEW_CHARS ? `${flat.slice(0, NOTICE_PREVIEW_CHARS - 1)}…` : flat;
}

/** Toast copy for one child change. */
export function projectChildChangeNotice(change: ProjectChildChange): {
  title: string;
  message: string;
  severity: "info" | "warning" | "error";
} {
  const { child } = change;
  if (change.kind === "attention") {
    return {
      title: `${child.name} needs you`,
      message: child.attention?.title ?? "Waiting for a permission or an answer.",
      severity: "warning",
    };
  }
  if (child.bucket === "failed") {
    return {
      title: `${child.name} failed`,
      message: clipNoticeText(child.lastError ?? "The turn ended with an error."),
      severity: "error",
    };
  }
  return {
    title: change.turns > 1 ? `${child.name} finished ${change.turns} turns` : `${child.name} finished`,
    message: clipNoticeText(child.lastReplyPreview ?? "") || "Finished without a reply.",
    severity: "info",
  };
}

export function isProjectChildRemote(child: Pick<ProjectChildSummary, "engineId">): boolean {
  return child.engineId !== PROJECT_HOME_ENGINE_ID;
}

const DELIVERY_LABELS: Record<ProjectAgentDelivery, string> = {
  mid_turn: "Steered into the running turn",
  queued_steer: "Runs right after the current turn",
  queued: "Queued as the next turn",
  started: "Started a new turn",
};

export function projectDeliveryLabel(delivery: ProjectAgentDelivery): string {
  return DELIVERY_LABELS[delivery] ?? delivery;
}

/** Engine URLs compare without case, trailing slashes or a default port. */
export function sameProjectEngineUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  const key = (raw: string | null | undefined) => {
    const trimmed = raw?.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const url = new URL(trimmed);
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
    } catch {
      return trimmed.replace(/\/+$/, "").toLowerCase();
    }
  };
  const left = key(a);
  return left != null && left === key(b);
}

/** Normalized agent handle: lowercase letters, digits and dashes. */
export function normalizeProjectAgentName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
