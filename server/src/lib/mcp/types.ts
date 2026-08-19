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
  builtins?: {
    browser?: {
      enabled: boolean;
      updatedAt: number;
    };
    phone?: {
      enabled: boolean;
      updatedAt: number;
    };
    artifacts?: {
      enabled: boolean;
      updatedAt: number;
    };
  };
};

export type McpServerPublic = Omit<
  import("@cesium/core/mcp").McpServerConfig,
  never
> & {
  connectionStatus?: McpConnectionStatus;
  builtIn?: boolean;
  removable?: boolean;
};

export type McpProtocolEra = "stateless" | "session";

export type McpProtocolProbeStatus = {
  ok: boolean;
  version?: string;
  error?: string;
};

export type McpConnectionStatus = {
  connected: boolean;
  lastCheckedAt: number;
  toolCount?: number;
  error?: string;
  needsAuth?: boolean;
  protocol?: {
    selected?: McpProtocolEra;
    selectedVersion?: string;
    stateless?: McpProtocolProbeStatus;
    session?: McpProtocolProbeStatus;
  };
};

export type McpOAuthPending = {
  workspaceId: string;
  serverId: string;
  codeVerifier: string;
  createdAt: number;
  redirectUri: string;
  tokenUrl: string;
};
