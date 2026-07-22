import type { AgentModeOption, EditorMode, KnownEditorMode } from "./types";

export const DEFAULT_MODE_OPTIONS: AgentModeOption[] = [
  { id: "agent", label: "Agent" },
  { id: "plan", label: "Plan" },
  { id: "orchestration", label: "Orchestration" },
  { id: "workflow", label: "Workflow" },
  { id: "ask", label: "Ask" },
];

export function isOrchestrationMode(mode: string): boolean {
  return String(mode).trim().toLowerCase() === "orchestration";
}

/** @deprecated Use `isGoalMode`. Kept for callers that still check the legacy Burn alias. */
export function isBurnMode(mode: string): boolean {
  return isGoalMode(mode);
}

export function isWorkflowMode(mode: string): boolean {
  return String(mode).trim().toLowerCase() === "workflow";
}

export function isGoalMode(mode: string): boolean {
  const normalized = String(mode).trim().toLowerCase();
  return normalized === "goal" || normalized === "burn";
}

/**
 * Normalize legacy Burn mode option ids to Goal, and drop duplicate Burn entries
 * when Goal is already present in the catalog.
 */
export function filterGoalModeOptions(
  options: AgentModeOption[],
  _goalModeBetaEnabled = false
): AgentModeOption[] {
  const hasGoal = options.some((option) => String(option.id).trim().toLowerCase() === "goal");
  const seen = new Set<string>();
  const next: AgentModeOption[] = [];
  for (const option of options) {
    const normalized = String(option.id).trim().toLowerCase();
    if (normalized === "burn") {
      if (hasGoal) continue;
      const remapped = { ...option, id: "goal" as EditorMode, label: option.label === "Burn" ? "Goal" : option.label };
      if (seen.has("goal")) continue;
      seen.add("goal");
      next.push(remapped);
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    next.push(option);
  }
  return next;
}

/**
 * Coerce legacy persisted `"burn"` mode ids to `"goal"` when Goal is available.
 */
export function coerceUnavailableGoalMode(
  mode: string,
  options: AgentModeOption[]
): string {
  const normalized = mode.trim().toLowerCase();
  if (normalized === "burn") {
    if (options.some((option) => String(option.id).trim().toLowerCase() === "goal")) {
      return options.find((option) => String(option.id).trim().toLowerCase() === "goal")?.id ?? "goal";
    }
    if (options.some((option) => isGoalMode(option.id))) {
      return options.find((option) => isGoalMode(option.id))?.id ?? mode;
    }
  }
  return mode;
}

export function isOrchestrationModeLocked(): boolean {
  return false;
}

export function formatModeLabel(mode: string): string {
  const trimmed = mode.trim();
  if (!trimmed) {
    return "Mode";
  }
  if (trimmed.toLowerCase() === "burn") {
    return "Goal";
  }
  return trimmed
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

/**
 * Map UI / persisted mode strings to the concrete `option.value` id exposed by the
 * active backend (case- and alias-aware, aligned with server mode resolution).
 */
export function resolveCanonicalModeId(rawMode: string, options: AgentModeOption[]): string {
  const trimmed = rawMode.trim();
  if (!trimmed) {
    return options[0]?.id ?? "agent";
  }
  if (options.length === 0) {
    return trimmed.toLowerCase() === "burn" ? "goal" : trimmed;
  }
  const ids = options.map((o) => o.id);
  if (ids.includes(trimmed)) {
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  for (const id of ids) {
    if (id.toLowerCase() === lower) {
      return id;
    }
  }
  const requestedLower = lower === "burn" ? "goal" : lower;
  const rawCandidates =
    requestedLower === "agent" || requestedLower === "code"
      ? ["agent", "code", "build"]
      : requestedLower === "plan"
        ? ["plan", "architect"]
        : requestedLower === "ask"
          ? ["ask", "review", "readonly", "read-only"]
          : requestedLower === "debug"
            ? ["debug", "build", "agent", "code"]
            : requestedLower === "goal"
              ? ["goal", "burn"]
              : requestedLower === "workflow"
                ? ["workflow"]
                : [trimmed];
  const idSet = new Set(ids);
  for (const candidate of rawCandidates) {
    if (idSet.has(candidate)) {
      return candidate;
    }
  }
  for (const candidate of rawCandidates) {
    const found = ids.find((id) => id.toLowerCase() === candidate.toLowerCase());
    if (found) {
      return found;
    }
  }
  return requestedLower === "goal" ? "goal" : trimmed;
}

export function getModeTone(mode: string): KnownEditorMode {
  const normalized = mode.trim().toLowerCase();
  if (isGoalMode(normalized)) {
    return "goal";
  }
  if (isWorkflowMode(normalized) || normalized.includes("workflow")) {
    return "workflow";
  }
  if (isOrchestrationMode(normalized) || normalized.includes("orchestration")) {
    return "orchestration";
  }
  if (
    normalized === "plan" ||
    normalized === "architect" ||
    normalized.includes("plan")
  ) {
    return "plan";
  }
  if (normalized === "debug" || normalized.includes("debug")) {
    return "debug";
  }
  if (
    normalized === "ask" ||
    normalized === "review" ||
    normalized === "readonly" ||
    normalized === "read-only"
  ) {
    return "ask";
  }
  return "agent";
}

export function ensureCurrentModeOption(
  mode: EditorMode,
  options: AgentModeOption[]
): AgentModeOption[] {
  if (!mode || options.some((option) => option.id === mode)) {
    return options;
  }
  return [{ id: mode, label: formatModeLabel(mode) }, ...options];
}

/**
 * Resolve the next mode from an already-filtered effective catalog.
 * A disabled current mode is temporarily inserted so the next cycle exits it;
 * a single remaining mode leaves Shift+Tab available for focus navigation.
 */
export function resolveNextModeInCycle(
  mode: EditorMode,
  options: AgentModeOption[]
): EditorMode | null {
  const cycle = ensureCurrentModeOption(mode, options);
  if (cycle.length < 2) {
    return null;
  }
  const canonical = resolveCanonicalModeId(String(mode), cycle);
  const index = cycle.findIndex((option) => option.id === canonical);
  return cycle[(index < 0 ? 0 : index + 1) % cycle.length]?.id ?? null;
}
