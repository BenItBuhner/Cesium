export type GeneralSettingsState = {
  sysNotify: boolean;
  warnNotify: boolean;
  trayIcon: boolean;
  completionSound: boolean;
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

export type GlobalSettingsState = {
  schemaVersion: 1;
  general: GeneralSettingsState;
  agents: AgentsSettingsState;
  models: ModelsSettingsState;
  rules: RulesSettingsState;
  tools: ToolsSettingsState;
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
    general: {
      sysNotify: true,
      warnNotify: false,
      trayIcon: true,
      completionSound: true,
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
