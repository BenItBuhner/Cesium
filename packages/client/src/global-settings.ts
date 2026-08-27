import {
  normalizeEnabledHarnesses,
  normalizeHarnessTransports,
  pruneModelToggleByBackend,
  type HarnessTransportsState,
} from "@cesium/core";
import { normalizeAgentConversationMruByServer } from "./agent-conversation-mru";
import {
  createDefaultAuroraSettings,
  normalizeAuroraSettings,
  type AuroraSettingsState,
} from "./aurora-settings";
import {
  createDefaultKeyboardShortcutsState,
  normalizeKeyboardShortcutsState,
  type KeyboardShortcutsSettingsState,
} from "./keyboard-shortcuts";
import {
  createDefaultThemeConfig,
  normalizeThemeConfig,
  type ThemeConfig,
} from "./theme-config";
import {
  isAgentRailRowDetailMode,
  type AgentRailRowDetailMode,
} from "./agent-rail-status";
import {
  normalizeQuickOpenScope,
  normalizeQuickSwitcherScope,
  type QuickOpenScopeId,
  type QuickSwitcherScopeId,
} from "./quick-open-scopes";
import {
  normalizeComposerStatusBarVisibility,
  type ComposerStatusBarVisibility,
} from "./composer-status-bar";

export type WorkspaceSortMode = "recent" | "alphabetical" | "machine" | "custom";
export type AgentRailGroupByMode = "workspace" | "priority";

/** Retired group-by modes; persisted values migrate to `workspace`. */
const LEGACY_AGENT_RAIL_GROUP_BY = new Set(["repository", "server", "updated", "status"]);

export type AgentRailSectionId =
  | "attention"
  | "running"
  | "pinned"
  | "chats"
  | "workspaces";

export const AGENT_RAIL_SECTION_IDS: AgentRailSectionId[] = [
  "attention",
  "running",
  "pinned",
  "chats",
  "workspaces",
];

export type AgentRailScope =
  | { type: "all" }
  | { type: "no-workspace" }
  | { type: "workspace"; workspaceKey: string };

export const AGENT_RAIL_VIEW_PRESETS = ["default", "inbox", "compact"] as const;
export type AgentRailViewPreset = (typeof AGENT_RAIL_VIEW_PRESETS)[number];

export type ChatFolderState = {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
  icon: string;
  sortOrder: number;
  conversationIds: string[];
};

/** Per server-scoped workspace key (`serverId:workspaceId`). */
export type WorkspaceRailAppearance = {
  icon: string;
  color: string;
};

/** Per server id (`ServerConnection.id`). */
export type ServerRailAppearance = {
  icon: string;
  color: string;
  nickname?: string;
};

/**
 * Widgets available on the new-chat landing beneath the composer. Users can
 * reorder and hide them from the landing's customize menu.
 */
export const NEW_CHAT_WIDGET_IDS = [
  "shortcuts",
  "actions",
  "recent-chats",
  "recent-activity",
] as const;

export type NewChatWidgetId = (typeof NEW_CHAT_WIDGET_IDS)[number];

export type NewChatWidgetsState = {
  /** Render order. Unknown/missing ids are appended in default order. */
  order: NewChatWidgetId[];
  /** Widgets removed from the landing. */
  hidden: NewChatWidgetId[];
};

export function isNewChatWidgetId(value: unknown): value is NewChatWidgetId {
  return NEW_CHAT_WIDGET_IDS.includes(value as NewChatWidgetId);
}

export function createDefaultNewChatWidgetsState(): NewChatWidgetsState {
  return { order: [...NEW_CHAT_WIDGET_IDS], hidden: [] };
}

