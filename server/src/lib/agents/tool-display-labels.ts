/** Concise tool titles aligned with `src/lib/agent-chat.ts` (OSP-55). */

const TOOL_TITLE_MAX_LEN = 56;
const TOOL_PATH_BASE_MAX = 48;
const TOOL_PATTERN_QUOTED_MAX = 42;
export const TERMINAL_TITLE_MAX = 72;

export function toolPathBasename(p: string): string {
  const cleaned = p.replace(/^file:\/\//i, "").split("?")[0] ?? p;
  const parts = cleaned.split(/[/\\]/);
  return parts[parts.length - 1] || cleaned;
}

export function truncateMiddleLabel(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  const ellipsis = "…";
  const keep = max - ellipsis.length;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return value.slice(0, head) + ellipsis + value.slice(value.length - tail);
}

export function conciseQuotedSearchPattern(
  raw: string,
  max = TOOL_PATTERN_QUOTED_MAX
): string {
  const t = raw.trim();
  if (!t) {
    return '""';
  }
  const inner = t.length > max ? truncateMiddleLabel(t, max) : t;
  return `"${inner}"`;
}

export function formatReadToolTitle(path: string | undefined): string {
  if (!path) {
    return "Read file";
  }
  return `Read ${truncateMiddleLabel(toolPathBasename(path), TOOL_PATH_BASE_MAX)}`;
}

export function formatGrepToolTitle(pattern: string | undefined): string {
  if (!pattern?.trim()) {
    return "Grep workspace";
  }
  return `Grep ${conciseQuotedSearchPattern(pattern)}`;
}

export function formatFindToolTitle(pattern: string | undefined): string {
  if (!pattern?.trim()) {
    return "Find in workspace";
  }
  return `Find ${conciseQuotedSearchPattern(pattern)}`;
}

export function formatWebSearchTitle(query: string | undefined): string {
  if (!query?.trim()) {
    return "Web search";
  }
  return `Web · ${truncateMiddleLabel(query.trim(), 44)}`;
}

export function formatUpdateToolTitle(path: string | undefined, fallback: string): string {
  if (!path) {
    return truncateMiddleLabel(fallback, TOOL_TITLE_MAX_LEN);
  }
  return `Update ${truncateMiddleLabel(toolPathBasename(path), TOOL_PATH_BASE_MAX)}`;
}

export function formatDeleteToolTitle(path: string | undefined, fallback: string): string {
  if (!path) {
    return truncateMiddleLabel(fallback, TOOL_TITLE_MAX_LEN);
  }
  return `Delete ${truncateMiddleLabel(toolPathBasename(path), TOOL_PATH_BASE_MAX)}`;
}

export function formatTerminalCommandTitle(command: string): string {
  return truncateMiddleLabel(command.trim(), TERMINAL_TITLE_MAX);
}

export function truncateGenericToolTitle(label: string | undefined, fallback: string): string {
  const base = (label ?? "").trim();
  return truncateMiddleLabel(base || fallback, TOOL_TITLE_MAX_LEN);
}
