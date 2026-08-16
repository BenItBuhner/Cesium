import type { AgentPermissionCategory } from "../../types.js";
import type {
  CesiumAdapterResult,
  CesiumHistoryMessage,
  CesiumToolRequest,
} from "../cesium-types.js";

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
  /** Optional UI grouping for plugin-contributed tools. */
  kind?: string;
  /** Optional static or argument-aware title used in tool-call events. */
  title?: string | ((args: Record<string, unknown>) => string);
  /**
   * Modes where this tool may execute. "all" follows the normal mode policy,
   * while "read-only" additionally permits Ask mode.
   */
  allowedModes?: "all" | "read-only" | readonly string[];
};

/** Versioned harness feature ids that can be swapped independently. */
export type CesiumHarnessFeatureId = "subagents" | (string & {});

export type CesiumSubagentsVersion = 1 | 2;

export type CesiumHarnessFeatureSelection = {
  version: number;
  enabled?: boolean;
  config?: Record<string, unknown>;
};

export type CesiumHarnessFeatureVersions = Record<
  string,
  CesiumHarnessFeatureSelection
> & {
  subagents: CesiumHarnessFeatureSelection & {
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
  /**
   * Max spawn depth for nested V2 subagents (Codex `agents.max_depth` parity).
   * Depth 1 means only the root agent can spawn; higher values let children
   * spawn their own sub-agents. Default: 1.
   */
  maxSpawnDepth: number;
};

export type CesiumHarnessSettings = {
  features: CesiumHarnessFeatureVersions;
  limits: CesiumHarnessLimits;
};

export type CesiumHarnessPluginFailureMode = "isolate" | "fatal";

export type CesiumHarnessPluginContext = {
  sessionId: string;
  conversationId: string;
  workspaceId: string;
  workspaceRoot: string;
  mode: string;
  modelId: string;
  pluginId: string;
  pluginVersion: number;
  config: Readonly<Record<string, unknown>>;
};

export type CesiumHarnessTurnInput = {
  text: string;
  userMessageId: string;
  attachments?: Array<{ mimeType: string; data: string; name?: string }>;
  isRetry?: boolean;
  clientTimezone?: string;
};

export type CesiumHarnessModelRequest = {
  modelId: string;
  iteration: number;
  messages: CesiumHistoryMessage[];
  tools: CesiumToolDefinition[];
};

export type CesiumHarnessTurnOutcome = {
  status: "completed" | "cancelled" | "failed";
  error?: string;
};

export type CesiumHarnessPluginHooks = {
  onSessionStart?: (context: CesiumHarnessPluginContext) => void | Promise<void>;
  onSessionDispose?: (context: CesiumHarnessPluginContext) => void | Promise<void>;
  onTurnStart?: (
    context: CesiumHarnessPluginContext,
    input: CesiumHarnessTurnInput
  ) => void | CesiumHarnessTurnInput | Promise<void | CesiumHarnessTurnInput>;
  transformSystemPrompt?: (
    context: CesiumHarnessPluginContext,
    prompt: string
  ) => string | Promise<string>;
  transformMessages?: (
    context: CesiumHarnessPluginContext,
    messages: CesiumHistoryMessage[]
  ) => CesiumHistoryMessage[] | Promise<CesiumHistoryMessage[]>;
  beforeModel?: (
    context: CesiumHarnessPluginContext,
    request: CesiumHarnessModelRequest
  ) => void | CesiumHarnessModelRequest | Promise<void | CesiumHarnessModelRequest>;
  afterModel?: (
    context: CesiumHarnessPluginContext,
    result: CesiumAdapterResult
  ) => void | CesiumAdapterResult | Promise<void | CesiumAdapterResult>;
  beforeTool?: (
    context: CesiumHarnessPluginContext,
    request: CesiumToolRequest
  ) => void | CesiumToolRequest | Promise<void | CesiumToolRequest>;
  afterTool?: (
    context: CesiumHarnessPluginContext,
    request: CesiumToolRequest,
    result: string
  ) => void | string | Promise<void | string>;
  onToolError?: (
    context: CesiumHarnessPluginContext,
    request: CesiumToolRequest,
    error: Error
  ) => void | Promise<void>;
  onTurnEnd?: (
    context: CesiumHarnessPluginContext,
    outcome: CesiumHarnessTurnOutcome
  ) => void | Promise<void>;
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
  /** Lifecycle/interception hooks run by the per-session plugin runtime. */
  hooks?: CesiumHarnessPluginHooks;
  /** Runtime metadata is populated by the registry. */
  priority?: number;
  failureMode?: CesiumHarnessPluginFailureMode;
  config?: Readonly<Record<string, unknown>>;
};

export type CesiumHarnessPluginResolveContext = CesiumHarnessLimits & {
  settings: CesiumHarnessSettings;
  pluginId: CesiumHarnessFeatureId;
  config: Readonly<Record<string, unknown>>;
};

export type CesiumFeatureVersionDefinition = {
  version: number;
  label: string;
  description: string;
  /**
   * The context includes every limit as a top-level property, preserving
   * compatibility with the original `(limits) => module` resolver contract.
   */
  resolve: (context: CesiumHarnessPluginResolveContext) => CesiumFeatureModule;
};

/**
 * One independently swappable part of the harness. Third-party modules can
 * register another definition without editing the central resolver.
 */
export type CesiumFeatureDefinition = {
  apiVersion?: 1;
  id: CesiumHarnessFeatureId;
  label: string;
  description: string;
  defaultVersion: number;
  versions: readonly CesiumFeatureVersionDefinition[];
  enabledByDefault?: boolean;
  priority?: number;
  dependencies?: readonly CesiumHarnessFeatureId[];
  optionalDependencies?: readonly CesiumHarnessFeatureId[];
  failureMode?: CesiumHarnessPluginFailureMode;
};

export type CesiumFeatureCatalogEntry = Omit<CesiumFeatureDefinition, "versions"> & {
  versions: Array<Omit<CesiumFeatureVersionDefinition, "resolve">>;
  enabledByDefault: boolean;
  priority: number;
  dependencies: CesiumHarnessFeatureId[];
  optionalDependencies: CesiumHarnessFeatureId[];
  failureMode: CesiumHarnessPluginFailureMode;
};

export type ResolvedCesiumHarness = {
  settings: CesiumHarnessSettings;
  modules: CesiumFeatureModule[];
  tools: CesiumToolDefinition[];
  toolNames: Set<string>;
  subagentsVersion: CesiumSubagentsVersion;
  registryRevision: number;
};

/** Preferred names for the standardized harness plugin API. */
export type CesiumHarnessPlugin = CesiumFeatureModule;
export type CesiumHarnessPluginDefinition = CesiumFeatureDefinition;
export type CesiumHarnessPluginVersionDefinition = CesiumFeatureVersionDefinition;
export type CesiumHarnessPluginCatalogEntry = CesiumFeatureCatalogEntry;
