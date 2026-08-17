/**
 * Quick Actions + composer insights (OSP-80).
 *
 * Shared contract for the "action pills" surface that renders above the chat
 * composer: dynamic, context-aware status pills (diff counts, merge-conflict
 * state, branch sync, background work) plus user-configurable quick-action
 * buttons (shell commands, agent prompts, UI commands) with optional
 * keybindings. Consumed by the server (store + run endpoint), the web client,
 * and the standalone SDK.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Workspace insights (data source for the dynamic pills)
// ─────────────────────────────────────────────────────────────────────────────

export type WorkspaceDiffFileStat = {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
  /** File is new/untracked (line counts read from disk, not git). */
  untracked?: boolean;
  /** File currently carries unresolved conflict markers per `git status`. */
  conflicted?: boolean;
};

export type WorkspaceMergeStateKind =
  | "none"
  | "merging"
  | "rebasing"
  | "cherry-picking";

export type WorkspaceInsights = {
  isGitRepo: boolean;
  branch: string | null;
  detached: boolean;
  dirty: boolean;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  diff: {
    files: WorkspaceDiffFileStat[];
    totalAdded: number;
    totalRemoved: number;
    fileCount: number;
    /** True when the file list was capped for payload size. */
    truncated: boolean;
  };
  merge: {
    state: WorkspaceMergeStateKind;
    conflictedFiles: string[];
    /**
     * A merge/rebase/cherry-pick is in progress and every conflicted file has
     * been resolved (staged) — the "Fixed merge conflicts" pill state.
     */
    conflictsResolved: boolean;
  };
  work: {
    /**
     * Running/paused/awaiting agent conversations in this workspace.
     * The composer work pill excludes the open conversation — that agent is
     * already visible in the thread — and only treats *other* chats, spawned
     * sub-agents, and cloud tasks as background work.
     */
    runningConversations: number;
    runningConversationTitles: string[];
    /** Parallel to `runningConversationTitles`; used to exclude the open chat. */
    runningConversationIds?: string[];
    aliveTerminals: number;
    runningCloudTasks: number;
  };
  updatedAt: number;
};