function dedupeNewChatWidgetIds(raw: unknown): NewChatWidgetId[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<NewChatWidgetId>();
  const out: NewChatWidgetId[] = [];
  for (const value of raw) {
    if (!isNewChatWidgetId(value) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function normalizeNewChatWidgetsState(raw: unknown): NewChatWidgetsState {
  const defaults = createDefaultNewChatWidgetsState();
  if (!raw || typeof raw !== "object") {
    return defaults;
  }
  const record = raw as Partial<NewChatWidgetsState>;
  const ordered = dedupeNewChatWidgetIds(record.order);
  return {
    order: [
      ...ordered,
      ...NEW_CHAT_WIDGET_IDS.filter((id) => !ordered.includes(id)),
    ],
    hidden: dedupeNewChatWidgetIds(record.hidden),
  };
}

export type GeneralSettingsState = {
  doNotDisturb: boolean;
  /**
   * Coalesce high-frequency token and progress events before updating React
   * state. Enabled by default to cap stream rendering at roughly 20 Hz.
   */
  batchStreamEvents: boolean;
  /**
   * Show the floating ambient voice orb. Off by default: the orb is an opt-in
   * surface and hiding it also disables the ambient voice plane.
   */
  showVoiceOrb: boolean;
  sideColumnsSwapped: boolean;
  workspaceSortMode: WorkspaceSortMode;
  workspaceCustomOrderIds: string[];
  workspaceRailAppearances: Record<string, WorkspaceRailAppearance>;
  serverRailAppearances: Record<string, ServerRailAppearance>;
  /** Per-server MRU of agent conversation ids for Ctrl+Tab switcher. */
  agentConversationMruByServer: Record<string, string[]>;
  /** Scope Quick Open (Mod+P) starts in - files, chats, commands, settings, or tabs. */
  quickOpenDefaultScope: QuickOpenScopeId;
  /** What the hold-to-cycle (Mod+Tab) switcher steps through. */
  quickSwitcherScope: QuickSwitcherScopeId;
  chatFolders: ChatFolderState[];
  /**
   * Custom root (unfoldered) conversation order keyed by folder scope id.
   * Scope is a real workspace id, or `__agentStandaloneChats__` for the Chats section.
   */
  chatRootOrderByScope: Record<string, string[]>;
  agentRail: AgentRailSettingsState;
  /** Order + visibility of the widgets on the new-chat landing. */
  newChatWidgets: NewChatWidgetsState;
  /**
   * Defaults for the repo / branch / goal / context row beneath the composer.
   * Omitted on legacy profiles so their workspace's last-used value migrates
   * naturally until the user changes a toggle or saves an explicit default.
   */
  composerStatusBarVisibility?: ComposerStatusBarVisibility;
};

export type AgentRailSettingsState = {
  groupBy: AgentRailGroupByMode;
  visibleStatusFilters: string[];
  /** Legacy allow-list kept only so old persisted settings can be read. New filtering uses hiddenServerIds. */
  visibleServerIds: string[];
  hiddenServerIds: string[];
  showIcons: boolean;
  /**
   * Opt-in "Settled" mode. When enabled, rows grow a small settle toggle and
   * settled conversations sink to the bottom until a new prompt unsettles
   * them. When disabled, no settle controls render and any persisted settled
   * flags are ignored.
   */
  settledMode: boolean;
  /** Per-row detail density: compact, auto (smart), or expanded. */
  rowDetail: AgentRailRowDetailMode;
  /**
   * Top-level rail section order. Unknown/missing ids are appended in default order.
   * Default: attention → pinned → chats (standalone) → workspaces.
   * The chats section is no longer rendered; it stays here so old settings round-trip.
   */
  sectionOrder: AgentRailSectionId[];
  /** Sections omitted from the rail (e.g. hide Needs attention). */
  hiddenSections: AgentRailSectionId[];
  /** Rail list scope: every workspace, or one workspace. */
  scope: AgentRailScope;
};

export type AgentsSettingsState = {
  submitCtrlEnter: boolean;
  steerCtrlEnter: boolean;
  autocomplete: boolean;
  webSearch: boolean;
  autoWeb: boolean;
  webFetch: boolean;
  hierIgnore: boolean;
  symlinkIgnore: boolean;
  legacyTerm: boolean;
  autoParse: boolean;
  themedDiff: boolean;
  /**
   * Legacy preference retained for persisted settings. Tool details now stay inside the
   * worked-session dropdown so collapse state and chronological order remain consistent.
   */
  inlineToolDetailsInChat: boolean;
  collapseAuto: boolean;
  commitAttr: boolean;
  prAttr: boolean;
  fileDel: boolean;
  extFile: boolean;
  browserProt: boolean;
  newBrowser: boolean;
  mcpProt: boolean;
  cmdTags: string[];
  modeTags: string[];
  branchPrefix: string;
  /**
   * When true, the server auto-approves agent tool permission prompts. Explicit “always allow”
   * rules still apply first. Turning this on is risky; it does not add entries to the list below.
   */
  autoAcceptAllAgentPermissions: boolean;
  rememberedPermissions: RememberedAgentPermissionRule[];
  /**
   * Per-harness visibility in the composer picker. Missing keys default to on.
   * Existing chats on a turned-off harness still run.
   */
  enabledHarnesses: Partial<Record<string, boolean>>;
  /**
   * Preferred transport inside a multi-runtime harness family.
   * Cursor defaults to SDK; Codex defaults to the app server.
   */
  harnessTransports: HarnessTransportsState;
};

export type RememberedAgentPermissionRule = {
  id: string;
  workspaceId: string;
  backendId: string;
  toolKey: string;
  toolLabel: string;
  decision: "allow" | "reject";
  optionId: string;
  optionKind: "allow_always" | "reject_always";
  permissionCategory?: "editFile" | "terminal" | "mcpCall" | "switchMode";
  matchStyle?: "exact" | "category";
  createdAt: number;
  updatedAt: number;
};

export type ModelToggleState = {
  id: string;
  name: string;
  on: boolean;
  backendId?: string;
};

export type ModelsSettingsState = {
  byBackend: Record<string, ModelToggleState[]>;
};

/** Reserved for future tool/MCP preferences; persisted object is always empty today. */
export type ToolsSettingsState = Record<string, never>;

export type FeaturesSettingsState = {
  vscodeExtensionsBeta: boolean;
};

export type GlobalAppSettingsSlice = {
  general: GeneralSettingsState;
  agents: AgentsSettingsState;
  models: ModelsSettingsState;
  tools: ToolsSettingsState;
  features: FeaturesSettingsState;
};

export type GlobalSettingsState = GlobalAppSettingsSlice & {
  schemaVersion: 1;
  /** Appearance, light/dark theme ids, custom token presets; persisted on the server. */
  themeConfig: ThemeConfig;
  keyboardShortcuts: KeyboardShortcutsSettingsState;
  /** Animated aurora backdrop behind the workbench and settings. */
  aurora: AuroraSettingsState;
};

export const DEFAULT_CMD_TAGS = [
  "pip install *",
  "npm install *",
  "uv install *",
  "python *",
  "cd *",
  "ls *",
  "grep *",
  "Select-Object *",
];

export const DEFAULT_MODE_TAGS = ["agent-plan"];

export function createDefaultGlobalSettings(): GlobalSettingsState {
  return {
    schemaVersion: 1,
    themeConfig: createDefaultThemeConfig(),
    keyboardShortcuts: createDefaultKeyboardShortcutsState(),
    aurora: createDefaultAuroraSettings(),
    general: {
      doNotDisturb: false,
      batchStreamEvents: true,
      showVoiceOrb: false,
      sideColumnsSwapped: false,
      workspaceSortMode: "recent",
      workspaceCustomOrderIds: [],
      workspaceRailAppearances: {},
      serverRailAppearances: {},
      agentConversationMruByServer: {},
      quickOpenDefaultScope: "files",
      quickSwitcherScope: "conversations",
      chatFolders: [],
      chatRootOrderByScope: {},
      agentRail: {
        groupBy: "workspace",
        visibleStatusFilters: [],
        visibleServerIds: [],
        hiddenServerIds: [],
        showIcons: true,
        settledMode: false,
        rowDetail: "balanced",
        sectionOrder: ["attention", "running", "pinned", "chats", "workspaces"],
        hiddenSections: [],
        scope: { type: "all" },
      },
      newChatWidgets: createDefaultNewChatWidgetsState(),
    },
    agents: {
      submitCtrlEnter: false,
      steerCtrlEnter: true,
      autocomplete: false,
      webSearch: true,
      autoWeb: true,
      webFetch: true,
      hierIgnore: false,
      symlinkIgnore: false,
      legacyTerm: false,
      autoParse: false,
      themedDiff: true,
      inlineToolDetailsInChat: false,
      collapseAuto: true,
      commitAttr: true,
      prAttr: true,
      fileDel: true,
      extFile: true,
      browserProt: false,
      newBrowser: false,
      mcpProt: false,
      cmdTags: DEFAULT_CMD_TAGS,
      modeTags: DEFAULT_MODE_TAGS,
      branchPrefix: "cursor/",
      autoAcceptAllAgentPermissions: false,
      rememberedPermissions: [],
      enabledHarnesses: {},
      harnessTransports: {},
    },
    models: {
      byBackend: {},
    },
    tools: {},
    features: {
      vscodeExtensionsBeta: false,
    },
  };
}

function normalizeWorkspaceSortMode(raw: unknown): WorkspaceSortMode {
  return raw === "recent" || raw === "alphabetical" || raw === "machine" || raw === "custom"
    ? raw
    : "recent";
}

function normalizeWorkspaceCustomOrderIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out.slice(0, 500);
}

function normalizeServerRailAppearances(
  raw: unknown
): Record<string, ServerRailAppearance> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: Record<string, ServerRailAppearance> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= 100) {
      break;
    }
    const serverId = typeof key === "string" ? key.trim() : "";
    if (!serverId || !value || typeof value !== "object") {
      continue;
    }
    const record = value as Partial<ServerRailAppearance>;
    const rawColor = typeof record.color === "string" ? record.color.trim() : "";
    const rawIcon = typeof record.icon === "string" ? record.icon.trim() : "";
    const rawNickname =
      typeof record.nickname === "string" ? record.nickname.trim().slice(0, 80) : "";
    if (!rawIcon && !/^#[0-9a-f]{6}$/i.test(rawColor) && !rawNickname) {
      continue;
    }
    out[serverId] = {
      icon: rawIcon || "Globe",
      color: /^#[0-9a-f]{6}$/i.test(rawColor) ? rawColor : "#2563eb",
      ...(rawNickname ? { nickname: rawNickname } : {}),
    };
    count += 1;
  }
  return out;
}

