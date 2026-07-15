import { HARNESS_LABELS, HARNESS_ORDER } from "@/components/editor/agent-harness-settings";
import type { AgentBackendId } from "@/lib/agent-types";
import type { ModelToggleState } from "@/lib/global-settings";
import { SHORTCUT_COMMAND_DEFINITIONS } from "@/lib/keyboard-shortcuts";
import type { SettingsPanelSearchFocus } from "@/lib/workspace-session";

export type { SettingsPanelSearchFocus };

export type SettingsSearchHitKind =
  | "nav"
  | "section"
  | "row"
  | "model"
  | "shortcut"
  | "harness";

export type SettingsSearchEntry = {
  id: string;
  kind: SettingsSearchHitKind;
  label: string;
  subtitle: string;
  navId: string;
  agentsHarnessId?: AgentBackendId;
  rowId?: string;
  backendId?: string;
  panelQuery?: string;
  keywords: string[];
};

const NAV_LABELS: Record<string, string> = {
  general: "General",
  appearance: "Appearance",
  keyboardShortcuts: "Keyboard shortcuts",
  agents: "Agents",
  models: "Models",
  plugins: "Plugins",
  extensions: "Extensions",
  servers: "Servers",
  rulesSkills: "Rules, Skills, Subagents",
  exportImport: "Import & export",
  storage: "Storage",
  beta: "Beta",
};

function entry(
  partial: Omit<SettingsSearchEntry, "keywords"> & { keywords?: string[] }
): SettingsSearchEntry {
  const keywords = partial.keywords ?? [];
  return {
    ...partial,
    keywords: [
      partial.label,
      partial.subtitle,
      NAV_LABELS[partial.navId] ?? partial.navId,
      ...keywords,
    ]
      .join(" ")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  };
}

function row(
  navId: string,
  rowId: string,
  title: string,
  description?: string,
  extraKeywords: string[] = []
): SettingsSearchEntry {
  return entry({
    id: `${navId}::${rowId}`,
    kind: "row",
    label: title,
    subtitle: description ?? NAV_LABELS[navId] ?? navId,
    navId,
    rowId,
    keywords: extraKeywords,
  });
}

function section(navId: string, sectionId: string, title: string, extra = ""): SettingsSearchEntry {
  return entry({
    id: `${navId}::section::${sectionId}`,
    kind: "section",
    label: title,
    subtitle: NAV_LABELS[navId] ?? navId,
    navId,
    keywords: [sectionId, extra],
  });
}

