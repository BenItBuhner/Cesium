import type { AgentModeOption, EditorMode, KnownEditorMode } from "@/lib/types";

export const DEFAULT_MODE_OPTIONS: AgentModeOption[] = [
  { id: "agent", label: "Agent" },
  { id: "plan", label: "Plan" },
  { id: "debug", label: "Debug" },
  { id: "ask", label: "Ask" },
];

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
  const requestedLower = lower;
  const rawCandidates =
    requestedLower === "agent" || requestedLower === "code"
      ? ["agent", "code", "build"]
      : requestedLower === "plan"
        ? ["plan", "architect"]
        : requestedLower === "ask"
          ? ["ask", "review", "readonly", "read-only"]
          : requestedLower === "debug"
            ? ["debug", "build", "agent", "code"]
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
  return trimmed;
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