function normalizeWorkspaceRailAppearances(
  raw: unknown
): Record<string, WorkspaceRailAppearance> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: Record<string, WorkspaceRailAppearance> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= 500) {
      break;
    }
    const workspaceKey = typeof key === "string" ? key.trim() : "";
    if (!workspaceKey || !value || typeof value !== "object") {
      continue;
    }
    const record = value as Partial<WorkspaceRailAppearance>;
    const rawColor = typeof record.color === "string" ? record.color.trim() : "";
    const rawIcon = typeof record.icon === "string" ? record.icon.trim() : "";
    if (!rawIcon && !/^#[0-9a-f]{6}$/i.test(rawColor)) {
      continue;
    }
    out[workspaceKey] = {
      icon: rawIcon || "Folder",
      color: /^#[0-9a-f]{6}$/i.test(rawColor) ? rawColor : "#7c3aed",
    };
    count += 1;
  }
  return out;
}

function normalizeChatFolders(raw: unknown): ChatFolderState[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seenFolderIds = new Set<string>();
  const folders: ChatFolderState[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Partial<ChatFolderState>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const workspaceId = typeof record.workspaceId === "string" ? record.workspaceId.trim() : "";
    if (!id || !workspaceId || seenFolderIds.has(id)) {
      continue;
    }
    seenFolderIds.add(id);
    const seenConversationIds = new Set<string>();
    const conversationIds = Array.isArray(record.conversationIds)
      ? record.conversationIds.flatMap((value): string[] => {
          if (typeof value !== "string" || !value || seenConversationIds.has(value)) {
            return [];
          }
          seenConversationIds.add(value);
          return [value];
        })
      : [];
    const rawColor = typeof record.color === "string" ? record.color.trim() : "";
    const rawIcon = typeof record.icon === "string" ? record.icon.trim() : "";
    folders.push({
      id,
      workspaceId,
      name:
        typeof record.name === "string" && record.name.trim()
          ? record.name.trim().slice(0, 80)
          : "Folder",
      color: /^#[0-9a-f]{6}$/i.test(rawColor) ? rawColor : "#7c3aed",
      icon: rawIcon || "Folder",
      sortOrder:
        typeof record.sortOrder === "number" && Number.isFinite(record.sortOrder)
          ? record.sortOrder
          : folders.length,
      conversationIds,
    });
  }
  return folders.slice(0, 500);
}

