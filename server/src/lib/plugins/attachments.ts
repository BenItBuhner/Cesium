import type { McpServerConfig, McpServerSummary } from "@cesium/core/mcp";
import type { AgentBackendId } from "../agents/types.js";
import {
  exportEnabledMcpServersForSdk,
  type ExportedMcpServers,
} from "../agents/mcp-export-adapter.js";
import { listEnabledMcpServers } from "../mcp/server-store.js";
import {
  getAgentPluginDefinition,
  listAgentPluginInstalls,
} from "./store.js";
import type {
  AgentPluginAttachmentWarning,
  AgentPluginDefinition,
  AgentPluginInstallRecord,
  AgentPluginToolDisplay,
} from "./types.js";

export type ResolvedAgentPlugin = {
  definition: AgentPluginDefinition;
  install: AgentPluginInstallRecord;
  mcpServers: McpServerConfig[];
};

export type AgentPluginAttachmentSnapshot = {
  workspaceId: string;
  workspaceRoot: string;
  backendId: AgentBackendId;
  plugins: ResolvedAgentPlugin[];
  skillsList: string;
  promptSection: string;
  mcpSummaries: McpServerSummary[];
  mcpServers: McpServerConfig[];
  sdkMcp: ExportedMcpServers;
  warnings: AgentPluginAttachmentWarning[];
  toolDisplays: AgentPluginToolDisplay[];
};

function harnessEnabled(record: AgentPluginInstallRecord, backendId: AgentBackendId): boolean {
  const override = record.harnessOverrides.find((entry) => entry.backendId === backendId);
  return override?.enabled ?? record.enabled;
}

function supportsNativeMcp(definition: AgentPluginDefinition, backendId: AgentBackendId): boolean {
  return definition.harnesses?.[backendId]?.nativeMcp !== false;
}

function supportsPromptSkills(definition: AgentPluginDefinition, backendId: AgentBackendId): boolean {
  return definition.harnesses?.[backendId]?.promptSkills !== false;
}

function renderPluginSkills(plugins: ResolvedAgentPlugin[], backendId: AgentBackendId): string {
  const lines: string[] = [];
  for (const plugin of plugins) {
    if (!supportsPromptSkills(plugin.definition, backendId) || plugin.definition.skills.length === 0) {
      continue;
    }
    lines.push(`- ${plugin.definition.displayName}:`);
    for (const skill of plugin.definition.skills) {
      lines.push(`  - ${skill.title}: ${skill.description}`);
      if (skill.triggerHints?.length) {
        lines.push(`    Triggers: ${skill.triggerHints.join(", ")}`);
      }
      lines.push(`    Instructions: ${skill.body.trim()}`);
    }
  }
  return lines.join("\n");
}

function renderPromptSection(input: {
  plugins: ResolvedAgentPlugin[];
  skillsList: string;
  warnings: AgentPluginAttachmentWarning[];
}): string {
  const sections: string[] = [];
  if (input.plugins.length > 0) {
    sections.push(
      [
        "<agent-plugins>",
        ...input.plugins.map((plugin) => {
          const mcpNames = plugin.mcpServers.map((server) => server.label).join(", ") || "none";
          return `<plugin id="${plugin.definition.pluginId}" name="${plugin.definition.displayName}" mcp="${mcpNames}" />`;
        }),
        "</agent-plugins>",
      ].join("\n")
    );
  }
  if (input.skillsList.trim()) {
    sections.push(["<agent-plugin-skills>", input.skillsList.trim(), "</agent-plugin-skills>"].join("\n"));
  }
  if (input.warnings.length > 0) {
    sections.push(
      [
        "<agent-plugin-warnings>",
        ...input.warnings.map((warning) => `- ${warning.pluginName}: ${warning.reason}`),
        "</agent-plugin-warnings>",
      ].join("\n")
    );
  }
  return sections.join("\n\n");
}

export async function resolveAgentPluginAttachments(input: {
  workspaceId: string;
  workspaceRoot: string;
  backendId: AgentBackendId;
}): Promise<AgentPluginAttachmentSnapshot> {
  const [installs, enabledMcpServers] = await Promise.all([
    listAgentPluginInstalls(input.workspaceId),
    listEnabledMcpServers(input.workspaceId),
  ]);
  const plugins: ResolvedAgentPlugin[] = [];
  const warnings: AgentPluginAttachmentWarning[] = [];

  for (const install of installs) {
    if (!harnessEnabled(install, input.backendId)) {
      continue;
    }
    const definition = await getAgentPluginDefinition(input.workspaceId, install.pluginId);
    if (!definition) {
      continue;
    }
    const mcpServers = enabledMcpServers.filter((server) => server.pluginId === definition.pluginId);
    if (definition.mcp.length > 0 && mcpServers.length === 0) {
      warnings.push({
        pluginId: definition.pluginId,
        pluginName: definition.displayName,
        backendId: input.backendId,
        reason: "No enabled MCP servers are currently available for this plugin.",
      });
    }
    if (definition.mcp.length > 0 && !supportsNativeMcp(definition, input.backendId)) {
      warnings.push({
        pluginId: definition.pluginId,
        pluginName: definition.displayName,
        backendId: input.backendId,
        reason: "This harness does not currently support native plugin MCP attachment; using prompt guidance instead.",
      });
    }
    plugins.push({ definition, install, mcpServers });
  }

  const mcpServers = plugins.flatMap((plugin) =>
    supportsNativeMcp(plugin.definition, input.backendId) ? plugin.mcpServers : []
  );
  const skillsList = renderPluginSkills(plugins, input.backendId);
  const sdkMcp = await exportEnabledMcpServersForSdk({
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    configs: mcpServers,
  });
  const toolDisplays = plugins.map((plugin) => ({
    pluginId: plugin.definition.pluginId,
    pluginName: plugin.definition.displayName,
    pluginIconUrl: plugin.definition.iconUrl,
    mcpServerIds: plugin.mcpServers.map((server) => server.id),
  }));
  const mcpSummaries = mcpServers.map((server) => ({
    id: server.id,
    label: server.label,
    summary:
      server.summary?.trim() ||
      `${server.transport} MCP server managed by ${server.displayName ?? server.pluginId ?? "plugin"}`,
  }));
  const allWarnings = [...warnings, ...sdkMcp.skipped.map((skipped) => ({
    pluginId: skipped.pluginId ?? skipped.id,
    pluginName: skipped.pluginName ?? skipped.label,
    backendId: input.backendId,
    reason: skipped.reason,
  }))];
  const promptSection = renderPromptSection({ plugins, skillsList, warnings: allWarnings });
  return {
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    backendId: input.backendId,
    plugins,
    skillsList,
    promptSection,
    mcpSummaries,
    mcpServers,
    sdkMcp,
    warnings: allWarnings,
    toolDisplays,
  };
}

export function appendAgentPluginPrompt(
  prompt: string,
  attachments: Pick<AgentPluginAttachmentSnapshot, "promptSection">
): string {
  const section = attachments.promptSection.trim();
  if (!section) return prompt;
  return `${section}\n\n${prompt}`;
}
