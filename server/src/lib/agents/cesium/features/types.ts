import type { AgentPermissionCategory } from "../../types.js";

/** Shared JSON-schema tool definition used by the Cesium harness registry. */
export type CesiumToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * When set, `CesiumSession.executeTool` gates the call through the shared
   * permission cascade (ask / allow / deny / remembered / auto-accept) before dispatch.
   */
  requiresPermission?: AgentPermissionCategory;
};

/** Versioned harness feature ids that can be swapped independently. */
export type CesiumHarnessFeatureId = "subagents" | (string & {});

export type CesiumSubagentsVersion = 1 | 2;

export type CesiumHarnessFeatureSelection = {
  version: number;
};

export type CesiumHarnessFeatureVersions = Record<
  string,
  CesiumHarnessFeatureSelection
> & {
  subagents: {
    version: CesiumSubagentsVersion;
  };
};

export type CesiumHarnessLimits = {
  /** Hard cap for the timed `wait` tool (seconds). Default: 86400 (24h). */
  waitMaxSeconds: number;
  /** Default timeout for `wait_agent` when omitted. Default: 30000. */
  waitAgentDefaultTimeoutMs: number;
  /** Minimum allowed `wait_agent` timeout. Default: 1000. */
  waitAgentMinTimeoutMs: number;
  /** Maximum allowed `wait_agent` timeout. Default: 1800000 (30 min). */
  waitAgentMaxTimeoutMs: number;
  /** Max concurrent live V2 subagent threads in one session. Default: 8. */
  maxConcurrentSubagents: number;
};

export type CesiumHarnessSettings = {
  features: CesiumHarnessFeatureVersions;
  limits: CesiumHarnessLimits;
};

export type CesiumFeatureModule = {
  id: CesiumHarnessFeatureId;
  version: number;
  label: string;
  description: string;
  tools: CesiumToolDefinition[];
  /** Tool names contributed by this module (for policy / dispatch). */
  toolNames: string[];
  /** Optional mode-reminder fragment injected when this feature is active. */
  reminder?: string;
  /**
   * Optional module-owned dispatcher for contributed tools. Stateful modules
   * can close over a runtime created by their version resolver.
   */
  executeTool?: (
    name: string,
    args: Record<string, unknown>
  ) => string | Promise<string>;
};

export type CesiumFeatureVersionDefinition = {
  version: number;
  label: string;
  description: string;
  resolve: (limits: CesiumHarnessLimits) => CesiumFeatureModule;
};

/**
 * One independently swappable part of the harness. Third-party modules can
 * register another definition without editing the central resolver.
 */
export type CesiumFeatureDefinition = {
  id: CesiumHarnessFeatureId;
  label: string;
  description: string;
  defaultVersion: number;
  versions: readonly CesiumFeatureVersionDefinition[];
};

export type CesiumFeatureCatalogEntry = Omit<CesiumFeatureDefinition, "versions"> & {
  versions: Array<Omit<CesiumFeatureVersionDefinition, "resolve">>;
};

export type ResolvedCesiumHarness = {
  settings: CesiumHarnessSettings;
  modules: CesiumFeatureModule[];
  tools: CesiumToolDefinition[];
  toolNames: Set<string>;
  subagentsVersion: CesiumSubagentsVersion;
};