function normalizeChatRootOrderByScope(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: Record<string, string[]> = {};
  let scopeCount = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (scopeCount >= 500) {
      break;
    }
    const scopeId = typeof key === "string" ? key.trim() : "";
    if (!scopeId || !Array.isArray(value)) {
      continue;
    }
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || !item || seen.has(item)) {
        continue;
      }
      if (ids.length >= 2000) {
        break;
      }
      seen.add(item);
      ids.push(item);
    }
    if (ids.length === 0) {
      continue;
    }
    out[scopeId] = ids;
    scopeCount += 1;
  }
  return out;
}

function normalizeAgentRailSectionIds(raw: unknown): AgentRailSectionId[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<AgentRailSectionId>();
  const out: AgentRailSectionId[] = [];
  for (const value of raw) {
    if (
      value !== "attention" &&
      value !== "running" &&
      value !== "pinned" &&
      value !== "chats" &&
      value !== "workspaces"
    ) {
      continue;
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

function normalizeAgentRailScope(raw: unknown): AgentRailScope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { type: "all" };
  }
  const record = raw as { type?: unknown; workspaceKey?: unknown };
  if (record.type === "no-workspace") {
    return { type: "no-workspace" };
  }
  if (
    record.type === "workspace" &&
    typeof record.workspaceKey === "string" &&
    record.workspaceKey.length > 0
  ) {
    return { type: "workspace", workspaceKey: record.workspaceKey };
  }
  return { type: "all" };
}

function normalizeAgentRailGroupBy(raw: unknown, fallback: AgentRailGroupByMode): AgentRailGroupByMode {
  if (raw === "workspace" || raw === "priority") {
    return raw;
  }
  if (typeof raw === "string" && LEGACY_AGENT_RAIL_GROUP_BY.has(raw)) {
    return "workspace";
  }
  return fallback;
}

export function applyAgentRailViewPreset(
  preset: AgentRailViewPreset,
  current: AgentRailSettingsState
): AgentRailSettingsState {
  const homeSections = (current.hiddenSections ?? []).filter(
    (id) => id !== "attention" && id !== "running" && id !== "pinned"
  );
  switch (preset) {
    case "inbox":
      return {
        ...current,
        groupBy: "priority",
        rowDetail: current.rowDetail === "compact" ? "balanced" : current.rowDetail,
      };
    case "compact":
      return {
        ...current,
        groupBy: "workspace",
        rowDetail: "compact",
        scope: { type: "all" },
        hiddenSections: homeSections,
      };
    default:
      return {
        ...current,
        groupBy: "workspace",
        rowDetail: "balanced",
        scope: { type: "all" },
        hiddenSections: homeSections,
      };
  }
}

export function matchingAgentRailViewPreset(
  settings: Pick<AgentRailSettingsState, "groupBy" | "rowDetail">
): AgentRailViewPreset | null {
  if (settings.groupBy === "priority" && settings.rowDetail !== "compact") {
    return "inbox";
  }
  if (settings.groupBy === "workspace" && settings.rowDetail === "compact") {
    return "compact";
  }
  if (settings.groupBy === "workspace" && settings.rowDetail === "balanced") {
    return "default";
  }
  return null;
}

function normalizeAgentRailSettings(raw: unknown): AgentRailSettingsState {
  const defaults = createDefaultGlobalSettings().general.agentRail;
  if (!raw || typeof raw !== "object") {
    return defaults;
  }
  const record = raw as Partial<AgentRailSettingsState> & { groupBy?: unknown; scope?: unknown };
  const groupBy = normalizeAgentRailGroupBy(record.groupBy, defaults.groupBy);
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  const ordered = normalizeAgentRailSectionIds(record.sectionOrder);
  // Settings persisted before the attention section existed should surface it
  // in its default slot (the very top), not appended at the bottom.
  if (!ordered.includes("attention")) {
    ordered.unshift("attention");
  }
  // Same for the running section: default slot is right below Needs attention.
  if (!ordered.includes("running")) {
    ordered.splice(ordered.indexOf("attention") + 1, 0, "running");
  }
  const sectionOrder: AgentRailSectionId[] = [
    ...ordered,
    ...AGENT_RAIL_SECTION_IDS.filter((id) => !ordered.includes(id)),
  ];
  const hiddenSections = normalizeAgentRailSectionIds(record.hiddenSections).filter(
    (id) => id !== "workspaces"
  );
  return {
    groupBy,
    visibleStatusFilters: [],
    // Do not preserve legacy allow-lists. They hide newly added servers forever,
    // which is catastrophic for a dynamic multi-server rail.
    visibleServerIds: [],
    hiddenServerIds: strings(record.hiddenServerIds),
    showIcons:
      typeof record.showIcons === "boolean" ? record.showIcons : defaults.showIcons,
    settledMode:
      typeof record.settledMode === "boolean" ? record.settledMode : defaults.settledMode,
    rowDetail: isAgentRailRowDetailMode(record.rowDetail)
      ? record.rowDetail
      : // Pre-release name for the balanced mode; migrate quietly.
        (record.rowDetail as unknown) === "auto"
        ? "balanced"
        : defaults.rowDetail,
    sectionOrder,
    hiddenSections,
    scope: normalizeAgentRailScope(record.scope),
  };
}

function normalizeRememberedPermissions(raw: unknown): RememberedAgentPermissionRule[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const REMEMBERED_PERMISSION_BACKEND_REMAP: Record<string, string> = {
    cesium: "cesium-agent",
    "claude-adapter": "claude-code-sdk",
    "opencode-acp": "opencode-server",
    "opencode-v2-beta": "opencode-server",
    "codex-adapter": "codex-app-server",
    "gemini-acp": "google-antigravity-cli",
  };
  const normalizeBackendId = (backendId: string): string =>
    REMEMBERED_PERMISSION_BACKEND_REMAP[backendId] ?? backendId;
  return raw.flatMap((item): RememberedAgentPermissionRule[] => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Partial<RememberedAgentPermissionRule>;
    const workspaceId = typeof record.workspaceId === "string" ? record.workspaceId.trim() : "";
    const backendId = normalizeBackendId(
      typeof record.backendId === "string" ? record.backendId.trim() : ""
    );
    const toolKey = typeof record.toolKey === "string" ? record.toolKey.trim() : "";
    const decision = record.decision === "allow" || record.decision === "reject" ? record.decision : null;
    const optionKind =
      record.optionKind === "allow_always" || record.optionKind === "reject_always"
        ? record.optionKind
        : decision === "allow"
          ? "allow_always"
          : decision === "reject"
            ? "reject_always"
            : null;
    if (!workspaceId || !backendId || !toolKey || !decision || !optionKind) {
      return [];
    }
    const now = Date.now();
    return [
      {
        id:
          typeof record.id === "string" && record.id.trim()
            ? record.id.trim()
            : `${workspaceId}:${backendId}:${toolKey}`,
        workspaceId,
        backendId,
        toolKey,
        toolLabel:
          typeof record.toolLabel === "string" && record.toolLabel.trim()
            ? record.toolLabel.trim().slice(0, 160)
            : "Tool permission",
        decision,
        optionId:
          typeof record.optionId === "string" && record.optionId.trim()
            ? record.optionId.trim()
            : optionKind,
        optionKind,
        permissionCategory:
          record.permissionCategory === "editFile" ||
          record.permissionCategory === "terminal" ||
          record.permissionCategory === "mcpCall" ||
          record.permissionCategory === "switchMode"
            ? record.permissionCategory
            : undefined,
        matchStyle:
          record.matchStyle === "exact" || record.matchStyle === "category"
            ? record.matchStyle
            : undefined,
        createdAt:
          typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
            ? record.createdAt
            : now,
        updatedAt:
          typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
            ? record.updatedAt
            : now,
      },
    ];
  });
}

