/**
 * Settings panels, one module per category. `SETTINGS_PANELS` maps the
 * settings nav ids (see `SettingsEditorView`) to their panel components.
 */
import type { ComponentType } from "react";
import { AgentsHarnessSettingsPanel } from "@/components/editor/agent-harness-settings";
import { CloudAgentsSettingsPanel } from "@/components/editor/cloud-agents-settings";
import { VscodeExtensionsSettingsPanel } from "@/components/editor/vscode-extensions-settings";
import { GeneralSettingsPanel } from "./GeneralSettingsPanel";
import { AppearanceSettingsPanel } from "./AppearanceSettingsPanel";
import { ModelsSettingsPanel } from "./ModelsSettingsPanel";
import { PluginsSettingsPanel } from "./PluginsSettingsPanel";
import { ServerConnectionsSettingsPanel } from "./ServersSettingsPanel";
import { RulesSkillsSubagentsPanel } from "./RulesSkillsSubagentsPanel";
import { BetaSettingsPanel } from "./BetaSettingsPanel";
import { KeyboardShortcutsSettingsPanel } from "./KeyboardShortcutsSettingsPanel";
import { ExportImportSettingsPanel } from "./ExportImportSettingsPanel";
import { StorageSettingsPanel } from "./StorageSettingsPanel";

export { usePluginsMcpNavigation } from "./PluginsSettingsPanel";

export const SETTINGS_PANELS: Record<string, ComponentType> = {
  general: GeneralSettingsPanel,
  appearance: AppearanceSettingsPanel,
  agents: AgentsHarnessSettingsPanel,
  cloudAgents: CloudAgentsSettingsPanel,
  models: ModelsSettingsPanel,
  plugins: PluginsSettingsPanel,
  extensions: VscodeExtensionsSettingsPanel,
  servers: ServerConnectionsSettingsPanel,
  rulesSkills: RulesSkillsSubagentsPanel,
  beta: BetaSettingsPanel,
  keyboardShortcuts: KeyboardShortcutsSettingsPanel,
  exportImport: ExportImportSettingsPanel,
  storage: StorageSettingsPanel,
};
