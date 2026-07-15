import type { McpServerConfig } from "@cesium/core/mcp";
import type { AgentBackendId } from "../agents/types.js";

export type AgentPluginContributionKind = "mcp" | "skill";

export type AgentPluginSkillContribution = {
  id: string;
  title: string;
  description: string;
  body: string;
  triggerHints?: string[];
};

export type AgentPluginMcpContribution = {
  id: string;
  presetId?: string;
  server?: Omit<McpServerConfig, "id" | "enabled" | "createdAt" | "updatedAt"> & {
    id?: string;
  };
};

export type AgentPluginHarnessSupport = {
  backendId: AgentBackendId;
  nativeMcp: boolean;
  promptSkills: boolean;
  notes?: string;
};

export type AgentPluginDefinition = {
  schemaVersion: 1;
  pluginId: string;
  displayName: string;
  description: string;
  iconUrl?: string;
  marketplace?: {
    id?: string;
    publisher?: string;
  };
  mcp: AgentPluginMcpContribution[];
  skills: AgentPluginSkillContribution[];
  harnesses?: Partial<Record<AgentBackendId, AgentPluginHarnessSupport>>;
  builtIn?: boolean;
};

export type AgentPluginHarnessOverride = {
  backendId: AgentBackendId;
  enabled: boolean;
  updatedAt: number;
};

export type AgentPluginInstallRecord = {
  schemaVersion: 1;
  workspaceId: string;
  pluginId: string;
  enabled: boolean;
  customDefinition?: AgentPluginDefinition;
  harnessOverrides: AgentPluginHarnessOverride[];
  installedAt: number;
  updatedAt: number;
};

export type AgentPluginsFile = {
  schemaVersion: 1;
  updatedAt: number;
  installs: AgentPluginInstallRecord[];
};

export type AgentPluginPublic = {
  definition: AgentPluginDefinition;
  install: AgentPluginInstallRecord | null;
  enabled: boolean;
  managedMcpServerIds: string[];
};

export type AgentPluginAttachmentWarning = {
  pluginId: string;
  pluginName: string;
  backendId: AgentBackendId;
  reason: string;
};

export type AgentPluginToolDisplay = {
  pluginId: string;
  pluginName: string;
  pluginIconUrl?: string;
  mcpServerIds: string[];
};
