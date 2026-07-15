// Moved to @cesium/client (packages/client/src/server-connections-provider-shared.ts). Re-export shim keeps existing imports stable.
export {
  SERVER_CONNECTIONS_EVENT,
  getActiveServerConnectionFromDefaults as getActiveServerConnection,
  getConfiguredServerConnectionsState,
  getServerConnectionKey,
  markServerConnectionUsed,
  normalizeServerBaseUrl,
  readActiveServerConnectionsState as readStoredServerConnectionsState,
  removeServerConnectionWithDefaults as removeServerConnection,
  upsertServerConnection,
  writeStoredServerConnectionsState,
} from "@cesium/client";
export type {
  ServerConnection,
  ServerConnectionsState,
} from "@cesium/client";
