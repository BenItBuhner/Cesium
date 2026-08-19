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
      registrationUrl?: string;
      resource?: string;
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
  remote?: { url: string; allowInsecureLocalhost?: boolean };
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

export type McpAuthOnboarding =
  | { kind: "none" }
  | { kind: "oauth-dcr" }
  | { kind: "oauth-manual" }
  | { kind: "bearer"; label?: string; docsUrl?: string }
  | {
      kind: "headers";
      fields: Array<{ name: string; label: string; docsUrl?: string }>;
    };

export type McpPresetDefinition = {
  presetId: string;
  label: string;
  description: string;
  onboarding?: McpAuthOnboarding;
  config: Omit<
    McpServerConfig,
    "id" | "label" | "enabled" | "createdAt" | "updatedAt" | "presetId"
  >;
};
