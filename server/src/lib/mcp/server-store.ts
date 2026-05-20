import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { McpServerConfig } from "@cesium/core/mcp";
import { readJsonFile, writeJsonFile } from "../persistence.js";
import { mcpSecretsPath, mcpServersConfigPath, slugifyMcpServerId } from "./paths.js";
import type {
  McpConnectionStatus,
  McpSecretsFile,
  McpServerPublic,
  McpServersFile,
  McpSecretEntry,
} from "./types.js";
import { decryptForWorkspace, encryptForWorkspace } from "./secret-crypto.js";

const connectionStatusByKey = new Map<string, McpConnectionStatus>();

function statusKey(workspaceId: string, serverId: string): string {
  return `${workspaceId}:${serverId}`;
}

export function setMcpConnectionStatus(
  workspaceId: string,
  serverId: string,
  status: McpConnectionStatus
): void {
  connectionStatusByKey.set(statusKey(workspaceId, serverId), status);
}

export function getMcpConnectionStatus(
  workspaceId: string,
  serverId: string
): McpConnectionStatus | undefined {
  return connectionStatusByKey.get(statusKey(workspaceId, serverId));
}

async function ensureWorkspaceDir(workspaceId: string): Promise<void> {
  await fs.mkdir(path.dirname(mcpServersConfigPath(workspaceId)), { recursive: true });
}

async function readServersFile(workspaceId: string): Promise<McpServersFile> {
  const empty: McpServersFile = {
    schemaVersion: 1,
    updatedAt: 0,
    servers: [],
  };
  const stored = await readJsonFile<McpServersFile | null>(
    mcpServersConfigPath(workspaceId),
    null
  );
  if (!stored || stored.schemaVersion !== 1 || !Array.isArray(stored.servers)) {
    return empty;
  }
  return stored;
}

async function writeServersFile(workspaceId: string, file: McpServersFile): Promise<void> {
  await ensureWorkspaceDir(workspaceId);
  await writeJsonFile(mcpServersConfigPath(workspaceId), file);
}

type EncryptedSecretsFile = {
  schemaVersion: 1;
  updatedAt: number;
  payload: string;
};

async function readSecretsFile(workspaceId: string): Promise<McpSecretsFile> {
  const empty: McpSecretsFile = {
    schemaVersion: 1,
    updatedAt: 0,
    secrets: {},
  };
  const stored = await readJsonFile<EncryptedSecretsFile | null>(
    mcpSecretsPath(workspaceId),
    null
  );
  if (!stored || stored.schemaVersion !== 1 || typeof stored.payload !== "string") {
    return empty;
  }
  const decrypted = await decryptForWorkspace<McpSecretsFile>(stored.payload);
  if (!decrypted || decrypted.schemaVersion !== 1) {
    return empty;
  }
  return decrypted;
}

async function writeSecretsFile(workspaceId: string, secrets: McpSecretsFile): Promise<void> {
  await ensureWorkspaceDir(workspaceId);
  const payload = await encryptForWorkspace(secrets);
  const wrapped: EncryptedSecretsFile = {
    schemaVersion: 1,
    updatedAt: Date.now(),
    payload,
  };
  await writeJsonFile(mcpSecretsPath(workspaceId), wrapped);
}

export async function listMcpServers(workspaceId: string): Promise<McpServerPublic[]> {
  const file = await readServersFile(workspaceId);
  return file.servers.map((server) => ({
    ...server,
    connectionStatus: getMcpConnectionStatus(workspaceId, server.id),
  }));
}

export async function getMcpServer(
  workspaceId: string,
  serverId: string
): Promise<McpServerConfig | null> {
  const file = await readServersFile(workspaceId);
  return file.servers.find((server) => server.id === serverId) ?? null;
}

export async function upsertMcpServer(
  workspaceId: string,
  input: Omit<McpServerConfig, "createdAt" | "updatedAt"> & {
    createdAt?: number;
    updatedAt?: number;
  }
): Promise<McpServerConfig> {
  const file = await readServersFile(workspaceId);
  const now = Date.now();
  const existing = file.servers.find((server) => server.id === input.id);
  const next: McpServerConfig = {
    ...input,
    id: input.id || slugifyMcpServerId(input.label),
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    updatedAt: now,
  };
  const servers = file.servers.filter((server) => server.id !== next.id);
  servers.push(next);
  await writeServersFile(workspaceId, {
    schemaVersion: 1,
    updatedAt: now,
    servers,
  });
  return next;
}

export async function deleteMcpServer(workspaceId: string, serverId: string): Promise<boolean> {
  const file = await readServersFile(workspaceId);
  const nextServers = file.servers.filter((server) => server.id !== serverId);
  if (nextServers.length === file.servers.length) {
    return false;
  }
  await writeServersFile(workspaceId, {
    schemaVersion: 1,
    updatedAt: Date.now(),
    servers: nextServers,
  });
  const secrets = await readSecretsFile(workspaceId);
  const secretIds = new Set(
    Object.keys(secrets.secrets).filter((key) => key.startsWith(`${serverId}:`))
  );
  for (const id of secretIds) {
    delete secrets.secrets[id];
  }
  await writeSecretsFile(workspaceId, {
    ...secrets,
    updatedAt: Date.now(),
  });
  connectionStatusByKey.delete(statusKey(workspaceId, serverId));
  return true;
}

export async function setMcpSecret(
  workspaceId: string,
  secretId: string,
  entry: McpSecretEntry
): Promise<void> {
  const secrets = await readSecretsFile(workspaceId);
  secrets.secrets[secretId] = entry;
  secrets.updatedAt = Date.now();
  await writeSecretsFile(workspaceId, secrets);
}

export async function getMcpSecret(
  workspaceId: string,
  secretId: string
): Promise<McpSecretEntry | null> {
  const secrets = await readSecretsFile(workspaceId);
  return secrets.secrets[secretId] ?? null;
}

export async function deleteMcpSecret(workspaceId: string, secretId: string): Promise<void> {
  const secrets = await readSecretsFile(workspaceId);
  if (!secrets.secrets[secretId]) {
    return;
  }
  delete secrets.secrets[secretId];
  secrets.updatedAt = Date.now();
  await writeSecretsFile(workspaceId, secrets);
}

export function createSecretId(serverId: string, suffix: string): string {
  return `${serverId}:${suffix}:${randomUUID().slice(0, 8)}`;
}

export async function listEnabledMcpServers(workspaceId: string): Promise<McpServerConfig[]> {
  const file = await readServersFile(workspaceId);
  return file.servers.filter((server) => server.enabled);
}

export async function getMcpSummariesForPrompt(
  workspaceId: string
): Promise<Array<{ id: string; label: string; summary: string }>> {
  const servers = await listEnabledMcpServers(workspaceId);
  return servers.map((server) => ({
    id: server.id,
    label: server.label,
    summary: server.summary?.trim() || `${server.transport} MCP server`,
  }));
}
