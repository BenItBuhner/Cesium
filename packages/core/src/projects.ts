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

/**
 * Where a worker's files live: its own git worktree on its own branch (the
 * default for a repository), the repository checkout itself (only on request),
 * or an empty scratch folder (no repository).
 */
export type ProjectAgentIsolation = "worktree" | "checkout" | "scratch";

export const PROJECT_AGENT_ISOLATIONS: readonly ProjectAgentIsolation[] = [
  "worktree",
  "checkout",
  "scratch",
];

export function isProjectAgentIsolation(value: unknown): value is ProjectAgentIsolation {
  return typeof value === "string" && (PROJECT_AGENT_ISOLATIONS as readonly string[]).includes(value);
}

export type ProjectRepoBinding = {
  id: string;
  name: string;
  engineId: string;
  workspaceId: string;
  root: string;
  /** Branch workers start from; null means the remote's default branch. */
  baseBranch?: string | null;
  /** `owner/repo` on GitHub; null means derived from each worker's `origin` remote. */
  githubRepo?: string | null;
};

export type ProjectPullRequestState = "open" | "closed" | "merged";
export type ProjectPullRequestCi = "pending" | "success" | "failure";
export type ProjectPullRequestReview = "approved" | "changes_requested" | "commented";

/** A pull request a Project tracks: a worker's own, or one it was told to follow. */
export type ProjectPullRequest = {
  /** `owner/repo`. */
  repo: string;
  number: number;
  url: string;
  title: string;
  state: ProjectPullRequestState;
  draft: boolean;
  headRef: string;
  baseRef: string;
  headSha: string | null;
  ci: ProjectPullRequestCi | null;
  failedChecks: string[];
  review: ProjectPullRequestReview | null;
  mergeable: boolean | null;
  /** True when the Project opened it for a worker that pushed without one. */
  openedByProject: boolean;
  updatedAt: number;
};

/** A PR row for lists: which agent owns it, if any. */
export type ProjectPullRequestListing = ProjectPullRequest & { agent: string | null };

/** `ask`: merge only on the user's explicit word. `when_green`: the coordinator may merge green PRs. */
export type ProjectMergePolicy = "ask" | "when_green";
export type ProjectPrMode = "ready" | "draft";

export type ProjectSubscriptionKind = "github_pr" | "github_ci" | "timer";

/** An event source the coordinator listens to (the "Listening" list). */
export type ProjectSubscriptionSummary = {
  id: string;
  kind: ProjectSubscriptionKind;
  label: string;
  detail: string | null;
  createdBy: "coordinator" | "auto" | "user";
  /** Agent that owns what is watched (its PR or branch). */
  agent: string | null;
  createdAt: number;
  expiresAt: number;
  nextFireAt: number | null;
  lastEventAt: number | null;
  closedAt: number | null;
  closedReason: string | null;
};

/** `displayContent` prefix of an orchestrator turn that carries external events. */
export const PROJECT_EVENT_DISPLAY_PREFIX = "Project event · ";

const EVENT_LABELS_SHOWN = 4;

export function formatProjectEventDisplay(labels: readonly string[]): string {
  const unique = [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
  const shown = unique.slice(0, EVENT_LABELS_SHOWN);
  const more = unique.length - shown.length;
  return `${PROJECT_EVENT_DISPLAY_PREFIX}${shown.join(", ")}${more > 0 ? ` +${more} more` : ""}`;
}

export function isProjectEventDisplay(displayContent: string | null | undefined): boolean {
  return Boolean(displayContent?.startsWith(PROJECT_EVENT_DISPLAY_PREFIX));
}

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

/**
 * How Projects name an engine to people and to the orchestrator: its label,
 * with the id appended only when another engine shares that label. An id no
 * listed engine owns (a peer removed since) stays as the id.
 */
export function projectEngineName(
  engineId: string,
  engines: readonly Pick<ProjectEngineSummary, "id" | "label">[]
): string {
  const engine = engines.find((entry) => entry.id === engineId);
  const label = engine?.label.trim();
  if (!label) {
    return engineId;
  }
  const lowered = label.toLowerCase();
  const shared = engines.some(
    (other) => other.id !== engineId && other.label.trim().toLowerCase() === lowered
  );
  return shared ? `${label} (${engineId})` : label;
}

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
  isolation: ProjectAgentIsolation;
  /** The worker's own branch (worktree isolation), else null. */
  branch: string | null;
  /** Ref the branch was created from, e.g. `origin/main`. */
  baseRef: string | null;
  worktreePath: string | null;
  archivedAt: number | null;
  /** `owner/repo` its branch is pushed to, when that is GitHub. */
  githubRepo: string | null;
  pr: ProjectPullRequest | null;
  /** Workers do the Project's work; helpers are short typed errands (code search, browser checks). */
  kind: ProjectAgentKind;
  helperKind: ProjectHelperKind | null;
  /** Set once a worker's branch changes what users see. */
  evidence: ProjectChildEvidence | null;
};

export type ProjectAgentKind = "worker" | "helper";
export type ProjectHelperKind = "explore" | "browser";

/**
 * Whether a worker's change to what users see came with screenshots or a
 * recording, as checked when its turns end.
 */
export type ProjectChildEvidence = {
  /** UI files its branch changes (pages, components, styles, markup). */
  uiFiles: string[];
  /**
   * Screenshots and recordings in the Project context: its own `media/<agent>/`
   * and those of browser checks that ran in its working tree. Empty means missing.
   */
  files: string[];
  /** When the Project asked it for the missing evidence; null once it arrived. */
  requestedAt: number | null;
  checkedAt: number;
};

