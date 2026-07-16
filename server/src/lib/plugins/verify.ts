import type { AgentBackendId } from "../agents/types.js";
import { resolveAgentPluginAttachments } from "./attachments.js";
import {
  ALL_PLUGIN_HARNESS_IDS,
  getHarnessPluginCapability,
} from "./harness-support.js";
import { listAgentPluginInstalls } from "./store.js";

export type AgentPluginHarnessVerification = {
  backendId: AgentBackendId;
  nativeMcp: boolean;
  promptSkills: boolean;
  attachment: ReturnType<typeof getHarnessPluginCapability>["attachment"];
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

export async function verifyAgentPluginHarnesses(input: {
  workspaceId: string;
  workspaceRoot: string;
}): Promise<AgentPluginVerificationReport> {
  const installs = await listAgentPluginInstalls(input.workspaceId);
  const enabledPluginCount = installs.filter((install) => install.enabled).length;
  const harnesses: AgentPluginHarnessVerification[] = [];

  for (const backendId of ALL_PLUGIN_HARNESS_IDS) {
    const capability = getHarnessPluginCapability(backendId);
    const attachments = await resolveAgentPluginAttachments({
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      backendId,
    });
    const skillTitles = attachments.plugins.flatMap((plugin) =>
      plugin.definition.skills.map((skill) => skill.title)
    );
    const mcpServerIds = attachments.plugins.flatMap((plugin) =>
      plugin.mcpServers.map((server) => server.id)
    );
    const nativeMcpServerIds = Object.keys(attachments.sdkMcp.servers);
    harnesses.push({
      backendId,
      nativeMcp: capability.nativeMcp,
      promptSkills: capability.promptSkills,
      attachment: capability.attachment,
      notes: capability.notes,
      pluginCount: attachments.plugins.length,
      skillCount: skillTitles.length,
      mcpServerIds,
      nativeMcpServerIds,
      skillTitles,
      warnings: attachments.warnings.map((warning) => ({
        pluginId: warning.pluginId,
        pluginName: warning.pluginName,
        reason: warning.reason,
      })),
      identified: attachments.plugins.length > 0,
    });
  }

  return {
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    installedPluginCount: installs.length,
    enabledPluginCount,
    harnesses,
    summary: {
      fullyNativeMcp: harnesses
        .filter((entry) => entry.nativeMcp && entry.identified)
        .map((entry) => entry.backendId),
      promptOnlyMcp: harnesses
        .filter((entry) => !entry.nativeMcp)
        .map((entry) => entry.backendId),
      withWarnings: harnesses
        .filter((entry) => entry.warnings.length > 0)
        .map((entry) => entry.backendId),
      identifyingPlugins: harnesses
        .filter((entry) => entry.identified)
        .map((entry) => entry.backendId),
    },
  };
}
