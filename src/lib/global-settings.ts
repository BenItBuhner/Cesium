export type GeneralSettingsState = {
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
  /** When true, file-edit diffs and permission cards render in the main chat stream; when false (default), they stay inside the worked-session tool dropdown. */
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
};

export type ModelToggleState = {
  id: string;
  name: string;
  on: boolean;
};

export type ModelsSettingsState = {
  models: ModelToggleState[];
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

export type GlobalAppSettingsSlice = {
  general: GeneralSettingsState;
  agents: AgentsSettingsState;
  models: ModelsSettingsState;
  rules: RulesSettingsState;
  tools: ToolsSettingsState;
};

export type GlobalSettingsState = GlobalAppSettingsSlice & {
  schemaVersion: 1;
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

export function createDefaultGlobalSettings(
  models: ModelToggleState[]
): GlobalSettingsState {
  return {
    schemaVersion: 1,
    keyboardShortcuts: createDefaultKeyboardShortcutsState(),
    general: {
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
      inlineToolDetailsInChat: false,
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
    },
    models: {
      models,
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

/** Merge server/local partial payload onto defaults (survives missing `keyboardShortcuts`). */
export function normalizeLoadedGlobalSettings(
  raw: unknown,
  modelsFallback: ModelToggleState[]
): GlobalSettingsState {
  const base = createDefaultGlobalSettings(modelsFallback);
  if (!raw || typeof raw !== "object") {
    return base;
  }
  const r = raw as Partial<GlobalSettingsState>;
  if (r.schemaVersion !== 1) {
    return base;
  }

  return {
    schemaVersion: 1,
    keyboardShortcuts: normalizeKeyboardShortcutsState(r.keyboardShortcuts),
    general: { ...base.general, ...(r.general ?? {}) },
    agents: {
      ...base.agents,
      ...(r.agents ?? {}),
      cmdTags: r.agents?.cmdTags ?? base.agents.cmdTags,
      modeTags: r.agents?.modeTags ?? base.agents.modeTags,
    },
    models: {
      models:
        r.models?.models && r.models.models.length > 0
          ? r.models.models
          : base.models.models,
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
