import type { AgentBackendId } from "@cesium/core";

export const CESIUM_PROTOCOL_VERSION = "1.0.0" as const;

export const CESIUM_CAPABILITIES = [
  "auth.sessions",
  "workspaces",
  "workspaces.files",
  "workspaces.git",
  "workspaces.terminals",
  "agents.conversations",
  "agents.events",
  "settings",
  "mcp",
  "orchestration",
  "cloud-agents",
  "storage",
] as const;

export type CesiumCapability = (typeof CESIUM_CAPABILITIES)[number];

export type CesiumServerMetadata = {
  name: "cesium";
  protocolVersion: typeof CESIUM_PROTOCOL_VERSION;
  capabilities: CesiumCapability[];
  transports: {
    http: "/api";
    websocket: "/ws";
  };
};

export type CesiumApiErrorBody = {
  error:
    | string
    | {
        code: string;
        message: string;
        details?: unknown;
      };
  requestId?: string;
};

export type CesiumAuthSession = {
  username: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  remember: boolean;
};

export type CesiumAuthStatus = {
  enabled: boolean;
  authenticated: boolean;
  session: CesiumAuthSession | null;
  rotationIntervalMs: number;
};

export type CloudAgentProviderId = "linear" | "github" | "slack";

export const CLOUD_AGENT_PROVIDER_IDS: CloudAgentProviderId[] = [
  "linear",
  "github",
  "slack",
];

export function isCloudAgentProviderId(value: unknown): value is CloudAgentProviderId {
  return value === "linear" || value === "github" || value === "slack";
}

export type CloudAgentConnectionMethod = "oauth" | "token";

export type CloudAgentConnectionPublic = {
  providerId: CloudAgentProviderId;
  method: CloudAgentConnectionMethod;
  configured: true;
  tokenLastFour: string;
  webhookSecretConfigured: boolean;
  accountLabel?: string;
  scopes?: string[];
  connectedAt: number;
  updatedAt: number;
};

export type CloudAgentOAuthAppPublic = {
  providerId: CloudAgentProviderId;
  clientId: string;
  clientSecretConfigured: boolean;
  updatedAt: number;
};

export type CloudAgentExecutionMode = "isolated" | "local";

export type CloudAgentRoutingRule = {
  id: string;
  providerId: CloudAgentProviderId | "any";
  match: string;
  workspaceId: string;
  backendId?: AgentBackendId;
  modelId?: string;
  executionMode?: CloudAgentExecutionMode;
};

export type CloudAgentSettingsPublic = {
  schemaVersion: 1;
  updatedAt: number;
  defaults: {
    backendId: AgentBackendId;
    modelId: string | null;
    executionMode: CloudAgentExecutionMode;
    autoDispatch: boolean;
    workspaceId: string | null;
  };
  routingRules: CloudAgentRoutingRule[];
  connections: CloudAgentConnectionPublic[];
  oauthApps: CloudAgentOAuthAppPublic[];
};

export type CloudAgentEndpoints = {
  oauthCallbackUrl: string;
  webhooks: Record<CloudAgentProviderId, string>;
};

export type CloudAgentTaskStatus =
  | "inbox"
  | "dispatching"
  | "running"
  | "awaiting_review"
  | "completed"
  | "failed"
  | "cancelled";

export type CloudAgentTaskSource = {
  providerId: CloudAgentProviderId | "manual";
  externalId?: string;
  url?: string;
  repo?: string;
  teamKey?: string;
  project?: string;
  channel?: string;
  labels?: string[];
  sender?: string;
};

export type CloudAgentMediaRef = {
  url: string;
  name?: string;
  mimeType?: string;
};

export type CloudAgentTaskTimelineEntry = {
  at: number;
  kind:
    | "received"
    | "dispatched"
    | "turn_completed"
    | "steered"
    | "update_posted"
    | "status"
    | "error";
  message: string;
};

export type CloudAgentTaskRecord = {
  schemaVersion: 1;
  id: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  prompt: string;
  status: CloudAgentTaskStatus;
  source: CloudAgentTaskSource;
  unverified?: boolean;
  workspaceId: string | null;
  runWorkspaceId?: string | null;
  conversationId: string | null;
  backendId: AgentBackendId | null;
  modelId: string | null;
  executionMode: CloudAgentExecutionMode;
  branch?: string | null;
  worktreePath?: string | null;
  attachments?: CloudAgentMediaRef[];
  timeline: CloudAgentTaskTimelineEntry[];
  lastError?: string | null;
};

