import { buildWorkedSessionLabel } from "./agent-chat";
import type { AgentStoredEvent } from "./protocol";
import {
  PROJECT_EVENT_DISPLAY_PREFIX,
  PROJECT_NOTICE_DISPLAY_PREFIX,
  projectContextKindFromPath,
  type ProjectContextFile,
  type ProjectContextFileKind,
  type ProjectPullRequest,
  type ProjectSubscriptionSummary,
} from "./projects";
import type { ChatMessage, WorkedSessionEntry } from "./types";

// ---------------------------------------------------------------------------
// Page location: `?view=project&project=<id>&tab=<tab>`

export const PROJECT_PAGE_VIEW = "project";
export const PROJECT_PAGE_TABS = ["agents", "prs", "context", "setup"] as const;
export type ProjectPageTab = (typeof PROJECT_PAGE_TABS)[number];

export type ProjectPageLocation = { projectId: string; tab: ProjectPageTab };

const PROJECT_ID_PATTERN = /^prj_[a-f0-9]{12}$/;

export function isProjectPageTab(value: unknown): value is ProjectPageTab {
  return typeof value === "string" && (PROJECT_PAGE_TABS as readonly string[]).includes(value);
}

/** The Project page a URL points at, or null when it is not one. */
export function parseProjectPageSearch(params: {
  get(name: string): string | null;
}): ProjectPageLocation | null {
  if (params.get("view") !== PROJECT_PAGE_VIEW) {
    return null;
  }
  const projectId = params.get("project")?.trim() ?? "";
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    return null;
  }
  const tab = params.get("tab");
  return { projectId, tab: isProjectPageTab(tab) ? tab : "agents" };
}

/** Points the search params at a Project page, or (null) drops the Project page params. */
export function applyProjectPageSearch(params: URLSearchParams, location: ProjectPageLocation | null): void {
  if (location) {
    params.set("view", PROJECT_PAGE_VIEW);
    params.set("project", location.projectId);
    params.set("tab", location.tab);
    return;
  }
  if (params.get("view") === PROJECT_PAGE_VIEW) {
    params.delete("view");
    params.delete("project");
    params.delete("tab");
  }
}

// ---------------------------------------------------------------------------
// Pull requests and Listening

export type ProjectBadgeTone = "neutral" | "accent" | "success" | "warning" | "error";
export type ProjectBadge = { label: string; tone: ProjectBadgeTone };

export function projectPullRequestStateBadge(pr: Pick<ProjectPullRequest, "state" | "draft">): ProjectBadge {
  if (pr.state === "merged") {
    return { label: "Merged", tone: "accent" };
  }
  if (pr.state === "closed") {
    return { label: "Closed", tone: "neutral" };
  }
  return pr.draft ? { label: "Draft", tone: "neutral" } : { label: "Open", tone: "success" };
}

export function projectPullRequestCiBadge(
  pr: Pick<ProjectPullRequest, "ci" | "failedChecks">
): ProjectBadge | null {
  switch (pr.ci) {
    case "success":
      return { label: "CI passed", tone: "success" };
    case "pending":
      return { label: "CI running", tone: "warning" };
    case "failure": {
      const [first, ...rest] = pr.failedChecks;
      return {
        label: first ? `CI failed: ${rest.length > 0 ? `${first} +${rest.length}` : first}` : "CI failed",
        tone: "error",
      };
    }
    default:
      return null;
  }
}

export function projectPullRequestReviewBadge(pr: Pick<ProjectPullRequest, "review">): ProjectBadge | null {
  switch (pr.review) {
    case "approved":
      return { label: "Approved", tone: "success" };
    case "changes_requested":
      return { label: "Changes requested", tone: "error" };
    case "commented":
      return { label: "Commented", tone: "neutral" };
    default:
      return null;
  }
}

