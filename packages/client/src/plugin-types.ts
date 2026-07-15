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
  harnesses?: Partial<
    Record<
      AgentBackendId,
      {
        backendId: AgentBackendId;
        nativeMcp: boolean;
        promptSkills: boolean;
        notes?: string;
      }
    >
  >;
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
