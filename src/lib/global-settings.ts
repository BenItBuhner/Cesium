export type GeneralSettingsState = {
  doNotDisturb: boolean;
  sysNotify: boolean;
  warnNotify: boolean;
  trayIcon: boolean;
  completionSound: boolean;
  sideColumnsSwapped: boolean;
};

export type AgentsSettingsState = {
  submitCtrlEnter: boolean;
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
   * When true, file-edit diffs and command permission prompts are separate blocks in the main
   * chat. When false, they stay inside the worked-session tool area.
   */
  inlineToolDetailsInChat: boolean;
  collapseAuto: boolean;
  commitAttr: boolean;
  prAttr: boolean;
  fileDel: boolean;
  extFile: boolean;
  browserProt: boolean;
  mcpProt: boolean;
  cmdTags: string[];
  modeTags: string[];
  branchPrefix: string;
  /**
   * When true, the server auto-approves agent tool permission prompts (ACP). Explicit “always allow”
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

export type RulesSettingsState = {
  thirdParty: boolean;
};

export type PluginMcpState = {
  id: string;
  name: string;
  status: string;
  on: boolean;
  connect?: boolean;
};

export type ToolsSettingsState = {
  localhost: boolean;
  mcpTags: string[];
  domainTags: string[];
  pluginState: PluginMcpState[];
};

import {
  createDefaultKeyboardShortcutsState,
  normalizeKeyboardShortcutsState,
  type KeyboardShortcutsSettingsState,
} from "@/lib/keyboard-shortcuts";
import {
  createDefaultThemeConfig,
  normalizeThemeConfig,
  type ThemeConfig,
} from "@/lib/theme-config";

export type GlobalAppSettingsSlice = {
  general: GeneralSettingsState;
  agents: AgentsSettingsState;
  models: ModelsSettingsState;
  rules: RulesSettingsState;
  tools: ToolsSettingsState;
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

export const DEFAULT_MCP_TAGS = [
  "figma:get_design_context",
  "figma:get_screenshot",
  "linear:get_issue",
  "linear:list_issues",
  "notion:notion-search",
  "slack:slack_read_channel",
];

export const DEFAULT_DOMAIN_TAGS = [
  "raw.githubusercontent.com",
  "github.com",
  "docs.polymarket.com",
  "api.github.com",
  "developer.notion.com",
  "www.todoist.com",
];

export const DEFAULT_PLUGIN_MCP_STATE: PluginMcpState[] = [
  { id: "c7", name: "context7", status: "2 tools enabled", on: true },
  {
    id: "fg",
    name: "Figma",
    status: "13 tools, 1 prompts, 25 resources enabled",
    on: true,
  },
  { id: "ln", name: "Linear", status: "34 tools enabled", on: true },
  {
    id: "nt",
    name: "Notion",
    status: "needs authentication",
    on: false,
    connect: true,
  },
  {
    id: "sl",
    name: "Slack",
    status: "13 tools, 1 resources enabled",
    on: true,
  },
];

export function createDefaultGlobalSettings(): GlobalSettingsState {
  return {
    schemaVersion: 1,
    themeConfig: createDefaultThemeConfig(),
    keyboardShortcuts: createDefaultKeyboardShortcutsState(),
    general: {
      doNotDisturb: false,
      sysNotify: true,
      warnNotify: false,
      trayIcon: true,
      completionSound: true,
      sideColumnsSwapped: false,
    },
    agents: {
      submitCtrlEnter: false,
      autocomplete: false,
      webSearch: true,
      autoWeb: true,
      webFetch: true,
      hierIgnore: false,
      symlinkIgnore: false,
      legacyTerm: false,
      autoParse: false,
      themedDiff: true,
      /** Default on so edits are not hidden behind the tool dropdown. */
      inlineToolDetailsInChat: true,
      collapseAuto: true,
      commitAttr: true,
      prAttr: true,
      fileDel: true,
      extFile: true,
      browserProt: false,
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
    rules: {
      thirdParty: true,
    },
    tools: {
      localhost: true,
      mcpTags: DEFAULT_MCP_TAGS,
      domainTags: DEFAULT_DOMAIN_TAGS,
      pluginState: DEFAULT_PLUGIN_MCP_STATE,
    },
  };
}

function normalizeRememberedPermissions(raw: unknown): RememberedAgentPermissionRule[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((item): RememberedAgentPermissionRule[] => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Partial<RememberedAgentPermissionRule>;
    const workspaceId = typeof record.workspaceId === "string" ? record.workspaceId.trim() : "";
    const backendId = typeof record.backendId === "string" ? record.backendId.trim() : "";
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
    general: { ...base.general, ...(r.general ?? {}) },
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
          ? (r.models.byBackend as Record<string, ModelToggleState[]>)
          : base.models.byBackend,
    },
    rules: { ...base.rules, ...(r.rules ?? {}) },
    tools: {
      ...base.tools,
      ...(r.tools ?? {}),
      mcpTags: r.tools?.mcpTags ?? base.tools.mcpTags,
      domainTags: r.tools?.domainTags ?? base.tools.domainTags,
      pluginState: r.tools?.pluginState ?? base.tools.pluginState,
    },
  };
}