/** Why the merge button is off (the engine refuses the same PRs), or null when it can merge. */
export function projectPullRequestMergeBlocker(
  pr: Pick<ProjectPullRequest, "state" | "draft" | "ci" | "review" | "mergeable">
): string | null {
  if (pr.state === "merged") {
    return "Already merged";
  }
  if (pr.state === "closed") {
    return "Closed";
  }
  if (pr.draft) {
    return "Still a draft";
  }
  if (pr.ci === "pending") {
    return "CI is still running";
  }
  if (pr.ci === "failure") {
    return "CI failed";
  }
  if (pr.review === "changes_requested") {
    return "Changes were requested";
  }
  if (pr.mergeable === false) {
    return "Has merge conflicts";
  }
  return null;
}

/** "in 5 min", "3 h ago", "just now". */
export function projectRelativeTime(at: number, now: number): string {
  const delta = at - now;
  const minutes = Math.round(Math.abs(delta) / 60_000);
  if (minutes < 1) {
    return delta >= 0 ? "in under a minute" : "just now";
  }
  const amount =
    minutes < 60
      ? `${minutes} min`
      : minutes < 60 * 48
        ? `${Math.round(minutes / 60)} h`
        : `${Math.round(minutes / (60 * 24))} d`;
  return delta >= 0 ? `in ${amount}` : `${amount} ago`;
}

const SUBSCRIPTION_KIND_LABELS: Record<ProjectSubscriptionSummary["kind"], string> = {
  github_pr: "Pull request",
  github_ci: "CI",
  timer: "Timer",
};

/** The second line of a Listening entry: what kind, whose, when it next fires. */
export function projectSubscriptionMeta(sub: ProjectSubscriptionSummary, now: number): string {
  const parts = [SUBSCRIPTION_KIND_LABELS[sub.kind]];
  if (sub.agent) {
    parts.push(sub.agent);
  }
  if (sub.nextFireAt != null) {
    parts.push(`next ${projectRelativeTime(sub.nextFireAt, now)}`);
  } else if (sub.lastEventAt != null) {
    parts.push(`last event ${projectRelativeTime(sub.lastEventAt, now)}`);
  }
  if (sub.createdBy !== "auto") {
    parts.push(sub.createdBy === "user" ? "added by you" : "added by the coordinator");
  }
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Context

export type ProjectContextTreeNode =
  | { type: "folder"; name: string; path: string; children: ProjectContextTreeNode[] }
  | { type: "file"; name: string; path: string; file: ProjectContextFile };

const CONTEXT_ROOT_ORDER = ["notes.md", "docs", "internal", "media", "inbox"];

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function sortContextNodes(nodes: ProjectContextTreeNode[], root: boolean): void {
  nodes.sort((a, b) => {
    if (root) {
      const rankA = CONTEXT_ROOT_ORDER.indexOf(a.name);
      const rankB = CONTEXT_ROOT_ORDER.indexOf(b.name);
      if (rankA !== rankB) {
        return (rankA < 0 ? CONTEXT_ROOT_ORDER.length : rankA) - (rankB < 0 ? CONTEXT_ROOT_ORDER.length : rankB);
      }
    }
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1;
    }
    return compareNames(a.name, b.name);
  });
  for (const node of nodes) {
    if (node.type === "folder") {
      sortContextNodes(node.children, false);
    }
  }
}

/** The Context as a tree: `notes.md`, the standard folders, then everything else. */
export function buildProjectContextTree(
  files: readonly ProjectContextFile[],
  folders: readonly string[] = []
): ProjectContextTreeNode[] {
  const root: ProjectContextTreeNode[] = [];
  const folderByPath = new Map<string, Extract<ProjectContextTreeNode, { type: "folder" }>>();
  const ensureFolder = (folderPath: string): ProjectContextTreeNode[] => {
    if (!folderPath) {
      return root;
    }
    const existing = folderByPath.get(folderPath);
    if (existing) {
      return existing.children;
    }
    const slash = folderPath.lastIndexOf("/");
    const parent = ensureFolder(slash < 0 ? "" : folderPath.slice(0, slash));
    const folder = {
      type: "folder" as const,
      name: slash < 0 ? folderPath : folderPath.slice(slash + 1),
      path: folderPath,
      children: [],
    };
    folderByPath.set(folderPath, folder);
    parent.push(folder);
    return folder.children;
  };
  for (const folder of folders) {
    const clean = folder.replace(/^\/+|\/+$/g, "");
    if (clean) {
      ensureFolder(clean);
    }
  }
  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    ensureFolder(slash < 0 ? "" : file.path.slice(0, slash)).push({
      type: "file",
      name: slash < 0 ? file.path : file.path.slice(slash + 1),
      path: file.path,
      file,
    });
  }
  sortContextNodes(root, true);
  return root;
}

