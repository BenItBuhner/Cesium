import type { AgentStoredEvent, AgentToolEditPreview } from "./protocol";

/**
 * Coarse phase of an agent run for compact listings where a full activity
 * line does not fit ("Fix build · Editing"). Derived from the run status,
 * pending intervention, structured progress, and the kind of the most recent
 * activity event; `getMobileAgentPhaseLabel` turns it into display text.
 */
export type MobileAgentPhase =
  | "starting"
  | "thinking"
  | "writing"
  | "editing"
  | "reading"
  | "running"
  | "searching"
  | "browsing"
  | "planning"
  | "delegating"
  | "waiting"
  | "working"
  | "finishing"
  | "needs_permission"
  | "needs_answer"
  | "pausing"
  | "paused"
  | "finished"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "idle";

/** Aggregate of the file edits observed during one agent run. */
export type MobileAgentEditStats = {
  /** Distinct files touched (edit tool calls without a path count once each). */
  files: number;
  additions: number;
  deletions: number;
};

export function getMobileAgentPhaseLabel(phase: MobileAgentPhase): string {
  switch (phase) {
    case "starting":
      return "Starting";
    case "thinking":
      return "Thinking";
    case "writing":
      return "Writing";
    case "editing":
      return "Editing";
    case "reading":
      return "Reading";
    case "running":
      return "Running commands";
    case "searching":
      return "Searching";
    case "browsing":
      return "Browsing";
    case "planning":
      return "Planning";
    case "delegating":
      return "Delegating";
    case "waiting":
      return "Waiting";
    case "finishing":
      return "Finishing";
    case "needs_permission":
      return "Needs permission";
    case "needs_answer":
      return "Needs an answer";
    case "pausing":
      return "Pausing";
    case "paused":
      return "Paused";
    case "finished":
      return "Finished";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
    case "idle":
      return "Idle";
    case "working":
    default:
      return "Working";
  }
}

/**
 * "+120 −8 · 4 files" - the diffstat line of a run. The deletions count uses
 * a real minus sign so it never reads as a hyphenated range.
 */
export function formatMobileEditStats(
  stats: MobileAgentEditStats | null | undefined
): string | null {
  if (!stats || stats.files <= 0) {
    return null;
  }
  return `+${stats.additions} −${stats.deletions} · ${stats.files} ${
    stats.files === 1 ? "file" : "files"
  }`;
}

export type ToolCallLikeEvent = Extract<
  AgentStoredEvent,
  { kind: "tool_call" | "tool_call_update" }
>;

/**
 * Phase from the most recent activity-bearing event of the run. Only the
 * latest one counts: an older in-flight tool call is stale once the model has
 * moved on to streaming text or the next call.
 */
export function deriveAgentActivityPhase(runEvents: AgentStoredEvent[]): MobileAgentPhase {
  for (let i = runEvents.length - 1; i >= 0; i--) {
    const event = runEvents[i];
    if (!event) continue;
    switch (event.kind) {
      case "subagent":
        return event.status === "running" ? "delegating" : "thinking";
      case "tool_call":
      case "tool_call_update":
        if (event.status === "in_progress" || event.status === "pending") {
          return phaseForToolKind(resolveToolCallKind(event, runEvents, i));
        }
        // Between tool calls the model is deciding what to do next.
        return "thinking";
      case "assistant_message_chunk":
        return "writing";
      case "reasoning":
        return "thinking";
      case "plan":
        return "planning";
      default:
        continue;
    }
  }
  return "starting";
}

function phaseForToolKind(toolKind: string | undefined): MobileAgentPhase {
  switch (toolKind) {
    case "read":
      return "reading";
    case "edit":
    case "delete":
    case "move":
      return "editing";
    case "terminal":
    case "execute":
      return "running";
    case "grep":
    case "search":
    case "search_web":
    case "fetch":
      return "searching";
    case "browser":
      return "browsing";
    case "todo":
    case "goal":
      return "planning";
    case "subagent":
    case "task":
    case "orchestration":
      return "delegating";
    case "think":
      return "thinking";
    case "wait":
      return "waiting";
    default:
      return "working";
  }
}

function resolveToolCallKind(
  event: ToolCallLikeEvent,
  events: AgentStoredEvent[],
  index: number
): string | undefined {
  if (event.toolKind != null || event.kind === "tool_call") {
    return event.toolKind;
  }
  for (let i = index - 1; i >= 0; i--) {
    const origin = events[i];
    if (origin?.kind === "tool_call" && origin.toolCallId === event.toolCallId) {
      return origin.toolKind;
    }
  }
  return undefined;
}

/**
 * Sums the edit previews of the run's tool calls into one diffstat. Each tool
 * call contributes its latest preview once (updates supersede the initial
 * call), failed and cancelled edits never land and are skipped, and files are
 * counted by distinct path so re-editing a file does not inflate the count.
 */
export function deriveAgentRunEditStats(
  runEvents: AgentStoredEvent[]
): MobileAgentEditStats | null {
  const previews = new Map<string, AgentToolEditPreview>();
  const finalStatus = new Map<string, string>();
  for (const event of runEvents) {
    if (event.kind !== "tool_call" && event.kind !== "tool_call_update") continue;
    finalStatus.set(event.toolCallId, event.status);
    if (event.editPreview) {
      previews.set(event.toolCallId, event.editPreview);
    }
  }
  const paths = new Set<string>();
  let unnamed = 0;
  let additions = 0;
  let deletions = 0;
  for (const [toolCallId, preview] of previews) {
    const status = finalStatus.get(toolCallId);
    if (status === "failed" || status === "cancelled") continue;
    additions += Math.max(0, preview.addedLines);
    deletions += Math.max(0, preview.removedLines);
    const path = preview.path?.trim();
    if (path) {
      paths.add(path.replace(/^file:\/\//i, "").replace(/\\/g, "/"));
    } else {
      unnamed += 1;
    }
  }
  const files = paths.size + unnamed;
  if (files === 0) {
    return null;
  }
  return { files, additions, deletions };
}