const STATIC_SETTINGS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  ...Object.entries(NAV_LABELS).map(([navId, label]) =>
    entry({
      id: `nav::${navId}`,
      kind: "nav",
      label,
      subtitle: "Settings category",
      navId,
      keywords: [navId],
    })
  ),

  // —— General ——
  section("general", "preferences", "Preferences"),
  row(
    "general",
    "appearance-link",
    "Appearance & themes",
    "System, light, or dark mode; per-appearance themes; custom token presets.",
    ["theme", "themes"]
  ),
  row(
    "general",
    "shortcuts-link",
    "Keyboard Shortcuts",
    "Customize keyboard shortcuts for commands and workflows."
  ),
  row(
    "general",
    "export-link",
    "Import & export settings",
    "Back up or restore theme, shortcuts, workspace app settings, and more as JSON.",
    ["backup", "restore", "json"]
  ),
  section("general", "notifications", "Notifications"),
  row(
    "general",
    "do-not-disturb",
    "Do Not Disturb",
    "Suppress all notifications — connection alerts, warnings, file overrides, and every other notification type.",
    ["dnd", "notifications", "quiet"]
  ),

  // —— Appearance ——
  section("appearance", "mode", "Appearance mode", "system light dark"),
  section("appearance", "layout", "Layout"),
  row(
    "appearance",
    "swap-columns",
    "Swap side columns",
    "Move the agent/chat pane to the left and the file sidebar to the right while keeping the editor centered."
  ),
  row(
    "appearance",
    "floating-sidebar",
    "Floating sidebar reveal",
    "Show the floating control over the editor when the file sidebar is collapsed."
  ),
  section("appearance", "design", "Design"),
  row(
    "appearance",
    "new-design",
    "New design",
    "Enable the next-generation UI design hooks for agent mode.",
    ["ui", "classic"]
  ),
  row(
    "appearance",
    "long-paste-references",
    "Long paste references",
    "Collapse very large pasted chat composer text into a compact reference.",
    ["paste", "clipboard", "composer", "reference", "large text", "10k"]
  ),
  row(
    "appearance",
    "minimal-edit-diff",
    "Minimal edit diff",
    "Show file edits as added and removed line counts instead of the full inline diff.",
    ["edit diff", "diff", "counts", "lines added", "lines removed"]
  ),
  section("appearance", "chat", "Chat"),
  row(
    "appearance",
    "tool-call-dropdown-height",
    "Tool call dropdown height",
    "Maximum height of expanded agent tool-call blocks in chat; content scrolls inside the limit.",
    ["worked session", "tool call", "max height", "scroll"]
  ),
  section("appearance", "light-theme", "Light theme"),
  section("appearance", "dark-theme", "Dark theme"),
  section("appearance", "custom-themes", "Custom themes", "duplicate preset tokens"),

  // —— Agents ——
  section("agents", "composer", "Chat composer"),
  row("agents", "submit-mod-enter", "Submit with modifier + Enter", "Agents"),
  section("agents", "tool-permissions", "Tool permissions (all harnesses)"),
  row(
    "agents",
    "auto-approve",
    "Auto-approve all permission prompts",
    "Agents",
    ["permissions", "allow"]
  ),
  section("agents", "harnesses", "Harnesses"),
  ...HARNESS_ORDER.map((backendId) =>
    entry({
      id: `harness::${backendId}`,
      kind: "harness",
      label: HARNESS_LABELS[backendId],
      subtitle: "Agents harness",
      navId: "agents",
      agentsHarnessId: backendId,
      keywords: [backendId, "agent", "backend", "harness"],
    })
  ),
  row("agents", "cesium-default-api", "Default API", "Cesium Agent", ["cesium", "api"]),
  row("agents", "cesium-default-provider", "Default provider key", "Cesium Agent"),
  row(
    "agents",
    "cesium-compression",
    "Context compression",
    "Summarize older turns when the session approaches the model context limit.",
    ["cesium", "context"]
  ),
  row(
    "agents",
    "cesium-orchestration-continue",
    "Continue when work remains",
    "Orchestration Agent",
    ["cesium", "orchestration", "kanban", "todo"]
  ),
  row("agents", "cesium-edit-file", "Edit file", "Cesium tool permissions"),
  row("agents", "cesium-terminal", "Terminal", "Cesium tool permissions"),
  row("agents", "cesium-custom-providers", "Custom providers", "Cesium Agent"),
  row("agents", "cursor-sdk-api-key", "Cursor SDK API key", "Cursor SDK"),
  row("agents", "cursor-sdk", "Cursor SDK", "Cursor SDK API key"),

  // —— Models (panel chrome; model rows are dynamic) ——
  section("models", "catalog", "Model catalog", "visibility toggle refresh"),

  // —— Plugins ——
  section("plugins", "catalog", "Agent Plugins", "catalog install enable disable harness"),
  section("plugins", "custom", "Custom Plugin", "custom mcp skill plugin"),
  row(
    "plugins",
    "harness-overrides",
    "Per-harness plugin overrides",
    "Enable or disable installed plugins for individual agent harnesses.",
    ["cesium", "cursor sdk", "claude", "opencode", "codex", "antigravity", "pi agent"]
  ),
  row("plugins", "mcp-link", "MCP servers", "Plugins · MCP"),
  row(
    "plugins",
    "rules-link",
    "Rules, skills, and subagents",
    "Instruction files, skills, and subagent presets."
  ),

  // —— MCP servers (Plugins subpage) ——
  section("plugins", "mcp-presets", "Presets", "mcp"),
  section("plugins", "mcp-custom", "Custom server", "mcp oauth url"),
  section("plugins", "mcp-connected", "Connected servers", "mcp"),

  // —— Extensions ——
  section("extensions", "runtime", "Beta Runtime", "vscode extensions marketplace host"),
  row(
    "extensions",
    "marketplace",
    "VS Code Extension Marketplace",
    "Open VSX install activate permissions host runtime."
  ),
  section("extensions", "installed", "Installed", "extensions installed workspace"),

  // —— Rules ——
  section("rulesSkills", "workspace-files", "Workspace files", "rules skills subagents"),

  // —— Servers ——
  section("servers", "default", "Default settings server"),
  row(
    "servers",
    "home-server",
    "Home server for shared preferences",
    "Theme, keyboard shortcuts, and model toggles.",
    ["default server", "settings server"]
  ),
  row("servers", "active-chat", "Active chat server", "New chats and workspace actions."),
  row("servers", "connected-runtimes", "Connected runtimes", "Saved servers online"),
  section("servers", "saved", "Saved servers"),

  // —— Beta ——
  section("beta", "browser", "Browser", "new browser beta experimental chromium"),
  row("beta", "new-browser", "New browser", "Experimental Chromium-backed browser engine."),
  section("beta", "extensions", "Extensions", "vscode extension marketplace beta"),
  row(
    "beta",
    "vscode-extensions",
    "VS Code Extension Marketplace",
    "Desktop-only extension marketplace and runtime Beta."
  ),
];