export type ProjectContextPreviewKind = "markdown" | "text" | "image" | "video" | "binary";

export function projectContextPreviewKind(
  filePath: string,
  kind: ProjectContextFileKind | null = null
): ProjectContextPreviewKind {
  if (/\.(md|markdown)$/i.test(filePath)) {
    return "markdown";
  }
  const byPath = projectContextKindFromPath(filePath) ?? kind;
  return byPath === "image" || byPath === "video" || byPath === "text" ? byPath : "binary";
}

/** A Context-relative path from a `context:` reference, or null when it is unsafe or empty. */
export function parseProjectContextHref(href: string): string | null {
  if (!href.startsWith("context:")) {
    return null;
  }
  let target = href.slice("context:".length).split(/[?#]/)[0] ?? "";
  try {
    target = decodeURIComponent(target);
  } catch {
    return null;
  }
  target = target.replace(/^\.\/+/, "");
  if (!target || target.startsWith("/") || target.includes("\\") || target.split("/").some((part) => part === ".." || part === "")) {
    return null;
  }
  return target;
}

export type ProjectContextEmbed = {
  path: string;
  label: string;
  kind: "image" | "video" | "file";
};

const CONTEXT_EMBED_LINE = /^(!?)\[([^\]]*)\]\((context:[^)\s]+)\)$/;

/**
 * A line that is only `![what it shows](context:media/x.png)` or
 * `[demo](context:media/x.mp4)`: rendered as the image, a player, or a file
 * chip. Line-based, so a half-streamed embed stays text until it is complete.
 */
export function matchProjectContextEmbedLine(line: string): ProjectContextEmbed | null {
  const match = CONTEXT_EMBED_LINE.exec(line.trim());
  if (!match) {
    return null;
  }
  const path = parseProjectContextHref(match[3]!);
  if (!path) {
    return null;
  }
  const kind = projectContextKindFromPath(path);
  const label = match[2]!.trim() || path.split("/").pop() || path;
  return { path, label, kind: kind === "image" || kind === "video" ? kind : "file" };
}

// ---------------------------------------------------------------------------
// notes.md: the Project's live checklist

export type ProjectNotesLine =
  | { kind: "heading"; text: string }
  | { kind: "task"; text: string; done: boolean; depth: number }
  | { kind: "bullet"; text: string; depth: number }
  | { kind: "text"; text: string };

/** notes.md as display lines: headings, tasks (`- [ ]`, `- [x]`), bullets and text. */
export function parseProjectNotes(markdown: string): ProjectNotesLine[] {
  const lines: ProjectNotesLine[] = [];
  let inCode = false;
  for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.trimStart().startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode || !raw.trim()) {
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(raw);
    if (heading) {
      lines.push({ kind: "heading", text: heading[1]! });
      continue;
    }
    const item = /^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(raw);
    if (item) {
      const depth = Math.min(4, Math.floor(item[1]!.replace(/\t/g, "  ").length / 2));
      const text = item[3]!.trim();
      lines.push(
        item[2] !== undefined
          ? { kind: "task", text, done: item[2] !== " ", depth }
          : { kind: "bullet", text, depth }
      );
      continue;
    }
    lines.push({ kind: "text", text: raw.trim() });
  }
  return lines;
}

