import type { AgentBackendId } from "../agents/types.js";

/** External products a Cloud Agent task can originate from / report back to. */
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

/** Stored connection with secrets. Never leaves the server unredacted. */
export type CloudAgentConnection = {
  providerId: CloudAgentProviderId;
  method: CloudAgentConnectionMethod;
  accessToken: string;
  /** Slack signing secret / Linear + GitHub webhook HMAC secret. */
  webhookSecret?: string;
  /** Human-readable account descriptor (login, workspace name, team). */
  accountLabel?: string;
  scopes?: string[];
  connectedAt: number;
  updatedAt: number;
};

export type CloudAgentConnectionPublic = Omit<CloudAgentConnection, "accessToken" | "webhookSecret"> & {
  configured: true;
  tokenLastFour: string;
  webhookSecretConfigured: boolean;
};

/** Per-provider OAuth app credentials supplied by the user (local-first: no hosted app). */
export type CloudAgentOAuthApp = {
  providerId: CloudAgentProviderId;
  clientId: string;
  clientSecret: string;
  updatedAt: number;
};

export type CloudAgentOAuthAppPublic = Omit<CloudAgentOAuthApp, "clientSecret"> & {
  clientSecretConfigured: boolean;
};

export type CloudAgentExecutionMode = "isolated" | "local";

/**
 * Routing rule: filter inbound assignments down to the workspace (and
 * optionally harness/model) they should run in. First match wins.
 */
export type CloudAgentRoutingRule = {
  id: string;
  /** Provider filter; "any" matches every provider. */
  providerId: CloudAgentProviderId | "any";
  /**
   * Substring matched (case-insensitive) against the assignment's source hints:
   * repo full name, Linear team key/project, Slack channel, labels. Empty
   * string matches everything.
   */
  match: string;
  workspaceId: string;
  backendId?: AgentBackendId;
  modelId?: string;
  executionMode?: CloudAgentExecutionMode;
};

export type CloudAgentSettings = {
  schemaVersion: 1;
  updatedAt: number;
  defaults: {
    backendId: AgentBackendId;
    modelId: string | null;
    executionMode: CloudAgentExecutionMode;
    /** Dispatch inbound webhook assignments immediately without manual review. */
    autoDispatch: boolean;
    /** Fallback workspace when no routing rule matches. */
    workspaceId: string | null;
  };
  routingRules: CloudAgentRoutingRule[];
  connections: CloudAgentConnection[];
  oauthApps: CloudAgentOAuthApp[];
};

export type CloudAgentSettingsPublic = Omit<CloudAgentSettings, "connections" | "oauthApps"> & {
  connections: CloudAgentConnectionPublic[];
  oauthApps: CloudAgentOAuthAppPublic[];
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
  /** Issue id / PR number / Slack ts, when known. */
  externalId?: string;
  url?: string;
  /** GitHub `owner/repo`. */
  repo?: string;
  /** Linear team key (e.g. OSP). */
  teamKey?: string;
  /** Linear project name. */
  project?: string;
  /** Slack channel id or name. */
  channel?: string;
  labels?: string[];
  /** Who assigned/mentioned the agent. */
  sender?: string;
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
  /** Full instruction body composed from the source payload. */
  prompt: string;
  status: CloudAgentTaskStatus;
  source: CloudAgentTaskSource;
  /** True when the inbound webhook could not be signature-verified. */
  unverified?: boolean;
  workspaceId: string | null;
  /** Workspace the conversation actually runs in (worktree workspace when isolated). */
  runWorkspaceId?: string | null;
  conversationId: string | null;
  backendId: AgentBackendId | null;
  modelId: string | null;
  executionMode: CloudAgentExecutionMode;
  branch?: string | null;
  worktreePath?: string | null;
  timeline: CloudAgentTaskTimelineEntry[];
  lastError?: string | null;
};

/** Normalized inbound assignment parsed from a provider webhook. */
export type CloudAgentInboundAssignment = {
  providerId: CloudAgentProviderId;
  title: string;
  body: string;
  source: CloudAgentTaskSource;
  verified: boolean;
};
