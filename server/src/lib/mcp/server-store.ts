import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { McpServerConfig } from "@cesium/core/mcp";
import { readJsonFile, writeJsonFile } from "../persistence.js";
import { mcpSecretsPath, mcpServersConfigPath, slugifyMcpServerId } from "./paths.js";
import { BROWSER_MCP_SERVER_ID, BROWSER_MCP_TOOLS } from "./builtin-browser-tools.js";
import { PHONE_MCP_SERVER_ID, PHONE_MCP_TOOLS } from "./builtin-phone-tools.js";
import type {
  McpConnectionStatus,
  McpSecretsFile,
  McpServerPublic,
  McpServersFile,
  McpSecretEntry,
} from "./types.js";
import { decryptForWorkspace, encryptForWorkspace } from "./secret-crypto.js";

const connectionStatusByKey = new Map<string, McpConnectionStatus>();
const BROWSER_MCP_SUMMARY =
  "Built-in browser-tab tools for opening visible IDE editor browser tabs, locking them, clicking, typing, inspecting metadata, viewport testing, and optionally using legacy server Chromium automation.";
const PHONE_MCP_SUMMARY =
  "Built-in Android phone control tools for capability discovery, app launch, accessibility snapshots, screenshots, gestures, system actions, safe settings pages, and Cesium-owned secondary displays.";

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
  const browserEnabled = file.builtins?.browser?.enabled !== false;
  const phoneEnabled = file.builtins?.phone?.enabled !== false;
  const browserServer: McpServerPublic = {
    id: BROWSER_MCP_SERVER_ID,
    label: "Browser",
    enabled: browserEnabled,
    transport: "stdio",
    stdio: { command: "builtin:browser", args: [] },
    auth: { kind: "none" },
    summary: BROWSER_MCP_SUMMARY,
    createdAt: 0,
    updatedAt: file.builtins?.browser?.updatedAt ?? 0,
    builtIn: true,
    removable: false,
    connectionStatus: browserEnabled
      ? { connected: true, lastCheckedAt: Date.now(), toolCount: BROWSER_MCP_TOOLS.length }
      : { connected: false, lastCheckedAt: Date.now(), error: "Disabled" },
  };
  const phoneServer: McpServerPublic = {
    id: PHONE_MCP_SERVER_ID,
    label: "Android phone",
    enabled: phoneEnabled,
    transport: "stdio",
    stdio: { command: "builtin:phone", args: [] },
    auth: { kind: "none" },
    summary: PHONE_MCP_SUMMARY,
    createdAt: 0,
    updatedAt: file.builtins?.phone?.updatedAt ?? 0,
    builtIn: true,
    removable: false,
    connectionStatus: phoneEnabled
      ? { connected: true, lastCheckedAt: Date.now(), toolCount: PHONE_MCP_TOOLS.length }
      : { connected: false, lastCheckedAt: Date.now(), error: "Disabled" },
  };
  return [browserServer, phoneServer, ...file.servers.map((server) => ({
    ...server,
    removable: true,
    connectionStatus: getMcpConnectionStatus(workspaceId, server.id),
  }))];
}

export async function isBuiltInBrowserMcpEnabled(workspaceId: string): Promise<boolean> {
  const file = await readServersFile(workspaceId);
  return file.builtins?.browser?.enabled !== false;
}

export async function setBuiltInBrowserMcpEnabled(
  workspaceId: string,
  enabled: boolean
): Promise<void> {
  const file = await readServersFile(workspaceId);
  const now = Date.now();
  await writeServersFile(workspaceId, {
    ...file,
    updatedAt: now,
    builtins: {
      ...file.builtins,
      browser: { enabled, updatedAt: now },
    },
  });
}

export async function isBuiltInPhoneMcpEnabled(workspaceId: string): Promise<boolean> {
  const file = await readServersFile(workspaceId);
  return file.builtins?.phone?.enabled !== false;
}

export async function setBuiltInPhoneMcpEnabled(
  workspaceId: string,
  enabled: boolean
): Promise<void> {
  const file = await readServersFile(workspaceId);
  const now = Date.now();
  await writeServersFile(workspaceId, {
    ...file,
    updatedAt: now,
    builtins: {
      ...file.builtins,
      phone: { enabled, updatedAt: now },
    },
  });
}

export async function getMcpCatalogRevision(workspaceId: string): Promise<number> {
  const file = await readServersFile(workspaceId);
  return file.updatedAt;
}

export async function touchMcpCatalogRevision(workspaceId: string): Promise<number> {
  const file = await readServersFile(workspaceId);
  const now = Date.now();
  await writeServersFile(workspaceId, {
    ...file,
    updatedAt: now,
  });
  return now;
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
    ...file,
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
    ...file,
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
  const includeBrowser = await isBuiltInBrowserMcpEnabled(workspaceId);
  const includePhone = await isBuiltInPhoneMcpEnabled(workspaceId);
  return [
    ...(includeBrowser ? [{
      id: BROWSER_MCP_SERVER_ID,
      label: "Browser",
      summary: BROWSER_MCP_SUMMARY,
    }] : []),
    ...(includePhone ? [{
      id: PHONE_MCP_SERVER_ID,
      label: "Android phone",
      summary: PHONE_MCP_SUMMARY,
    }] : []),
    ...servers.map((server) => ({
      id: server.id,
      label: server.label,
      summary: server.summary?.trim() || `${server.transport} MCP server`,
    })),
  ];
}
