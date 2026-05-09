"use client";

import {
  createDefaultServerConnectionsState,
  getActiveServerConnection as getActiveServerConnectionFromStorage,
  removeServerConnection as removeServerConnectionFromStorage,
  readStoredServerConnectionsState as readStoredState,
  type ServerConnection,
  type ServerConnectionsState,
  SERVER_CONNECTIONS_EVENT,
  normalizeServerBaseUrl,
  markServerConnectionUsed,
  upsertServerConnection,
  writeStoredServerConnectionsState,
} from "@/lib/server-connections";

function getConfiguredServerBaseUrl(): string {
  return process.env.NEXT_PUBLIC_SERVER_URL?.replace(/\/+$/, "") ?? "http://localhost:9107";
}

export {
  SERVER_CONNECTIONS_EVENT,
  normalizeServerBaseUrl,
  markServerConnectionUsed,
  upsertServerConnection,
  writeStoredServerConnectionsState,
  type ServerConnection,
  type ServerConnectionsState,
};

export function getConfiguredServerConnectionsState(): ServerConnectionsState {
  return createDefaultServerConnectionsState(getConfiguredServerBaseUrl());
}

export function readStoredServerConnectionsState(): ServerConnectionsState {
  return readStoredState(getConfiguredServerBaseUrl());
}

export function getActiveServerConnection(): ServerConnection {
  return getActiveServerConnectionFromStorage(getConfiguredServerBaseUrl());
}

export function removeServerConnection(
  state: ServerConnectionsState,
  serverId: string
): ServerConnectionsState {
  return removeServerConnectionFromStorage(state, serverId, getConfiguredServerBaseUrl());
}
