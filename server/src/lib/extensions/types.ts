export type ExtensionCompatibilityLevel =
  | "high"
  | "partial"
  | "unsupported"
  | "dangerous";

export type ExtensionInstallSource =
  | {
      kind: "open-vsx";
      namespace: string;
      name: string;
      version: string;
      registryUrl: string;
    }
  | {
      kind: "vsix";
      filename: string;
    };

export type ExtensionManifestContributionSummary = {
  commands: number;
  configuration: number;
  languages: number;
  grammars: number;
  snippets: number;
  themes: number;
  iconThemes: number;
  views: number;
  viewsContainers: number;
  webviews: number;
  customEditors: number;
  keybindings: number;
  menus: number;
};

export type ExtensionCompatibilityStatus =
  | "supported"
  | "degraded"
  | "staticOnly"
  | "hidden"
  | "blocked";

export type ExtensionIconDescriptor =
  | {
      kind: "resource";
      path: string;
      render: "mask" | "image";
      theme?: "dark" | "light";
    }
  | {
      kind: "codicon";
      name: string;
    }
  | {
      kind: "fallback";
      label: string;
    };

export type ExtensionActivitySurfaceCapability = {
  kind: "activity.webviewView" | "activity.treeView";
  containerId: string;
  surfaceId: string;
  title: string;
  icon: ExtensionIconDescriptor;
  visibility: "always" | "conditional";
  when?: string;
};

export type ExtensionStaticContributionCapability = {
  kind: "static.theme" | "static.iconTheme" | "static.productIconTheme";
  id: string;
  label: string;
  path?: string;
};

export type ExtensionCommandContributionCapability = {
  kind: "commandOnly" | "editor.contextMenu";
  command: string;
  title: string;
  category?: string;
  when?: string;
};

export type ExtensionLanguageContributionCapability = {
  kind: "language.formatter" | "language.diagnostics";
  languageId: string;
};

export type ExtensionUnsupportedContributionCapability = {
  kind: "unsupported.debug" | "unsupported.scm" | "unsupported.notebook" | "unsupported.testing";
  reason: string;
};

export type ExtensionManifestCapabilities = {
  status: ExtensionCompatibilityStatus;
  reasons: string[];
  activitySurfaces: ExtensionActivitySurfaceCapability[];
  staticContributions: ExtensionStaticContributionCapability[];
  commandContributions: ExtensionCommandContributionCapability[];
  languageContributions: ExtensionLanguageContributionCapability[];
  unsupportedContributions: ExtensionUnsupportedContributionCapability[];
};

export type ExtensionManifestSummary = {
  name: string;
  publisher: string;
  displayName: string;
  description: string;
  version: string;
  engines: {
    vscode?: string;
  };
  main?: string;
  browser?: string;
  activationEvents: string[];
  categories: string[];
  contributes: ExtensionManifestContributionSummary;
  capabilities: ExtensionManifestCapabilities;
  raw: Record<string, unknown>;
};

export type ExtensionPermissionKind =
  | "workspace.fs"
  | "workspace.trust"
  | "process.spawn"
  | "network"
  | "terminal"
  | "browser.control"
  | "agent.context"
  | "secrets"
  | "webview.scripts";

export type ExtensionPermissionGrant = {
  id: string;
  workspaceId: string;
  extensionId: string;
  permission: ExtensionPermissionKind;
  granted: boolean;
  reason?: string;
  createdAt: number;
  updatedAt: number;
};

export type ExtensionRuntimeState = {
  hostRunning: boolean;
  activated: boolean;
  activationEvents: string[];
  lastActivatedAt?: number;
  lastError?: string;
  crashCount: number;
  disabledForCrashLoop: boolean;
  memoryRssBytes?: number;
  cpuUserMicros?: number;
  cpuSystemMicros?: number;
};

export type ExtensionInstallRecord = {
  schemaVersion: 1;
  workspaceId: string;
  extensionId: string;
  publisher: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  enabled: boolean;
  compatibility: ExtensionCompatibilityLevel;
  compatibilityWarnings: string[];
  source: ExtensionInstallSource;
  vsixSha256: string;
  vsixSizeBytes: number;
  installPath: string;
  manifest: ExtensionManifestSummary;
  settings: Record<string, unknown>;
  permissions: ExtensionPermissionGrant[];
  runtime: ExtensionRuntimeState;
  installedAt: number;
  updatedAt: number;
};

export type ExtensionMarketplaceSearchResult = {
  namespace: string;
  name: string;
  version: string;
  displayName: string;
  description: string;
  downloadCount?: number;
  averageRating?: number;
  verified?: boolean;
  iconUrl?: string;
};

export type ExtensionMarketplaceSearchResponse = {
  offset: number;
  totalSize: number;
  extensions: ExtensionMarketplaceSearchResult[];
};

export type ExtensionMarketplaceDetail = ExtensionMarketplaceSearchResult & {
  categories: string[];
  tags: string[];
  license?: string;
  repository?: string;
  downloadUrl?: string;
  manifestUrl?: string;
  readmeUrl?: string;
  files: Record<string, string>;
  raw: Record<string, unknown>;
};

export type ExtensionHostStatus = {
  workspaceId: string;
  running: boolean;
  pid?: number;
  startedAt?: number;
  retainedBy: string[];
  activatedExtensionIds: string[];
  lastError?: string;
  crashCount: number;
  memoryRssBytes?: number;
  cpuUserMicros?: number;
  cpuSystemMicros?: number;
};

export type ExtensionSurfaceKind =
  | "marketplace"
  | "webview"
  | "customEditor"
  | "view"
  | "output";

export type ExtensionSurfaceDescriptor = {
  kind: ExtensionSurfaceKind;
  extensionId: string;
  surfaceId: string;
  title: string;
  icon?: string;
  viewType?: string;
  html?: string;
  resourceRoot?: string;
};
