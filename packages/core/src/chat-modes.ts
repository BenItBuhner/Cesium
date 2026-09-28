import type { AgentModeOption, EditorMode, KnownEditorMode } from "./types";

/**
 * Stand-in catalog for backends that expose no mode option of their own
 * (Cesium Agent, Pi): a single entry, so no mode chip, picker, or Shift+Tab
 * cycle is offered for them.
 */
export const DEFAULT_MODE_OPTIONS: AgentModeOption[] = [{ id: "agent", label: "Agent" }];

export function formatModeLabel(mode: string): string {
  const trimmed = mode.trim();
  if (!trimmed) {
    return "Mode";
  }
  return trimmed
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

/**
 * Map UI / persisted mode strings to the concrete `option.value` id exposed by the
 * active backend (case- and alias-aware, aligned with server mode resolution).
 * A mode the backend does not offer resolves to its first option.
 */
export function resolveCanonicalModeId(rawMode: string, options: AgentModeOption[]): string {
  const trimmed = rawMode.trim();
  if (!trimmed) {
    return options[0]?.id ?? "agent";
  }
  if (options.length === 0) {
    return trimmed;
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
  const rawCandidates =
    lower === "agent" || lower === "code"
      ? ["agent", "code", "build"]
      : lower === "plan"
        ? ["plan", "architect"]
        : lower === "ask"
          ? ["ask", "review", "readonly", "read-only"]
          : lower === "debug"
            ? ["debug", "build", "agent", "code"]
            : [trimmed];
  for (const candidate of rawCandidates) {
    const found = ids.find((id) => id.toLowerCase() === candidate.toLowerCase());
    if (found) {
      return found;
    }
  }
  return ids[0] ?? trimmed;
}

export function getModeTone(mode: string): KnownEditorMode {
  const normalized = mode.trim().toLowerCase();
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