export type CloudAgentTaskArtifact = {
  name: string;
  size: number;
  modifiedAt: number;
};

export type ModelToggleEntry = {
  id: string;
  name: string;
  on: boolean;
  backendId?: string;
};

export type ModelToggleState = {
  byBackend: Record<string, ModelToggleEntry[]>;
};

export type ModelToggleUpdate = {
  backendId: string;
  modelId: string;
  on: boolean;
};

export type McpTransportKind = "stdio" | "streamable-http" | "sse";

export type McpAuthConfig =
  | { kind: "none" }
  | { kind: "bearer"; secretId: string }
  | {
      kind: "headers";
      headers: Array<{ name: string; secretId: string }>;
    }
  | {
      kind: "oauth";
      clientIdSecretId?: string;
      clientSecretSecretId?: string;
      scopes?: string[];
      authorizationUrl?: string;
      tokenUrl?: string;
      discoveryUrl?: string;
    };

export type McpServerConfig = {
  id: string;
  label: string;
  enabled: boolean;
  transport: McpTransportKind;
  stdio?: {
    command: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
  };
  remote?: {
    url: string;
    allowInsecureLocalhost?: boolean;
  };
  auth: McpAuthConfig;
  presetId?: string;
  pluginId?: string;
  pluginContributionId?: string;
  iconUrl?: string;
  displayName?: string;
  summary?: string;
  createdAt: number;
  updatedAt: number;
};

export type McpConnectionStatus = {
  connected: boolean;
  lastCheckedAt: number;
  toolCount?: number;
  error?: string;
  needsAuth?: boolean;
};

export type McpServerPublic = McpServerConfig & {
  connectionStatus?: McpConnectionStatus;
  builtIn?: boolean;
  removable?: boolean;
};

export type McpPresetDefinition = {
  presetId: string;
  label: string;
  description: string;
  config: Omit<
    McpServerConfig,
    "id" | "label" | "enabled" | "createdAt" | "updatedAt" | "presetId"
  >;
};

export type CesiumProviderKind =
  | "openai-chat-completions"
  | "openai-responses"
  | "openai-realtime"
  | "anthropic"
  | "google-genai"
  | "openai-compatible";

export type CesiumProviderKeyStatus = {
  id: string;
  providerId: string;
  label: string;
  apiKind: CesiumProviderKind;
  baseUrl?: string;
  source: "env" | "stored";
  createdAt: number;
  updatedAt: number;
  lastFour?: string;
};

export type CesiumModelCatalogEntry = {
  providerId: string;
  providerName: string;
  providerApiBaseUrl?: string;
  providerDocUrl?: string;
  modelId: string;
  modelName: string;
  apiKind: CesiumProviderKind;
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsStructuredOutput: boolean;
  supportsImages?: boolean;
  contextWindow?: number;
  outputLimit?: number;
};

export type CesiumAgentSettingsPublic = {
  schemaVersion: 1;
  updatedAt: number;
  configured: boolean;
  defaultProviderKeyId: string | null;
  defaultModelId: string;
  defaultApiKind: CesiumProviderKind;
  compression: {
    enabled: boolean;
    modelId: string | null;
    thresholdRatio: number;
  };
  orchestration: {
    continueWhenIncomplete: boolean;
  };
  modes: {
    enabled: Record<string, boolean>;
  };
  modeCatalog: Array<{
    id: string;
    label: string;
    description: string;
  }>;
  harness: {
    features: Record<string, { version: number }>;
    limits: {
      waitMaxSeconds: number;
      waitAgentDefaultTimeoutMs: number;
      waitAgentMinTimeoutMs: number;
      waitAgentMaxTimeoutMs: number;
      maxConcurrentSubagents: number;
    };
  };
  harnessCatalog: Array<{
    id: string;
    label: string;
    description: string;
    defaultVersion: number;
    versions: Array<{
      version: number;
      label: string;
      description: string;
    }>;
  }>;
  toolPermissions: Record<"editFile" | "terminal" | "mcpCall" | "switchMode", "ask" | "allow" | "deny">;
  providerKeys: CesiumProviderKeyStatus[];
  customProviders: Array<{
    id: string;
    name: string;
    apiKind: CesiumProviderKind;
    baseUrl?: string;
    models: Array<{
      id: string;
      name: string;
      contextWindow?: number;
      supportsTools?: boolean;
      supportsReasoning?: boolean;
      supportsImages?: boolean;
    }>;
  }>;
};
