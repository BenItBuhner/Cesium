/**
 * Settings panels, one module per category. `SETTINGS_PANELS` maps the
 * settings nav ids (see `SettingsEditorView`) to their panel components.
 */
import type { ComponentType } from "react";
import { AgentsHarnessSettingsPanel } from "@/components/editor/agent-harness-settings";
import { CloudAgentsSettingsPanel } from "@/components/editor/cloud-agents-settings";
import { VscodeExtensionsSettingsPanel } from "@/components/editor/vscode-extensions-settings";
import { AccountSettingsPanel } from "./AccountSettingsPanel";
import { GeneralSettingsPanel } from "./GeneralSettingsPanel";
import { ActionsSettingsPanel } from "./ActionsSettingsPanel";
import { AppearanceSettingsPanel } from "./AppearanceSettingsPanel";
import { ModelsSettingsPanel } from "./ModelsSettingsPanel";
import { PluginsSettingsPanel } from "./PluginsSettingsPanel";
import { ServerConnectionsSettingsPanel } from "./ServersSettingsPanel";
import { RulesSkillsSubagentsPanel } from "./RulesSkillsSubagentsPanel";
import { BetaSettingsPanel } from "./BetaSettingsPanel";
import { KeyboardShortcutsSettingsPanel } from "./KeyboardShortcutsSettingsPanel";
import { ExportImportSettingsPanel } from "./ExportImportSettingsPanel";
import { StorageSettingsPanel } from "./StorageSettingsPanel";
import { UpdatesSettingsPanel } from "./UpdatesSettingsPanel";
import { UsageSettingsPanel } from "./UsageSettingsPanel";
import { VoiceSettingsPanel } from "./VoiceSettingsPanel";
import { AdvancedSettingsPanel } from "./AdvancedSettingsPanel";

export { usePluginsMcpNavigation } from "./PluginsSettingsPanel";

export const SETTINGS_PANELS: Record<string, ComponentType> = {
  account: AccountSettingsPanel,
  general: GeneralSettingsPanel,
  actions: ActionsSettingsPanel,
  appearance: AppearanceSettingsPanel,
  voice: VoiceSettingsPanel,
  agents: AgentsHarnessSettingsPanel,
  cloudAgents: CloudAgentsSettingsPanel,
  models: ModelsSettingsPanel,
  usage: UsageSettingsPanel,
  plugins: PluginsSettingsPanel,
  extensions: VscodeExtensionsSettingsPanel,
  servers: ServerConnectionsSettingsPanel,
  rulesSkills: RulesSkillsSubagentsPanel,
  beta: BetaSettingsPanel,
  keyboardShortcuts: KeyboardShortcutsSettingsPanel,
  exportImport: ExportImportSettingsPanel,
  storage: StorageSettingsPanel,
  updates: UpdatesSettingsPanel,
  advanced: AdvancedSettingsPanel,
};
