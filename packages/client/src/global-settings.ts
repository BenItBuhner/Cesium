import { pruneModelToggleByBackend } from "@cesium/core";
import { normalizeAgentConversationMruByServer } from "./agent-conversation-mru";
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

export type WorkspaceSortMode = "recent" | "alphabetical" | "custom";
export type AgentRailGroupByMode = "workspace" | "repository" | "server" | "updated" | "status";

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

export type GeneralSettingsState = {
  doNotDisturb: boolean;
  sideColumnsSwapped: boolean;
  workspaceSortMode: WorkspaceSortMode;
  workspaceCustomOrderIds: string[];
  workspaceRailAppearances: Record<string, WorkspaceRailAppearance>;
  serverRailAppearances: Record<string, ServerRailAppearance>;
  /** Per-server MRU of agent conversation ids for Ctrl+Tab switcher. */
  agentConversationMruByServer: Record<string, string[]>;
  chatFolders: ChatFolderState[];
  agentRail: AgentRailSettingsState;
};

export type AgentRailSettingsState = {
  groupBy: AgentRailGroupByMode;
  visibleStatusFilters: string[];
  /** Legacy allow-list kept only so old persisted settings can be read. New filtering uses hiddenServerIds. */
  visibleServerIds: string[];
  hiddenServerIds: string[];
  showIcons: boolean;
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
  goalModeBeta: boolean;
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
    general: {
      doNotDisturb: false,
      sideColumnsSwapped: false,
      workspaceSortMode: "recent",
      workspaceCustomOrderIds: [],
      workspaceRailAppearances: {},
      serverRailAppearances: {},
      agentConversationMruByServer: {},
      chatFolders: [],
      agentRail: {
        groupBy: "workspace",
        visibleStatusFilters: [],
        visibleServerIds: [],
        hiddenServerIds: [],
        showIcons: true,
      },
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
    },
    models: {
      byBackend: {},
    },
    tools: {},
    features: {
      vscodeExtensionsBeta: false,
      goalModeBeta: false,
    },
  };
}

function normalizeWorkspaceSortMode(raw: unknown): WorkspaceSortMode {
  return raw === "recent" || raw === "alphabetical" || raw === "custom"
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

function normalizeAgentRailSettings(raw: unknown): AgentRailSettingsState {
  const defaults = createDefaultGlobalSettings().general.agentRail;
  if (!raw || typeof raw !== "object") {
    return defaults;
  }
  const record = raw as Partial<AgentRailSettingsState>;
  const rawGroupBy =
    record.groupBy === "workspace" ||
    record.groupBy === "repository" ||
    record.groupBy === "server" ||
    record.groupBy === "updated" ||
    record.groupBy === "status"
      ? record.groupBy
      : defaults.groupBy;
  const groupBy = rawGroupBy === "server" ? "workspace" : rawGroupBy;
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  return {
    groupBy,
    visibleStatusFilters: strings(record.visibleStatusFilters),
    // Do not preserve legacy allow-lists. They hide newly added servers forever,
    // which is catastrophic for a dynamic multi-server rail.
    visibleServerIds: [],
    hiddenServerIds: strings(record.hiddenServerIds),
    showIcons:
      typeof record.showIcons === "boolean" ? record.showIcons : defaults.showIcons,
  };
}

function normalizeRememberedPermissions(raw: unknown): RememberedAgentPermissionRule[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const REMEMBERED_PERMISSION_BACKEND_REMAP: Record<string, string> = {
    cesium: "cesium-agent",
    "cursor-acp": "cursor-sdk",
    "claude-adapter": "claude-code-sdk",
    "opencode-acp": "opencode-server",
    "codex-adapter": "codex-app-server",
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
    general: {
      ...base.general,
      ...(r.general ?? {}),
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
      chatFolders: normalizeChatFolders(
        (r.general as Record<string, unknown> | undefined)?.chatFolders
      ),
      agentRail: normalizeAgentRailSettings(
        (r.general as Record<string, unknown> | undefined)?.agentRail
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
      goalModeBeta:
        typeof (r as { features?: { goalModeBeta?: unknown } }).features
          ?.goalModeBeta === "boolean"
          ? (r as { features: { goalModeBeta: boolean } }).features.goalModeBeta
          : base.features.goalModeBeta,
    },
  };
}
