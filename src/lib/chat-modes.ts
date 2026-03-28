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
