import type { AgentBackendId } from "@cesium/core";
import type { McpServerConfig } from "./mcp-types";

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

export type AgentPluginPublic = {
  definition: AgentPluginDefinition;
  install: AgentPluginInstallRecord | null;
  enabled: boolean;
  managedMcpServerIds: string[];
};

export type AgentPluginHarnessCapability = {
  backendId: AgentBackendId;
  nativeMcp: boolean;
  promptSkills: boolean;
  attachment:
    | "cesium-tools"
    | "sdk-mcp"
    | "acp-mcp"
    | "workspace-mcp-config"
    | "prompt-only";
  notes?: string;
};

export type AgentPluginDiscoveryEntry = {
  definition: AgentPluginDefinition;
  source: "builtin" | "local" | "remote" | "github";
  sourceLabel: string;
};

export type AgentPluginDiscoveryResult = {
  query: string;
  sources: Array<{
    id: "builtin" | "local" | "remote" | "github";
    label: string;
    url?: string;
    pluginCount: number;
    error?: string;
  }>;
  plugins: AgentPluginDiscoveryEntry[];
};

export type AgentPluginHarnessVerification = {
  backendId: AgentBackendId;
  nativeMcp: boolean;
  promptSkills: boolean;
  attachment: AgentPluginHarnessCapability["attachment"];
  notes?: string;
  pluginCount: number;
  skillCount: number;
  mcpServerIds: string[];
  nativeMcpServerIds: string[];
  skillTitles: string[];
  warnings: Array<{ pluginId: string; pluginName: string; reason: string }>;
  identified: boolean;
};

export type AgentPluginVerificationReport = {
  workspaceId: string;
  workspaceRoot: string;
  installedPluginCount: number;
  enabledPluginCount: number;
  harnesses: AgentPluginHarnessVerification[];
  summary: {
    fullyNativeMcp: AgentBackendId[];
    promptOnlyMcp: AgentBackendId[];
    withWarnings: AgentBackendId[];
    identifyingPlugins: AgentBackendId[];
  };
};
