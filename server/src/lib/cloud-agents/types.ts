import {
  CLOUD_AGENT_PROVIDER_IDS,
  isCloudAgentProviderId,
  type AgentBackendId,
  type CloudAgentExecutionMode,
  type CloudAgentMediaRef,
  type CloudAgentProviderId,
  type CloudAgentRoutingRule,
  type CloudAgentTaskSource,
} from "@cesium/contracts";

export {
  CLOUD_AGENT_PROVIDER_IDS,
  isCloudAgentProviderId,
  type CloudAgentConnectionMethod,
  type CloudAgentConnectionPublic,
  type CloudAgentExecutionMode,
  type CloudAgentMediaRef,
  type CloudAgentOAuthAppPublic,
  type CloudAgentProviderId,
  type CloudAgentRoutingRule,
  type CloudAgentSettingsPublic,
  type CloudAgentTaskArtifact,
  type CloudAgentTaskRecord,
  type CloudAgentTaskSource,
  type CloudAgentTaskStatus,
  type CloudAgentTaskTimelineEntry,
} from "@cesium/contracts";

/** Stored connection with secrets. Never leaves the server unredacted. */
export type CloudAgentConnection = {
  providerId: CloudAgentProviderId;
  method: "oauth" | "token";
  accessToken: string;
  webhookSecret?: string;
  accountLabel?: string;
  scopes?: string[];
  connectedAt: number;
  updatedAt: number;
};

/** Per-provider OAuth app credentials supplied by the user. */
export type CloudAgentOAuthApp = {
  providerId: CloudAgentProviderId;
  clientId: string;
  clientSecret: string;
  updatedAt: number;
};

export type CloudAgentSettings = {
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
  connections: CloudAgentConnection[];
  oauthApps: CloudAgentOAuthApp[];
};

/** Normalized inbound assignment parsed from a provider webhook. */
export type CloudAgentInboundAssignment = {
  providerId: CloudAgentProviderId;
  title: string;
  body: string;
  source: CloudAgentTaskSource;
  verified: boolean;
  mediaRefs?: CloudAgentMediaRef[];
  followUpOnly?: boolean;
};