const UI_FILE_EXTENSIONS = new Set(["html", "htm", "css", "scss", "sass", "less", "jsx", "tsx", "vue", "svelte", "astro"]);
/** Code and assets count as UI only inside these folders. */
const UI_FOLDERS = new Set(["components", "pages", "views", "templates", "layouts", "public", "static", "styles", "ui"]);
const UI_FOLDER_EXTENSIONS = new Set(["js", "mjs", "cjs", "ts", "mts", "svg", "png", "jpg", "jpeg", "gif", "webp", "ico"]);
const NOT_UI_PATH = /(^|\/)(__tests__|__mocks__|tests?|e2e|spec|fixtures)\/|\.(test|spec|stories)\.[^/]+$|\.d\.ts$/i;
const EVIDENCE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "mp4", "webm", "mov"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov"]);

function fileExtension(filePath: string): string {
  const base = filePath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Whether a changed repository file is part of what users see: markup, styles, components, pages. Tests are not. */
export function isProjectUiPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || NOT_UI_PATH.test(normalized)) {
    return false;
  }
  const extension = fileExtension(normalized);
  if (UI_FILE_EXTENSIONS.has(extension)) {
    return true;
  }
  const folders = normalized.split("/").slice(0, -1).map((segment) => segment.toLowerCase());
  return UI_FOLDER_EXTENSIONS.has(extension) && folders.some((folder) => UI_FOLDERS.has(folder));
}

/** Screenshots and recordings (what counts as evidence for a UI change). */
export function isProjectEvidencePath(filePath: string): boolean {
  return EVIDENCE_EXTENSIONS.has(fileExtension(filePath.replace(/\\/g, "/")));
}

/** Markdown that shows a Project context file in a coordinator message: an image embed, or a link for a recording. */
export function projectEvidenceEmbed(contextPath: string): string {
  const name = (contextPath.split("/").pop() ?? contextPath).replace(/[[\]\\]/g, "\\$&");
  const encoded = encodeURI(contextPath).replace(/[()#?]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const target = `context:${encoded}`;
  return VIDEO_EXTENSIONS.has(fileExtension(contextPath)) ? `[${name}](${target})` : `![${name}](${target})`;
}

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
  mergePolicy: ProjectMergePolicy;
  prMode: ProjectPrMode;
  /** Open a PR for a worker that pushed its branch without one. */
  autoCreatePr: boolean;
  /** Follow every worker PR and its CI without being asked. */
  autoSubscribe: boolean;
  /** New agents run commands, edit files and use tools in their own folder without asking. */
  autoApproveAgents: boolean;
};

export const DEFAULT_PROJECT_SETTINGS_VALUES: ProjectSettings = {
  defaultChildBackendId: null,
  defaultChildModelId: null,
  maxActiveChildren: 8,
  mergePolicy: "ask",
  prMode: "ready",
  autoCreatePr: true,
  autoSubscribe: true,
  autoApproveAgents: true,
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
  /** Name of the engine that hosts the Project; engines from before it was listed omit it. */
  engineLabel?: string;
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
  /** Open subscriptions (the Listening list). */
  subscriptions: ProjectSubscriptionSummary[];
};

export type ProjectContextFileKind = "text" | "image" | "video" | "binary";

export type ProjectContextFile = {
  path: string;
  size: number;
  updatedAt: number;
  kind: ProjectContextFileKind;
};

/** Folders every Project's Context starts with, next to `notes.md`. */
export const PROJECT_CONTEXT_FOLDERS = ["docs", "internal", "media"] as const;

const CONTEXT_IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

const CONTEXT_VIDEO_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
};

const CONTEXT_TEXT_TYPES: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  jsonl: "application/x-ndjson; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  yaml: "text/yaml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
  html: "text/plain; charset=utf-8",
  diff: "text/plain; charset=utf-8",
  patch: "text/plain; charset=utf-8",
};

function contextExtension(filePath: string): string {
  const base = filePath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Kind by extension; `null` when only the bytes can tell (unknown extensions). */
export function projectContextKindFromPath(filePath: string): ProjectContextFileKind | null {
  const ext = contextExtension(filePath);
  if (ext in CONTEXT_IMAGE_TYPES) {
    return "image";
  }
  if (ext in CONTEXT_VIDEO_TYPES) {
    return "video";
  }
  if (ext in CONTEXT_TEXT_TYPES) {
    return "text";
  }
  return null;
}

/**
 * Content type a Context file is served with. HTML is served as plain text so
 * an uploaded page can never run in the engine's origin.
 */
export function projectContextContentType(filePath: string, kind: ProjectContextFileKind): string {
  const ext = contextExtension(filePath);
  return (
    CONTEXT_IMAGE_TYPES[ext] ??
    CONTEXT_VIDEO_TYPES[ext] ??
    CONTEXT_TEXT_TYPES[ext] ??
    (kind === "text" ? "text/plain; charset=utf-8" : "application/octet-stream")
  );
}

/** Lowercase dash slug, for branch and folder names. */
export function projectSlug(raw: string, max = 24): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/** `cesium/<project>/<agent>-<suffix>`: every worker's own branch. */
export function projectWorkerBranchName(projectName: string, agentName: string, suffix: string): string {
  const project = projectSlug(projectName) || "project";
  const agent = projectSlug(agentName, 40) || "agent";
  return `cesium/${project}/${agent}-${suffix}`;
}

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

/** The engine's own name for itself, else the client's name for the connection. */
export function projectListingEngineName(listing: Pick<ProjectListing, "engineLabel" | "serverLabel">): string {
  return listing.engineLabel?.trim() || listing.serverLabel;
}

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
