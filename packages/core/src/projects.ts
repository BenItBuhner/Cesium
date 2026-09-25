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
  repoCount: number;
  agentCount: number;
  workingCount: number;
  attentionCount: number;
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

/** Normalized agent handle: lowercase letters, digits and dashes. */
export function normalizeProjectAgentName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
