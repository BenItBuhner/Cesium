/**
 * Quick Open (Mod+P) scope model. The palette defaults to file search but can
 * pivot to other searchable domains — agent conversations, workbench commands,
 * settings, and open editor tabs — via clickable scope chips, Tab cycling, or
 * typed prefixes (`>` commands, `@` chats, `#` settings, `tabs:` …).
 */

export const QUICK_OPEN_SCOPE_IDS = [
  "files",
  "conversations",
  "commands",
  "settings",
  "tabs",
] as const;

export type QuickOpenScopeId = (typeof QUICK_OPEN_SCOPE_IDS)[number];

export const QUICK_OPEN_SCOPE_LABELS: Record<QuickOpenScopeId, string> = {
  files: "Files",
  conversations: "Chats",
  commands: "Commands",
  settings: "Settings",
  tabs: "Tabs",
};

export const QUICK_OPEN_SCOPE_PLACEHOLDERS: Record<QuickOpenScopeId, string> = {
  files: "Search files by name",
  conversations: "Search agent conversations",
  commands: "Search commands",
  settings: "Search settings",
  tabs: "Search open editor tabs",
};

/** Single-character sigils typed as the first character of the query. */
export const QUICK_OPEN_SCOPE_SIGILS: Record<string, QuickOpenScopeId> = {
  ">": "commands",
  "@": "conversations",
  "#": "settings",
};

/** Word prefixes (`tabs: term`) usable for every scope, sigil or not. */
export const QUICK_OPEN_SCOPE_WORD_PREFIXES: Record<string, QuickOpenScopeId> = {
  "files:": "files",
  "chats:": "conversations",
  "conversations:": "conversations",
  "commands:": "commands",
  "settings:": "settings",
  "tabs:": "tabs",
};

export function isQuickOpenScopeId(value: unknown): value is QuickOpenScopeId {
  return (
    typeof value === "string" &&
    (QUICK_OPEN_SCOPE_IDS as readonly string[]).includes(value)
  );
}

export function normalizeQuickOpenScope(
  raw: unknown,
  fallback: QuickOpenScopeId = "files"
): QuickOpenScopeId {
  return isQuickOpenScopeId(raw) ? raw : fallback;
}

export type ParsedQuickOpenQuery = {
  /** Scope after applying any typed prefix override. */
  scope: QuickOpenScopeId;
  /** Query text with the prefix stripped. */
  query: string;
  /** True when the raw text carried a sigil / word prefix override. */
  prefixed: boolean;
};

/**
 * Resolves the effective scope + query for a raw input value. A leading sigil
 * (`>`, `@`, `#`) or word prefix (`tabs:` …) overrides the base scope selected
 * via chips / cycling.
 */
export function parseQuickOpenQuery(
  raw: string,
  baseScope: QuickOpenScopeId
): ParsedQuickOpenQuery {
  const sigilScope = QUICK_OPEN_SCOPE_SIGILS[raw.slice(0, 1)];
  if (sigilScope) {
    return { scope: sigilScope, query: raw.slice(1).trimStart(), prefixed: true };
  }
  const lower = raw.toLowerCase();
  for (const [prefix, scope] of Object.entries(QUICK_OPEN_SCOPE_WORD_PREFIXES)) {
    if (lower.startsWith(prefix)) {
      return { scope, query: raw.slice(prefix.length).trimStart(), prefixed: true };
    }
  }
  return { scope: baseScope, query: raw, prefixed: false };
}

export function cycleQuickOpenScope(
  current: QuickOpenScopeId,
  delta: 1 | -1
): QuickOpenScopeId {
  const index = QUICK_OPEN_SCOPE_IDS.indexOf(current);
  const length = QUICK_OPEN_SCOPE_IDS.length;
  const next = ((index < 0 ? 0 : index) + delta + length) % length;
  return QUICK_OPEN_SCOPE_IDS[next] ?? "files";
}

/** What the hold-to-cycle (Mod+Tab) quick switcher steps through. */
export const QUICK_SWITCHER_SCOPE_IDS = ["conversations", "tabs", "both"] as const;

export type QuickSwitcherScopeId = (typeof QUICK_SWITCHER_SCOPE_IDS)[number];

export const QUICK_SWITCHER_SCOPE_LABELS: Record<QuickSwitcherScopeId, string> = {
  conversations: "Agent conversations",
  tabs: "Open editor tabs",
  both: "Conversations and tabs",
};

export function isQuickSwitcherScopeId(
  value: unknown
): value is QuickSwitcherScopeId {
  return (
    typeof value === "string" &&
    (QUICK_SWITCHER_SCOPE_IDS as readonly string[]).includes(value)
  );
}

export function normalizeQuickSwitcherScope(
  raw: unknown,
  fallback: QuickSwitcherScopeId = "conversations"
): QuickSwitcherScopeId {
  return isQuickSwitcherScopeId(raw) ? raw : fallback;
}
