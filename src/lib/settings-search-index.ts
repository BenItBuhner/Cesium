import { HARNESS_LABELS, HARNESS_ORDER } from "@/components/editor/agent-harness-settings";
import type { AgentBackendId } from "@/lib/agent-types";
import type { ModelToggleState } from "@/lib/global-settings";
import { SHORTCUT_COMMAND_DEFINITIONS } from "@/lib/keyboard-shortcuts";
import {
  compactModelName,
  stripCursorSdkModelParams,
} from "@/lib/settings-model-compaction";
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
  account: "Account",
  general: "General",
  actions: "Actions",
  appearance: "Appearance",
  keyboardShortcuts: "Keyboard shortcuts",
  agents: "Agents",
  cloudAgents: "Cloud Agents",
  models: "Models",
  usage: "Usage",
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

  // —— Account ——
  section("account", "identity", "Account & session", "profile sign in sign out login"),
  row(
    "account",
    "account-identity",
    "Signed-in account",
    "Your cloud account, device sync identity, or local workspace.",
    ["profile", "avatar", "email", "clerk", "identity", "user"]
  ),
  row(
    "account",
    "account-cloud-mode",
    "Cloud account",
    "Sign in, sync status, and sign out for the cloud account layer.",
    ["sign in", "sign out", "sync", "clerk", "device", "local-only"]
  ),
  row(
    "account",
    "account-server-session",
    "Server session",
    "Password session on the active server: expiry, last active, sign out.",
    ["logout", "sign out", "password", "auth", "session", "expires"]
  ),
  row(
    "account",
    "account-active-server",
    "Active server",
    "The server this client is connected to; switch or manage servers.",
    ["server", "switch", "connection"]
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
  section("general", "quick-open", "Quick Open & switcher", "palette search"),
  row(
    "general",
    "quick-open-default-scope",
    "Default Quick Open search",
    "What Ctrl/Cmd+P searches when it opens: files, chats, commands, settings, or tabs.",
    ["quick open", "palette", "cmd+p", "ctrl+p", "scope", "search", "default"]
  ),
  row(
    "general",
    "quick-switcher-scope",
    "Ctrl+Tab switcher cycles",
    "Cycle agent conversations, open editor tabs, or both with the hold-to-cycle switcher.",
    ["ctrl+tab", "switcher", "mru", "tabs", "conversations", "cycle"]
  ),
  section("general", "performance", "Performance", "stream rendering"),
  row(
    "general",
    "batch-stream-events",
    "Batch streamed events",
    "Render high-speed token and progress streams in short batches.",
    ["streaming", "tokens", "render", "repaint", "gpu", "cpu", "battery", "performance"]
  ),
  section("general", "notifications", "Notifications"),
  row(
    "general",
    "do-not-disturb",
    "Do Not Disturb",
    "Suppress all notifications — connection alerts, warnings, file overrides, and every other notification type.",
    ["dnd", "notifications", "quiet"]
  ),
  section("general", "voice", "Voice"),
  row(
    "general",
    "show-voice-orb",
    "Voice orb",
    "Show the floating ambient voice orb. Hiding it also turns the voice plane off.",
    ["voice", "orb", "ambient", "microphone", "assistant", "overlay", "bubble"]
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
  section("appearance", "themes", "Themes", "light dark"),
  row("appearance", "light-theme", "Light theme", "Theme applied when the UI resolves to light."),
  row("appearance", "dark-theme", "Dark theme", "Theme applied when the UI resolves to dark."),
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
  row("agents", "cesium-mcp-call", "MCP call", "Cesium tool permissions"),
  row("agents", "cesium-switch-mode", "Switch mode", "Cesium tool permissions"),
  row("agents", "cesium-custom-providers", "Custom providers", "Cesium Agent"),
  row("agents", "cursor-sdk-api-key", "Cursor SDK API key", "Cursor SDK"),
  row("agents", "cursor-sdk", "Cursor SDK", "Cursor SDK API key"),
  row(
    "agents",
    "opencode-v2-beta",
    "OpenCode v2 Beta",
    "Native OpenCode v2 harness with durable events, typed tools, and background subagents.",
    ["opencode2", "terminal", "subagent", "permission", "form"]
  ),

  // —— Cloud Agents ——
  section("cloudAgents", "connections", "Connections", "linear github slack oauth token webhook"),
  section("cloudAgents", "defaults", "Defaults", "cloud agents harness model workspace"),
  section("cloudAgents", "routing", "Workspace routing", "cloud agents rules filter"),
  section(
    "cloudAgents",
    "pending",
    "Pending assignments",
    "cloud agents inbox dispatch test rail external"
  ),
  row(
    "cloudAgents",
    "cloud-agents-default-harness",
    "Default agent harness",
    "Harness used for offloaded Cloud Agent tasks.",
    ["cloud", "backend", "linear", "github", "slack"]
  ),
  row(
    "cloudAgents",
    "cloud-agents-default-model",
    "Default model",
    "Model id used for offloaded Cloud Agent tasks.",
    ["cloud", "llm"]
  ),
  row(
    "cloudAgents",
    "cloud-agents-execution-mode",
    "Execution mode",
    "Isolated worktree branches vs. local workspace checkout.",
    ["cloud", "branch", "worktree", "git", "pr"]
  ),
  row(
    "cloudAgents",
    "cloud-agents-auto-dispatch",
    "Auto-dispatch assignments",
    "Start agents immediately when webhook assignments arrive.",
    ["cloud", "webhook", "auto"]
  ),
  row(
    "cloudAgents",
    "cloud-agents-fallback-workspace",
    "Fallback workspace",
    "Workspace used when no Cloud Agents routing rule matches.",
    ["cloud", "routing"]
  ),

  // —— Models (panel chrome; model rows are dynamic) ——
  section("models", "catalog", "Model catalog", "visibility toggle refresh"),

  // —— Usage ——
  section(
    "usage",
    "overview",
    "Usage overview",
    "tokens quota subscription meter analytics graphs projections burn rate"
  ),
  row(
    "usage",
    "usage-controls",
    "Usage auto-refresh",
    "Live polling of local harness usage data every 60 seconds, with manual refresh.",
    ["tokens", "quota", "rate limit", "refresh", "polling"]
  ),
  row(
    "usage",
    "usage-tabs",
    "Harness selector",
    "Switch between Codex, Claude Code, Antigravity, OpenCode, Pi, and Cesium usage dashboards.",
    ["codex", "claude", "antigravity", "gemini", "opencode", "pi", "tabs"]
  ),
  row(
    "usage",
    "usage-summary",
    "Usage summary",
    "Total tokens, requests, known spend, and tracked harnesses across subscriptions.",
    ["tokens", "spend", "cost", "summary"]
  ),
  row(
    "usage",
    "usage-limits-codex",
    "Codex subscription limits",
    "ChatGPT plan 5h and weekly rate-limit meters with consumption charts and projections.",
    ["codex", "openai", "chatgpt", "quota", "rate limit", "meter", "projection"]
  ),
  row(
    "usage",
    "usage-limits-claude-code",
    "Claude Code session blocks",
    "Current 5h session block and rolling 7-day window with burn-rate projections.",
    ["claude", "anthropic", "session block", "weekly", "projection"]
  ),

  // —— Plugins ——
  section("plugins", "catalog", "Agent Plugins", "catalog install enable disable harness"),
  section("plugins", "discover", "Discover", "plugin marketplace registry github search context7"),
  section("plugins", "verify", "Verify harness sync", "plugin harness mcp skills verify"),
  section("plugins", "custom", "Custom Plugin", "custom mcp skill plugin"),
  row(
    "plugins",
    "harness-overrides",
    "Per-harness plugin overrides",
    "Enable or disable installed plugins for individual agent harnesses. Warn when MCP is prompt-only.",
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
  section("servers", "public-access-section", "Public access", "share expose tunnel remote link"),
  row(
    "servers",
    "public-access",
    "Share this backend",
    "Enable a secure public tunnel for this machine.",
    ["remote access", "electron", "laptop"]
  ),
  row(
    "servers",
    "stable-link",
    "Permanent connection link",
    "Copy the stable Cesium link that follows tunnel changes."
  ),
  row(
    "servers",
    "server-credentials",
    "Connection credentials",
    "Copy or rotate public server sign-in credentials."
  ),
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
  // —— Actions ——
  section("actions", "composer-pills", "Composer pills", "diff conflicts sync work"),
  row(
    "actions",
    "actions-pill-diff",
    "Diff line counts",
    "Show +added / −removed line totals for uncommitted changes above the composer.",
    ["diff", "lines", "added", "removed", "pill"]
  ),
  row(
    "actions",
    "actions-pill-conflicts",
    "Merge conflicts",
    "Surface unresolved merge conflicts and a confirmation once fixed.",
    ["merge", "conflict", "pill"]
  ),
  row(
    "actions",
    "actions-pill-sync",
    "Ahead / behind upstream",
    "Show unpushed and unpulled commit counts for the current branch.",
    ["push", "pull", "ahead", "behind", "upstream"]
  ),
  row(
    "actions",
    "actions-pill-work",
    "Background work",
    "Live pill while agents, cloud tasks, or terminals are running.",
    ["subagent", "background", "running", "tasks"]
  ),
  section("actions", "presets", "Preset actions", "quick actions presets"),
  section("actions", "custom", "Custom actions", "custom quick action command prompt keybinding"),

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