export function summarizeProjectNotes(markdown: string): { done: number; total: number } {
  const tasks = parseProjectNotes(markdown).filter(
    (line): line is Extract<ProjectNotesLine, { kind: "task" }> => line.kind === "task"
  );
  return { done: tasks.filter((task) => task.done).length, total: tasks.length };
}

// ---------------------------------------------------------------------------
// The coordinator's chat

export const PROJECT_MESSAGE_TOOL = "project_message_user";

export type ProjectMessageCall = { toolCallId: string; message: string; failed: boolean };

function messageArgument(detail: string | undefined, raw: unknown): string | null {
  const fromObject = (value: unknown): string | null =>
    value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string"
      ? (value as { message: string }).message
      : null;
  if (detail) {
    try {
      const parsed = fromObject(JSON.parse(detail));
      if (parsed != null) {
        return parsed;
      }
    } catch {
      // Not JSON: fall back to the raw request.
    }
  }
  return raw && typeof raw === "object" ? fromObject((raw as { arguments?: unknown }).arguments) : null;
}

function toolName(raw: unknown): string | null {
  return raw && typeof raw === "object" && typeof (raw as { name?: unknown }).name === "string"
    ? (raw as { name: string }).name
    : null;
}

/** The coordinator's `project_message_user` calls, by tool call id. */
export function collectProjectMessageCalls(events: readonly AgentStoredEvent[]): Map<string, ProjectMessageCall> {
  const calls = new Map<string, ProjectMessageCall>();
  for (const event of events) {
    if (event.kind === "tool_call") {
      const name = toolName(event.raw);
      // Cloud snapshots drop `raw`; the tool's kind and title still identify it.
      const isMessage = name ? name === PROJECT_MESSAGE_TOOL : event.toolKind === "orchestration" && event.title === "Message";
      const message = isMessage ? messageArgument(event.detail, event.raw)?.trim() : null;
      if (message) {
        calls.set(event.toolCallId, { toolCallId: event.toolCallId, message, failed: event.status === "failed" });
      }
    } else if (event.kind === "tool_call_update" && event.status === "failed") {
      const call = calls.get(event.toolCallId);
      if (call) {
        call.failed = true;
      }
    }
  }
  return calls;
}

function unescapeEnvelope(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

const AGENT_BLOCK = /<agent name="([^"]+)" event="([^"]+)" status="([^"]*)">\n?([\s\S]*?)\n?<\/agent>/g;
const EVENT_BLOCK = /<system_notification source="([^"]+)"([^>]*)>\n?([\s\S]*?)\n?<\/system_notification>/g;
const ATTR = /([a-z_]+)="([^"]*)"/g;

/** A readable body for an agent-update or event turn: one paragraph per agent or event. */
export function projectNoticeDetail(raw: string): string {
  const agents = [...raw.matchAll(AGENT_BLOCK)];
  if (agents.length > 0) {
    return agents.map((match) => `${match[1]} · ${match[2]}\n${(match[4] ?? "").trim()}`.trim()).join("\n\n");
  }
  const events = [...raw.matchAll(EVENT_BLOCK)];
  if (events.length > 0) {
    return events
      .map((match) => {
        const attrs = [...(match[2] ?? "").matchAll(ATTR)].map((attr) => `${attr[1]} ${unescapeEnvelope(attr[2] ?? "")}`);
        const title = [match[1], ...attrs].join(" · ");
        return `${title}\n${unescapeEnvelope((match[3] ?? "").trim())}`.trim();
      })
      .join("\n\n");
  }
  return raw.trim();
}

type TurnOrigin = "user" | "notice" | "event" | "none";

function turnOrigin(head: ChatMessage | undefined): TurnOrigin {
  if (head?.type !== "user") {
    return "none";
  }
  const text = head.content ?? "";
  if (text.startsWith(PROJECT_NOTICE_DISPLAY_PREFIX)) {
    return "notice";
  }
  return text.startsWith(PROJECT_EVENT_DISPLAY_PREFIX) ? "event" : "user";
}