const IPAD_BETA_SETTINGS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  section("beta", "ipad", "iPad", "experimental beta"),
  row(
    "beta",
    "ipad-text-input",
    "Text Input Abstraction",
    "Hardware-keyboard-first input surfaces on iPad.",
    ["ipad", "keyboard"]
  ),
  row("beta", "ipad-menu", "Custom Menu Buttons", "Explorer tree menus on iPad."),
  row(
    "beta",
    "ipad-inset",
    "Windowed mode tab inset",
    "Extra left padding for iPadOS window controls.",
    ["windowed", "tab inset"]
  ),
  row(
    "beta",
    "ipad-resume-cache",
    "Fast resume cache",
    "Restore a cached workspace snapshot and app shell before backend reconnect on iPad.",
    ["ipad", "pwa", "indexeddb", "resume", "cache"]
  ),
];

const STATIC_SETTINGS_SEARCH_ENTRIES_TAIL: SettingsSearchEntry[] = [
  section("keyboardShortcuts", "voice", "Voice input", "hold toggle"),

  // —— Import & export ——
  section("exportImport", "export", "Export", "json backup"),
  section("exportImport", "import", "Import", "json restore"),
  row("exportImport", "theme-export", "Theming", "Appearance mode and custom presets."),
  row("exportImport", "prefs-export", "Local preferences", "iPad experimental toggles."),
  row("exportImport", "shortcuts-export", "Keyboard shortcuts", "Custom bindings."),
  row("exportImport", "app-export", "App settings", "General, agents, and models."),
  row("exportImport", "session-export", "Workspace layout session", "Open tabs and chat layout."),

  // —— Storage ——
  section("storage", "status", "Storage status", "driver postgres sqlite"),
  section("storage", "migrate", "Migrate between drivers", "migration"),
];

const SHORTCUT_SEARCH_ENTRIES: SettingsSearchEntry[] = SHORTCUT_COMMAND_DEFINITIONS.map(
  (def) =>
    entry({
      id: `shortcut::${def.id}`,
      kind: "shortcut",
      label: def.label,
      subtitle: `${def.section} · Keyboard shortcuts`,
      navId: "keyboardShortcuts",
      panelQuery: def.label,
      keywords: [def.id, def.section, "shortcut", "keybinding", "hotkey"],
    })
);

const CURSOR_SDK_VARIANT_TOKENS = new Set([
  "auto",
  "default",
  "extra",
  "fast",
  "high",
  "large",
  "long",
  "low",
  "max",
  "medium",
  "normal",
  "short",
  "standard",
  "true",
  "false",
]);

function stripCursorSdkModelParams(value: string): string {
  return value.replace(/\[[^\]]+\]$/g, "").trim();
}

function normalizeModelVariantToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function consumeSettingsModelVariantToken(words: string[]): boolean {
  const last = words.at(-1);
  if (!last) return false;
  const normalizedLast = normalizeModelVariantToken(last);
  if (normalizedLast === "true" || normalizedLast === "fast") {
    words.pop();
    return true;
  }
  if (normalizedLast === "false") {
    words.pop();
    if (normalizeModelVariantToken(words.at(-1) ?? "") === "fast") {
      words.pop();
    }
    return true;
  }
  if (/^\d+\s*[km]$/i.test(last)) {
    words.pop();
    return true;
  }
  const prev = normalizeModelVariantToken(words.at(-2) ?? "");
  if (prev === "extra" && normalizedLast === "high") {
    words.pop();
    words.pop();
    return true;
  }
  if (CURSOR_SDK_VARIANT_TOKENS.has(normalizedLast)) {
    words.pop();
    return true;
  }
  return false;
}

