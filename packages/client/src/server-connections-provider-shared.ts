"use client";

import {
  createDefaultServerConnectionsState,
  getActiveServerConnection as getActiveServerConnectionFromDefaultsFromStorage,
  removeServerConnection as removeServerConnectionWithDefaultsFromStorage,
  readStoredServerConnectionsState as readStoredState,
  type ServerConnection,
  type ServerConnectionsState,
  SERVER_CONNECTIONS_EVENT,
  normalizeServerBaseUrl,
  getServerConnectionKey,
  markServerConnectionUsed,
  upsertServerConnection,
  writeStoredServerConnectionsState,
} from "./server-connections";

import { getConfiguredServerBaseUrl } from "./configured-server-base-url";

export {
  SERVER_CONNECTIONS_EVENT,
  getServerConnectionKey,
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

export function readActiveServerConnectionsState(): ServerConnectionsState {
  return readStoredState(getConfiguredServerBaseUrl());
}

export function getActiveServerConnectionFromDefaults(): ServerConnection {
  return getActiveServerConnectionFromDefaultsFromStorage(getConfiguredServerBaseUrl());
}

export function removeServerConnectionWithDefaults(
  state: ServerConnectionsState,
  serverId: string
): ServerConnectionsState {
  return removeServerConnectionWithDefaultsFromStorage(state, serverId, getConfiguredServerBaseUrl());
}
