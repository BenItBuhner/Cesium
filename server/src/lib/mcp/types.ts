export type {
  McpAuthConfig,
  McpServerConfig,
  McpServerSummary,
  McpTransportKind,
} from "@cesium/core/mcp";

export type McpSecretEntry =
  | { kind: "value"; value: string; updatedAt: number }
  | {
      kind: "oauth";
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
      scopes?: string[];
      updatedAt: number;
    };

export type McpSecretsFile = {
  schemaVersion: 1;
  updatedAt: number;
  secrets: Record<string, McpSecretEntry>;
};

export type McpServersFile = {
  schemaVersion: 1;
  updatedAt: number;
  servers: import("@cesium/core/mcp").McpServerConfig[];
};

export type McpServerPublic = Omit<
  import("@cesium/core/mcp").McpServerConfig,
  never
> & {
  connectionStatus?: McpConnectionStatus;
};

export type McpConnectionStatus = {
  connected: boolean;
  lastCheckedAt: number;
  toolCount?: number;
  error?: string;
  needsAuth?: boolean;
};

export type McpOAuthPending = {
  workspaceId: string;
  serverId: string;
  codeVerifier: string;
  createdAt: number;
  redirectUri: string;
  tokenUrl: string;
};
