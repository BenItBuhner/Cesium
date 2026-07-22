import type { AgentBackendId } from "@cesium/core";

/** Client mirror of the server's Cloud Agents public types (secrets redacted). */

export type CloudAgentProviderId = "linear" | "github" | "slack";

export const CLOUD_AGENT_PROVIDER_IDS: CloudAgentProviderId[] = [
  "linear",
  "github",
  "slack",
];

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