function compactModelName(name: string, fallbackId: string): string {
  const base = (name.trim() || fallbackId.trim() || "Model")
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .trim();
  const parts = base.split(/\s+/);
  while (parts.length > 1 && consumeSettingsModelVariantToken(parts)) {}
  return parts.join(" ") || base || fallbackId || "Model";
}

function buildModelSearchEntries(
  byBackend: Record<string, ModelToggleState[]>
): SettingsSearchEntry[] {
  const entries: SettingsSearchEntry[] = [];
  const seen = new Set<string>();

  for (const [backendId, models] of Object.entries(byBackend)) {
    const harnessLabel = HARNESS_LABELS[backendId as AgentBackendId] ?? backendId;
    const groups = new Map<string, { name: string; modelIds: string[] }>();

    for (const model of models) {
      const baseId = stripCursorSdkModelParams(model.id);
      const baseName = compactModelName(model.name, baseId);
      const key = `${backendId}::${baseName.toLowerCase()}`;
      const existing = groups.get(key);
      if (existing) {
        existing.modelIds.push(model.id);
        continue;
      }
      groups.set(key, { name: baseName, modelIds: [model.id] });
    }

    for (const { name, modelIds } of groups.values()) {
      const dedupeKey = `${backendId}::${name.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      entries.push(
        entry({
          id: `model::${dedupeKey}`,
          kind: "model",
          label: name,
          subtitle: `${harnessLabel} · Models`,
          navId: "models",
          backendId,
          panelQuery: name,
          keywords: [...modelIds, backendId, harnessLabel, "model", "llm"],
        })
      );
    }
  }

  return entries;
}

export function buildSettingsSearchIndex(
  modelsByBackend: Record<string, ModelToggleState[]>,
  options?: { includeIpadBeta?: boolean }
): SettingsSearchEntry[] {
  const includeIpadBeta = options?.includeIpadBeta !== false;
  return [
    ...STATIC_SETTINGS_SEARCH_ENTRIES,
    ...(includeIpadBeta ? IPAD_BETA_SETTINGS_SEARCH_ENTRIES : []),
    ...STATIC_SETTINGS_SEARCH_ENTRIES_TAIL,
    ...SHORTCUT_SEARCH_ENTRIES,
    ...buildModelSearchEntries(modelsByBackend),
  ];
}

function entryHaystack(item: SettingsSearchEntry): string {
  return [item.label, item.subtitle, ...item.keywords].join(" ").toLowerCase();
}

function scoreEntry(item: SettingsSearchEntry, tokens: string[]): number {
  const haystack = entryHaystack(item);
  let score = 0;
  for (const token of tokens) {
    if (!haystack.includes(token)) {
      return -1;
    }
    if (item.label.toLowerCase().includes(token)) {
      score += 12;
    } else if (item.subtitle.toLowerCase().includes(token)) {
      score += 4;
    } else {
      score += 1;
    }
  }
  if (item.kind === "nav") score -= 2;
  if (item.kind === "model") score += 3;
  return score;
}

export function searchSettingsIndex(
  index: SettingsSearchEntry[],
  query: string,
  limit = 25
): SettingsSearchEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [];
  }
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return [];
  }

  const scored: Array<{ item: SettingsSearchEntry; score: number }> = [];
  for (const item of index) {
    const score = scoreEntry(item, tokens);
    if (score >= 0) {
      scored.push({ item, score });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.item.label.localeCompare(b.item.label);
  });

  return scored.slice(0, limit).map((row) => row.item);
}

export function settingsSearchHitToFocus(
  hit: SettingsSearchEntry
): SettingsPanelSearchFocus | null {
  if (hit.kind === "model") {
    return {
      kind: "models",
      query: hit.panelQuery ?? hit.label,
      backendId: hit.backendId,
    };
  }
  if (hit.kind === "shortcut") {
    return {
      kind: "keyboardShortcuts",
      query: hit.panelQuery ?? hit.label,
    };
  }
  if (hit.kind === "row" && hit.rowId) {
    return { kind: "scroll", navId: hit.navId, rowId: hit.rowId };
  }
  return null;
}