export function createEmptyWorkspaceInsights(): WorkspaceInsights {
  return {
    isGitRepo: false,
    branch: null,
    detached: false,
    dirty: false,
    ahead: 0,
    behind: 0,
    hasUpstream: false,
    diff: { files: [], totalAdded: 0, totalRemoved: 0, fileCount: 0, truncated: false },
    merge: { state: "none", conflictedFiles: [], conflictsResolved: false },
    work: {
      runningConversations: 0,
      runningConversationTitles: [],
      runningConversationIds: [],
      aliveTerminals: 0,
      runningCloudTasks: 0,
    },
    updatedAt: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in composer pills
// ─────────────────────────────────────────────────────────────────────────────

export const COMPOSER_PILL_IDS = ["diff", "conflicts", "sync", "work"] as const;
export type ComposerPillId = (typeof COMPOSER_PILL_IDS)[number];

/**
 * Per-scope visibility of the composer pill row. `actions` gates the custom
 * quick-action pills as a group; individual actions opt in via `showPill`.
 */
export type ComposerPillsVisibility = {
  diff: boolean;
  conflicts: boolean;
  sync: boolean;
  work: boolean;
  actions: boolean;
};

export const DEFAULT_COMPOSER_PILLS_VISIBILITY: ComposerPillsVisibility = {
  diff: true,
  conflicts: true,
  sync: true,
  work: true,
  actions: true,
};

export function normalizeComposerPillsVisibility(raw: unknown): ComposerPillsVisibility {
  const base = { ...DEFAULT_COMPOSER_PILLS_VISIBILITY };
  if (!raw || typeof raw !== "object") {
    return base;
  }
  const record = raw as Partial<ComposerPillsVisibility>;
  return {
    diff: typeof record.diff === "boolean" ? record.diff : base.diff,
    conflicts: typeof record.conflicts === "boolean" ? record.conflicts : base.conflicts,
    sync: typeof record.sync === "boolean" ? record.sync : base.sync,
    work: typeof record.work === "boolean" ? record.work : base.work,
    actions: typeof record.actions === "boolean" ? record.actions : base.actions,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick action definitions
// ─────────────────────────────────────────────────────────────────────────────

export type QuickActionKind = "command" | "prompt" | "ui";

/**
 * Context rule deciding when an action pill is relevant. Pills are dynamic:
 * they disappear whenever their context does not apply (e.g. no git repo → no
 * git actions; nothing to push → no push pill).
 */
export type QuickActionVisibility =
  | "always"
  | "git"
  | "dirty"
  | "conflicts"
  | "ahead"
  | "behind"
  | "running";

export const QUICK_ACTION_VISIBILITY_OPTIONS: Array<{
  id: QuickActionVisibility;
  label: string;
}> = [
  { id: "always", label: "Always" },
  { id: "git", label: "When in a git repo" },
  { id: "dirty", label: "When there are uncommitted changes" },
  { id: "conflicts", label: "During merge conflicts" },
  { id: "ahead", label: "When ahead of upstream (unpushed)" },
  { id: "behind", label: "When behind upstream" },
  { id: "running", label: "While the agent is working" },
];

/** Client-side UI commands runnable from a quick action (kind `ui`). */
export const QUICK_ACTION_UI_COMMANDS = [
  { id: "layout.toggleRightPane", label: "Toggle right workbench pane" },
  { id: "layout.toggleLeftRail", label: "Toggle conversation rail" },
  { id: "layout.focusChat", label: "Focus chat (collapse side panes)" },
  { id: "settings.open", label: "Open settings" },
  { id: "settings.openActions", label: "Open Actions settings" },
  { id: "chat.newConversation", label: "Start a new conversation" },
  { id: "voice.startAgent", label: "Start voice agent" },
] as const;

export type QuickActionUiCommandId = (typeof QUICK_ACTION_UI_COMMANDS)[number]["id"];

export function isQuickActionUiCommandId(value: unknown): value is QuickActionUiCommandId {
  return QUICK_ACTION_UI_COMMANDS.some((command) => command.id === value);
}

export type QuickActionDefinition = {
  id: string;
  label: string;
  /** Lucide icon name; client falls back to a default glyph when unknown. */
  icon?: string;
  kind: QuickActionKind;
  /** kind=command: shell command executed at the workspace root. */
  command?: string;
  /** kind=prompt: message sent to the active agent conversation. */
  prompt?: string;
  /** kind=ui: client-side UI command id. */
  uiCommand?: string;
  visibility: QuickActionVisibility;
  /** Ask for confirmation before running (recommended for mutating commands). */
  confirm: boolean;
  /** Render as a pill above the composer (keybinding works either way). */
  showPill: boolean;
  /** Single-step binding such as `Mod+Alt+M`; null/absent = none. */
  keybinding?: string | null;
  enabled: boolean;
  /** Set when materialized from the built-in preset catalog. */
  presetId?: string;
  createdAt: number;
  updatedAt: number;
};

export type QuickActionRunStatus = "ok" | "error";

export type QuickActionRunResult = {
  ok: boolean;
  actionId: string;
  kind: QuickActionKind;
  /** kind=command */
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  /** kind=prompt */
  conversationId?: string;
  /** kind=prompt: prompt was queued because the conversation was busy. */
  queued?: boolean;
  error?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Preset catalog
// ─────────────────────────────────────────────────────────────────────────────

export type QuickActionPreset = {
  id: string;
  label: string;
  description: string;
  icon: string;
  kind: QuickActionKind;
  command?: string;
  prompt?: string;
  uiCommand?: QuickActionUiCommandId;
  visibility: QuickActionVisibility;
  confirm: boolean;
  showPill: boolean;
  /** Enabled out of the box (user can flip every preset in Settings → Actions). */
  defaultEnabled: boolean;
};

/**
 * Curated, genuinely useful defaults. Kept deliberately conservative: presets
 * that mutate state ship with `confirm: true`, and anything requiring extra
 * tooling (`gh`) is off by default.
 */
export const QUICK_ACTION_PRESETS: QuickActionPreset[] = [
  {
    id: "fix-merge-conflicts",
    label: "Fix merge conflicts",
    description: "Ask the agent to resolve every unresolved merge conflict in the repo.",
    icon: "GitMerge",
    kind: "prompt",
    prompt:
      "There are unresolved merge conflicts in this repository. Inspect `git status` and every conflicted file, resolve all conflicts (preserving the intent of both sides), stage the resolutions, and report what you changed. Do not commit unless all conflicts are cleanly resolved.",
    visibility: "conflicts",
    confirm: false,
    showPill: true,
    defaultEnabled: true,
  },
  {
    id: "commit-push",
    label: "Commit & push",
    description: "Stage everything, commit a checkpoint, and push to the current branch.",
    icon: "GitCommitHorizontal",
    kind: "command",
    command: 'git add -A && git commit -m "checkpoint: quick save" && git push',
    visibility: "dirty",
    confirm: true,
    showPill: true,
    defaultEnabled: true,
  },
  {
    id: "push-branch",
    label: "Push branch",
    description: "Push unpushed commits to the upstream branch (sets upstream when missing).",
    icon: "ArrowUpFromLine",
    kind: "command",
    command: "git push -u origin HEAD",
    visibility: "ahead",
    confirm: false,
    showPill: true,
    defaultEnabled: true,
  },
  {
    id: "pull-latest",
    label: "Pull latest",
    description: "Rebase onto upstream, auto-stashing local changes.",
    icon: "ArrowDownToLine",
    kind: "command",
    command: "git pull --rebase --autostash",
    visibility: "behind",
    confirm: false,
    showPill: true,
    defaultEnabled: true,
  },
  {
    id: "create-pr",
    label: "Create PR",
    description: "Open a pull request for the current branch with gh (requires GitHub CLI).",
    icon: "GitPullRequestArrow",
    kind: "command",
    command: "gh pr create --fill",
    visibility: "ahead",
    confirm: true,
    showPill: true,
    defaultEnabled: false,
  },
  {
    id: "merge-pr",
    label: "Merge PR",
    description: "Squash-merge the open PR for this branch and delete the branch (requires gh).",
    icon: "GitPullRequestClosed",
    kind: "command",
    command: "gh pr merge --squash --delete-branch",
    visibility: "git",
    confirm: true,
    showPill: true,
    defaultEnabled: false,
  },
  {
    id: "pr-status",
    label: "PR status",
    description: "Show the PR status for the current branch (requires gh).",
    icon: "GitPullRequest",
    kind: "command",
    command: "gh pr status",
    visibility: "git",
    confirm: false,
    showPill: true,
    defaultEnabled: false,
  },
  {
    id: "summarize-changes",
    label: "Summarize changes",
    description: "Ask the agent for a concise summary of all uncommitted changes.",
    icon: "ScrollText",
    kind: "prompt",
    prompt:
      "Summarize the current uncommitted changes in this workspace (`git status` + `git diff`). Group by area, call out anything risky or incomplete, and keep it brief.",
    visibility: "dirty",
    confirm: false,
    showPill: true,
    defaultEnabled: false,
  },
  {
    id: "run-tests",
    label: "Run tests",
    description: "Run the project's test suite.",
    icon: "FlaskConical",
    kind: "command",
    command: "npm test",
    visibility: "always",
    confirm: false,
    showPill: true,
    defaultEnabled: false,
  },
  {
    id: "lint-fix",
    label: "Lint & fix",
    description: "Run the linter with auto-fix.",
    icon: "Wand2",
    kind: "command",
    command: "npm run lint -- --fix",
    visibility: "always",
    confirm: false,
    showPill: true,
    defaultEnabled: false,
  },
  {
    id: "stash-changes",
    label: "Stash changes",
    description: "Stash all local changes including untracked files.",
    icon: "Archive",
    kind: "command",
    command: "git stash push -u",
    visibility: "dirty",
    confirm: true,
    showPill: true,
    defaultEnabled: false,
  },
  {
    id: "focus-chat",
    label: "Focus chat",
    description: "Collapse the conversation rail and right pane for a distraction-free chat.",
    icon: "Focus",
    kind: "ui",
    uiCommand: "layout.focusChat",
    visibility: "always",
    confirm: false,
    showPill: false,
    defaultEnabled: false,
  },
  {
    id: "toggle-workbench",
    label: "Toggle workbench",
    description: "Open or close the right workbench pane.",
    icon: "PanelRight",
    kind: "ui",
    uiCommand: "layout.toggleRightPane",
    visibility: "always",
    confirm: false,
    showPill: false,
    defaultEnabled: false,
  },
  {
    id: "start-voice-agent",
    label: "Start voice agent",
    description: "Open the full-screen voice agent session (speech + chat composer).",
    icon: "AudioLines",
    kind: "ui",
    uiCommand: "voice.startAgent",
    visibility: "always",
    confirm: false,
    showPill: false,
    defaultEnabled: false,
  },
];

export function getQuickActionPreset(presetId: string): QuickActionPreset | undefined {
  return QUICK_ACTION_PRESETS.find((preset) => preset.id === presetId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stored configuration
// ─────────────────────────────────────────────────────────────────────────────

export type QuickActionsConfig = {
  schemaVersion: 1;
  /** Preset enablement overrides; unset id = preset's `defaultEnabled`. */
  presetStates: Record<string, boolean>;
  customActions: QuickActionDefinition[];
};

export function createDefaultQuickActionsConfig(): QuickActionsConfig {
  return { schemaVersion: 1, presetStates: {}, customActions: [] };
}

const QUICK_ACTION_KINDS: QuickActionKind[] = ["command", "prompt", "ui"];
const QUICK_ACTION_VISIBILITIES: QuickActionVisibility[] = [
  "always",
  "git",
  "dirty",
  "conflicts",
  "ahead",
  "behind",
  "running",
];
const MAX_CUSTOM_ACTIONS = 100;
const MAX_TEXT_FIELD = 4000;

export function normalizeQuickActionDefinition(raw: unknown): QuickActionDefinition | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Partial<QuickActionDefinition>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const label = typeof record.label === "string" ? record.label.trim().slice(0, 80) : "";
  const kind = QUICK_ACTION_KINDS.includes(record.kind as QuickActionKind)
    ? (record.kind as QuickActionKind)
    : null;
  if (!id || !label || !kind) {
    return null;
  }
  const command =
    typeof record.command === "string" ? record.command.trim().slice(0, MAX_TEXT_FIELD) : "";
  const prompt =
    typeof record.prompt === "string" ? record.prompt.trim().slice(0, MAX_TEXT_FIELD) : "";
  const uiCommand = typeof record.uiCommand === "string" ? record.uiCommand.trim() : "";
  if (kind === "command" && !command) {
    return null;
  }
  if (kind === "prompt" && !prompt) {
    return null;
  }
  if (kind === "ui" && !isQuickActionUiCommandId(uiCommand)) {
    return null;
  }
  const now = Date.now();
  return {
    id: id.slice(0, 120),
    label,
    icon: typeof record.icon === "string" && record.icon.trim() ? record.icon.trim().slice(0, 60) : undefined,
    kind,
    ...(kind === "command" ? { command } : {}),
    ...(kind === "prompt" ? { prompt } : {}),
    ...(kind === "ui" ? { uiCommand } : {}),
    visibility: QUICK_ACTION_VISIBILITIES.includes(record.visibility as QuickActionVisibility)
      ? (record.visibility as QuickActionVisibility)
      : "always",
    confirm: record.confirm === true,
    showPill: record.showPill !== false,
    keybinding:
      typeof record.keybinding === "string" && record.keybinding.trim()
        ? record.keybinding.trim().slice(0, 60)
        : null,
    enabled: record.enabled !== false,
    ...(typeof record.presetId === "string" && record.presetId ? { presetId: record.presetId } : {}),
    createdAt:
      typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
        ? record.createdAt
        : now,
    updatedAt:
      typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
        ? record.updatedAt
        : now,
  };
}

export function normalizeQuickActionsConfig(raw: unknown): QuickActionsConfig {
  const defaults = createDefaultQuickActionsConfig();
  if (!raw || typeof raw !== "object") {
    return defaults;
  }
  const record = raw as Partial<QuickActionsConfig>;
  const presetStates: Record<string, boolean> = {};
  if (record.presetStates && typeof record.presetStates === "object") {
    for (const [presetId, value] of Object.entries(record.presetStates)) {
      if (typeof value === "boolean" && getQuickActionPreset(presetId)) {
        presetStates[presetId] = value;
      }
    }
  }
  const customActions: QuickActionDefinition[] = [];
  const seen = new Set<string>();
  if (Array.isArray(record.customActions)) {
    for (const item of record.customActions) {
      const normalized = normalizeQuickActionDefinition(item);
      if (!normalized || seen.has(normalized.id)) {
        continue;
      }
      seen.add(normalized.id);
      customActions.push(normalized);
      if (customActions.length >= MAX_CUSTOM_ACTIONS) {
        break;
      }
    }
  }
  return { schemaVersion: 1, presetStates, customActions };
}

export function isQuickActionPresetEnabled(
  config: QuickActionsConfig,
  preset: QuickActionPreset
): boolean {
  const override = config.presetStates[preset.id];
  return typeof override === "boolean" ? override : preset.defaultEnabled;
}

export function materializeQuickActionPreset(preset: QuickActionPreset): QuickActionDefinition {
  return {
    id: `preset:${preset.id}`,
    label: preset.label,
    icon: preset.icon,
    kind: preset.kind,
    ...(preset.command ? { command: preset.command } : {}),
    ...(preset.prompt ? { prompt: preset.prompt } : {}),
    ...(preset.uiCommand ? { uiCommand: preset.uiCommand } : {}),
    visibility: preset.visibility,
    confirm: preset.confirm,
    showPill: preset.showPill,
    keybinding: null,
    enabled: true,
    presetId: preset.id,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Enabled presets (materialized) followed by enabled custom actions. */
export function resolveEffectiveQuickActions(
  config: QuickActionsConfig
): QuickActionDefinition[] {
  const presets = QUICK_ACTION_PRESETS.filter((preset) =>
    isQuickActionPresetEnabled(config, preset)
  ).map(materializeQuickActionPreset);
  const custom = config.customActions.filter((action) => action.enabled);
  return [...presets, ...custom];
}

/** Look up an effective action (preset or custom) by its runtime id. */
export function findEffectiveQuickAction(
  config: QuickActionsConfig,
  actionId: string
): QuickActionDefinition | null {
  if (actionId.startsWith("preset:")) {
    const preset = getQuickActionPreset(actionId.slice("preset:".length));
    if (!preset || !isQuickActionPresetEnabled(config, preset)) {
      return null;
    }
    return materializeQuickActionPreset(preset);
  }
  const custom = config.customActions.find((action) => action.id === actionId);
  return custom && custom.enabled ? custom : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Visibility evaluation (dynamic pills)
// ─────────────────────────────────────────────────────────────────────────────

export type QuickActionVisibilityContext = {
  insights: WorkspaceInsights | null;
  /** True while the active conversation's turn is running. */
  conversationRunning: boolean;
  /** False on drafts/new chats without a persisted conversation. */
  hasConversation: boolean;
};

export function isQuickActionVisibleInContext(
  action: QuickActionDefinition,
  context: QuickActionVisibilityContext
): boolean {
  if (!action.enabled) {
    return false;
  }
  if (action.kind === "prompt" && !context.hasConversation) {
    return false;
  }
  const insights = context.insights;
  switch (action.visibility) {
    case "always":
      return true;
    case "git":
      return insights?.isGitRepo === true;
    case "dirty":
      return insights?.isGitRepo === true && insights.dirty;
    case "conflicts":
      return (
        insights?.isGitRepo === true &&
        (insights.merge.conflictedFiles.length > 0 || insights.merge.conflictsResolved)
      );
    case "ahead":
      return insights?.isGitRepo === true && insights.ahead > 0;
    case "behind":
      return insights?.isGitRepo === true && insights.behind > 0;
    case "running":
      return context.conversationRunning;
    default:
      return true;
  }
}
