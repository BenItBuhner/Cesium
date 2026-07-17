/** Shared JSON-schema tool definition used by the Cesium harness registry. */
export type CesiumToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** Versioned harness feature ids that can be swapped independently. */
export type CesiumHarnessFeatureId = "subagents";

export type CesiumSubagentsVersion = 1 | 2;

export type CesiumHarnessFeatureVersions = {
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
};

export type ResolvedCesiumHarness = {
  settings: CesiumHarnessSettings;
  modules: CesiumFeatureModule[];
  tools: CesiumToolDefinition[];
  toolNames: Set<string>;
  subagentsVersion: CesiumSubagentsVersion;
};
