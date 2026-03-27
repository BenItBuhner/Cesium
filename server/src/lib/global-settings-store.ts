import path from "node:path";
import { DATA_DIR, readJsonFile, writeJsonFile } from "./persistence.js";

export type GlobalSettings = {
  schemaVersion: 1;
  general: {
    sysNotify: boolean;
    warnNotify: boolean;
    trayIcon: boolean;
    completionSound: boolean;
  };
  agents: {
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
  models: {
    models: Array<{ id: string; name: string; on: boolean }>;
  };
  rules: {
    thirdParty: boolean;
  };
  tools: {
    localhost: boolean;
    mcpTags: string[];
    domainTags: string[];
    pluginState: Array<{
      id: string;
      name: string;
      status: string;
      on: boolean;
      connect?: boolean;
    }>;
  };
};

const GLOBAL_SETTINGS_FILE = path.join(DATA_DIR, "profile", "global-settings.json");

function createDefaultSettings(): GlobalSettings {
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
      cmdTags: [
        "pip install *",
        "npm install *",
        "uv install *",
        "python *",
        "cd *",
        "ls *",
        "grep *",
        "Select-Object *",
      ],
      modeTags: ["agent-plan"],
      branchPrefix: "cursor/",
    },
    models: {
      models: [
        { id: "composer-2-fast", name: "Composer 2 Fast", on: true },
        { id: "gpt-5.4-fast", name: "GPT-5.4 Fast", on: false },
        { id: "gpt-5.4-extra-high-fast", name: "GPT-5.4 Extra High Fast", on: false },
        { id: "opus-4.6-max", name: "Opus 4.6 Max", on: false },
        { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", on: false },
        { id: "gpt-5.4-mini-extra-high", name: "GPT-5.4 Mini Extra High", on: false },
        { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", on: false },
      ],
    },
    rules: {
      thirdParty: true,
    },
    tools: {
      localhost: true,
      mcpTags: [
        "figma:get_design_context",
        "figma:get_screenshot",
        "linear:get_issue",
        "linear:list_issues",
        "notion:notion-search",
        "slack:slack_read_channel",
      ],
      domainTags: [
        "raw.githubusercontent.com",
        "github.com",
        "docs.polymarket.com",
        "api.github.com",
        "developer.notion.com",
        "www.todoist.com",
      ],
      pluginState: [
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
      ],
    },
  };
}

export async function getGlobalSettings(): Promise<GlobalSettings> {
  return readJsonFile(GLOBAL_SETTINGS_FILE, createDefaultSettings());
}

export async function saveGlobalSettings(settings: GlobalSettings): Promise<void> {
  await writeJsonFile(GLOBAL_SETTINGS_FILE, settings);
}