function bubbleCall(
  entry: WorkedSessionEntry,
  calls: ReadonlyMap<string, ProjectMessageCall>
): ProjectMessageCall | null {
  const call = entry.kind === "tool" && entry.toolCallId ? calls.get(entry.toolCallId) : undefined;
  return call && !call.failed ? call : null;
}

function splitAroundMessages(message: ChatMessage, calls: ReadonlyMap<string, ProjectMessageCall>): ChatMessage[] {
  const entries = message.workedEntries ?? [];
  if (!entries.some((entry) => bubbleCall(entry, calls))) {
    return [message];
  }
  const out: ChatMessage[] = [];
  let part: WorkedSessionEntry[] = [];
  let partIndex = 0;
  const flush = (last: boolean) => {
    if (part.length === 0) {
      return;
    }
    const highlighted = message.workedHighlightedEntry;
    out.push({
      ...message,
      id: partIndex === 0 ? message.id : `${message.id}~${partIndex}`,
      workedEntries: part,
      workedLabel: buildWorkedSessionLabel(part),
      loading: last ? message.loading : false,
      workedHighlightedEntry: highlighted && part.includes(highlighted) ? highlighted : undefined,
    });
    partIndex += 1;
    part = [];
  };
  for (const entry of entries) {
    const call = bubbleCall(entry, calls);
    if (call) {
      flush(false);
      out.push({ id: `project-message-${call.toolCallId}`, type: "assistant", content: call.message });
    } else {
      part.push(entry);
    }
  }
  flush(true);
  return out;
}

const STATUS_LABEL_MAX_CHARS = 140;

function statusRow(message: ChatMessage): ChatMessage | null {
  const text = (message.content ?? "").trim();
  if (!text) {
    return null;
  }
  const firstLine = text.split("\n").find((line) => line.trim())!.trim();
  const label =
    firstLine.length > STATUS_LABEL_MAX_CHARS ? `${firstLine.slice(0, STATUS_LABEL_MAX_CHARS - 1)}…` : firstLine;
  return {
    id: message.id,
    type: "activity-label",
    activityLabel: label,
    ...(text !== label ? { activityDetail: text } : {}),
  };
}

/**
 * The coordinator's chat as the user reads it:
 * - `project_message_user` calls become its messages (assistant bubbles), in place;
 * - agent updates and external events become compact rows instead of user bubbles;
 * - its own reply text becomes a quiet status line whenever the turn spoke through
 *   messages or was opened by an update or event. A turn the user started that
 *   never called the tool keeps its reply as the message, so nothing goes unsaid.
 */
export function projectCoordinatorMessages(
  messages: readonly ChatMessage[],
  events: readonly AgentStoredEvent[]
): ChatMessage[] {
  const calls = collectProjectMessageCalls(events);
  const turns: ChatMessage[][] = [];
  for (const message of messages) {
    if (message.type === "user" || turns.length === 0) {
      turns.push([]);
    }
    turns[turns.length - 1]!.push(message);
  }
  const out: ChatMessage[] = [];
  for (const turn of turns) {
    const head = turn[0];
    const origin = turnOrigin(head);
    const automatic = origin === "notice" || origin === "event";
    const spoke = turn.some(
      (message) =>
        message.type === "worked-session" && (message.workedEntries ?? []).some((entry) => bubbleCall(entry, calls))
    );
    for (const message of turn) {
      if (message === head && automatic) {
        out.push({
          id: message.id,
          type: "activity-label",
          activityLabel: message.content ?? "",
          activityDetail: projectNoticeDetail(message.rawContent ?? message.content ?? ""),
        });
      } else if (message.type === "worked-session") {
        out.push(...splitAroundMessages(message, calls));
      } else if (message.type === "assistant" && (spoke || automatic)) {
        const row = statusRow(message);
        if (row) {
          out.push(row);
        }
      } else if (!(message.type === "turn-footer" && automatic)) {
        out.push(message);
      }
    }
  }
  return out;
}
