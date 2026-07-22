import type { AgentBackendId } from "../agents/types.js";
import type { AgentPluginHarnessSupport } from "./types.js";

export type AgentPluginHarnessCapability = AgentPluginHarnessSupport & {
  /** How plugin MCP reaches this harness at runtime. */
  attachment: "cesium-tools" | "sdk-mcp" | "acp-mcp" | "workspace-mcp-config" | "prompt-only";
};

/**
 * Authoritative plugin capability matrix for each agent harness.
 * Catalog entries and UI warnings should derive from this, not invent per-plugin overrides
 * unless a plugin truly cannot work on a given backend.
 */
export const HARNESS_PLUGIN_CAPABILITIES: Record<AgentBackendId, AgentPluginHarnessCapability> = {
  "cesium-agent": {
    backendId: "cesium-agent",
    nativeMcp: true,
    promptSkills: true,
    attachment: "cesium-tools",
    notes: "Cesium Agent uses call_mcp_tool plus the workspace MCP/skills mirrors.",
  },
  "cursor-sdk": {
    backendId: "cursor-sdk",
    nativeMcp: true,
    promptSkills: true,
    attachment: "sdk-mcp",
    notes: "Cursor SDK receives native mcpServers plus plugin skill prompt blocks.",
  },
  "claude-code-sdk": {
    backendId: "claude-code-sdk",
    nativeMcp: true,
    promptSkills: true,
    attachment: "sdk-mcp",
    notes: "Claude Code SDK receives native mcpServers plus plugin skill prompt blocks.",
  },
  "codex-app-server": {
    backendId: "codex-app-server",
    nativeMcp: true,
    promptSkills: true,
    attachment: "sdk-mcp",
    notes: "Codex app server accepts mcpServers on turns when exportable; skills arrive via prompt.",
  },
  "devin-acp": {
    backendId: "devin-acp",
    nativeMcp: true,
    promptSkills: true,
    attachment: "acp-mcp",
    notes: "Devin ACP sessions receive MCP servers through the ACP mcpServers array.",
  },
  "google-antigravity-cli": {
    backendId: "google-antigravity-cli",
    nativeMcp: true,
    promptSkills: true,
    attachment: "workspace-mcp-config",
    notes:
      "Antigravity reads workspace .agents/mcp_config.json. Cesium syncs plugin MCP servers there automatically.",
  },
  "opencode-server": {
    backendId: "opencode-server",
    nativeMcp: false,
    promptSkills: true,
    attachment: "prompt-only",
    notes:
      "OpenCode does not currently accept Cesium-managed native MCP attachment. Plugin skills and MCP guidance are injected into the prompt only — tools will not run natively across this harness.",
  },
  "pi-agent": {
    backendId: "pi-agent",
    nativeMcp: false,
    promptSkills: true,
    attachment: "prompt-only",
    notes:
      "Pi loads its own packages/extensions/skills from the configured agent home (~/.pi/agent by default). Cesium-managed plugin MCP is prompt-only — use Pi packages or CLI tools for native Pi capabilities.",
  },
};

export const ALL_PLUGIN_HARNESS_IDS = Object.keys(
  HARNESS_PLUGIN_CAPABILITIES
) as AgentBackendId[];

export function getHarnessPluginCapability(
  backendId: AgentBackendId
): AgentPluginHarnessCapability {
  return HARNESS_PLUGIN_CAPABILITIES[backendId];
}

export function standardHarnessSupport(): Partial<
  Record<AgentBackendId, AgentPluginHarnessSupport>
> {
  return Object.fromEntries(
    ALL_PLUGIN_HARNESS_IDS.map((backendId) => {
      const capability = HARNESS_PLUGIN_CAPABILITIES[backendId];
      return [
        backendId,
        {
          backendId,
          nativeMcp: capability.nativeMcp,
          promptSkills: capability.promptSkills,
          notes: capability.notes,
        } satisfies AgentPluginHarnessSupport,
      ];
    })
  ) as Partial<Record<AgentBackendId, AgentPluginHarnessSupport>>;
}

export function harnessCompatibilityWarnings(input: {
  backendId: AgentBackendId;
  pluginId: string;
  pluginName: string;
  hasMcp: boolean;
}): Array<{ pluginId: string; pluginName: string; backendId: AgentBackendId; reason: string }> {
  const capability = getHarnessPluginCapability(input.backendId);
  const warnings: Array<{
    pluginId: string;
    pluginName: string;
    backendId: AgentBackendId;
    reason: string;
  }> = [];
  if (input.hasMcp && !capability.nativeMcp) {
    warnings.push({
      pluginId: input.pluginId,
      pluginName: input.pluginName,
      backendId: input.backendId,
      reason:
        capability.notes ??
        "This harness does not support native plugin MCP attachment; using prompt guidance instead. MCP tools will not work across this harness.",
    });
  }
  return warnings;
}