export function normalizeLoadedGlobalSettings(
  raw: unknown
): GlobalSettingsState {
  const base = createDefaultGlobalSettings();
  if (!raw || typeof raw !== "object") {
    return base;
  }
  const r = raw as Partial<GlobalSettingsState> & {
    models?: { models?: unknown; byBackend?: Record<string, unknown> };
  };
  if (r.schemaVersion !== 1) {
    return base;
  }

  return {
    schemaVersion: 1,
    themeConfig: normalizeThemeConfig((r as { themeConfig?: unknown }).themeConfig),
    keyboardShortcuts: normalizeKeyboardShortcutsState(r.keyboardShortcuts),
    aurora: normalizeAuroraSettings((r as { aurora?: unknown }).aurora),
    general: {
      ...base.general,
      ...(r.general ?? {}),
      batchStreamEvents:
        typeof (r.general as Record<string, unknown> | undefined)
          ?.batchStreamEvents === "boolean"
          ? ((r.general as Record<string, unknown>).batchStreamEvents as boolean)
          : base.general.batchStreamEvents,
      showVoiceOrb:
        typeof (r.general as Record<string, unknown> | undefined)?.showVoiceOrb === "boolean"
          ? ((r.general as Record<string, unknown>).showVoiceOrb as boolean)
          : base.general.showVoiceOrb,
      workspaceSortMode: normalizeWorkspaceSortMode(
        (r.general as Record<string, unknown> | undefined)?.workspaceSortMode
      ),
      workspaceCustomOrderIds: normalizeWorkspaceCustomOrderIds(
        (r.general as Record<string, unknown> | undefined)?.workspaceCustomOrderIds
      ),
      workspaceRailAppearances: normalizeWorkspaceRailAppearances(
        (r.general as Record<string, unknown> | undefined)?.workspaceRailAppearances
      ),
      serverRailAppearances: normalizeServerRailAppearances(
        (r.general as Record<string, unknown> | undefined)?.serverRailAppearances
      ),
      agentConversationMruByServer: normalizeAgentConversationMruByServer(
        (r.general as Record<string, unknown> | undefined)?.agentConversationMruByServer
      ),
      quickOpenDefaultScope: normalizeQuickOpenScope(
        (r.general as Record<string, unknown> | undefined)?.quickOpenDefaultScope
      ),
      quickSwitcherScope: normalizeQuickSwitcherScope(
        (r.general as Record<string, unknown> | undefined)?.quickSwitcherScope
      ),
      chatFolders: normalizeChatFolders(
        (r.general as Record<string, unknown> | undefined)?.chatFolders
      ),
      chatRootOrderByScope: normalizeChatRootOrderByScope(
        (r.general as Record<string, unknown> | undefined)?.chatRootOrderByScope
      ),
      agentRail: normalizeAgentRailSettings(
        (r.general as Record<string, unknown> | undefined)?.agentRail
      ),
      newChatWidgets: normalizeNewChatWidgetsState(
        (r.general as Record<string, unknown> | undefined)?.newChatWidgets
      ),
      composerStatusBarVisibility:
        (r.general as Record<string, unknown> | undefined)
          ?.composerStatusBarVisibility === undefined
          ? undefined
          : normalizeComposerStatusBarVisibility(
              (r.general as Record<string, unknown>).composerStatusBarVisibility
            ),
    },
    agents: {
      ...base.agents,
      ...(r.agents ?? {}),
      cmdTags: r.agents?.cmdTags ?? base.agents.cmdTags,
      modeTags: r.agents?.modeTags ?? base.agents.modeTags,
      autoAcceptAllAgentPermissions:
        typeof r.agents?.autoAcceptAllAgentPermissions === "boolean"
          ? r.agents.autoAcceptAllAgentPermissions
          : base.agents.autoAcceptAllAgentPermissions,
      rememberedPermissions: normalizeRememberedPermissions(
        r.agents?.rememberedPermissions
      ),
      enabledHarnesses: normalizeEnabledHarnesses(r.agents?.enabledHarnesses),
      harnessTransports: normalizeHarnessTransports(r.agents?.harnessTransports),
    },
    models: {
      byBackend:
        r.models?.byBackend && Object.keys(r.models.byBackend).length > 0
          ? pruneModelToggleByBackend(
              r.models.byBackend as Record<string, ModelToggleState[]>
            )
          : base.models.byBackend,
    },
    tools: {},
    features: {
      vscodeExtensionsBeta:
        typeof (r as { features?: { vscodeExtensionsBeta?: unknown } }).features
          ?.vscodeExtensionsBeta === "boolean"
          ? (r as { features: { vscodeExtensionsBeta: boolean } }).features
              .vscodeExtensionsBeta
          : base.features.vscodeExtensionsBeta,
    },
  };
}
