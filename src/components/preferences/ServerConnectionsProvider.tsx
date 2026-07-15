"use client";

// Moved to @cesium/client/react (packages/client/src/react/ServerConnectionsProvider.tsx). Re-export shim keeps existing imports stable.
export {
  ServerConnectionsProvider,
  useServerConnections,
} from "@cesium/client/react";
export type {
  ServerRuntimeHealth,
  ServerRuntimeStatus,
} from "@cesium/client/react";
