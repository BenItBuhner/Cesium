import { randomUUID } from "node:crypto";
import path from "node:path";
import { DATA_DIR, readJsonFile, writeJsonFile } from "../persistence.js";
import { isActiveAgentBackendId } from "../active-agent-backends.js";
import type { AgentBackendId } from "../agents/types.js";
import {
  isCloudAgentProviderId,
  type CloudAgentConnection,
  type CloudAgentConnectionPublic,
  type CloudAgentExecutionMode,
  type CloudAgentOAuthApp,
  type CloudAgentOAuthAppPublic,
  type CloudAgentProviderId,
  type CloudAgentRoutingRule,
  type CloudAgentSettings,
  type CloudAgentSettingsPublic,
} from "./types.js";

const SETTINGS_FILE = path.join(DATA_DIR, "profile", "cloud-agents-settings.json");

function isAgentBackendId(value: unknown): value is AgentBackendId {
  return typeof value === "string" && isActiveAgentBackendId(value);
}

function isExecutionMode(value: unknown): value is CloudAgentExecutionMode {
  return value === "isolated" || value === "local";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function defaultSettings(): CloudAgentSettings {
  return {
    schemaVersion: 1,
    updatedAt: 0,
    defaults: {
      backendId: "cesium-agent",
      modelId: null,
      executionMode: "isolated",
      // Assignments dispatch immediately so they show up as normal
      // conversations in the agent rail without a manual review step.
      autoDispatch: true,
      workspaceId: null,
    },
    routingRules: [],
    connections: [],
    oauthApps: [],
  };
}

function normalizeConnection(raw: unknown): CloudAgentConnection | null {
  const record = asRecord(raw);
  const providerId = record?.providerId;
  const accessToken = asString(record?.accessToken);
  if (!record || !isCloudAgentProviderId(providerId) || !accessToken) {
    return null;
  }
  const now = Date.now();
  return {
    providerId,
    method: record.method === "oauth" ? "oauth" : "token",
    accessToken,
    ...(asString(record.webhookSecret) ? { webhookSecret: asString(record.webhookSecret) } : {}),
    ...(asString(record.accountLabel) ? { accountLabel: asString(record.accountLabel) } : {}),
    ...(Array.isArray(record.scopes)
      ? { scopes: record.scopes.filter((s): s is string => typeof s === "string") }
      : {}),
    connectedAt: asNumber(record.connectedAt) ?? now,
    updatedAt: asNumber(record.updatedAt) ?? now,
  };
}

function normalizeOAuthApp(raw: unknown): CloudAgentOAuthApp | null {
  const record = asRecord(raw);
  const providerId = record?.providerId;
  const clientId = asString(record?.clientId);
  const clientSecret = asString(record?.clientSecret);
  if (!record || !isCloudAgentProviderId(providerId) || !clientId || !clientSecret) {
    return null;
  }
  return {
    providerId,
    clientId,
    clientSecret,
    updatedAt: asNumber(record.updatedAt) ?? Date.now(),
  };
}

function normalizeRoutingRule(raw: unknown): CloudAgentRoutingRule | null {
  const record = asRecord(raw);
  const workspaceId = asString(record?.workspaceId);
  if (!record || !workspaceId) {
    return null;
  }
  const providerId = record.providerId;
  return {
    id: asString(record.id) ?? randomUUID(),
    providerId: isCloudAgentProviderId(providerId) ? providerId : "any",
    match: typeof record.match === "string" ? record.match.trim() : "",
    workspaceId,
    ...(isAgentBackendId(record.backendId) ? { backendId: record.backendId } : {}),
    ...(asString(record.modelId) ? { modelId: asString(record.modelId) } : {}),
    ...(isExecutionMode(record.executionMode) ? { executionMode: record.executionMode } : {}),
  };
}

function normalizeSettings(raw: unknown): CloudAgentSettings {
  const defaults = defaultSettings();
  const record = asRecord(raw);
  if (!record || record.schemaVersion !== 1) {
    return defaults;
  }
  const defaultsRecord = asRecord(record.defaults);
  return {
    schemaVersion: 1,
    updatedAt: asNumber(record.updatedAt) ?? defaults.updatedAt,
    defaults: {
      backendId: isAgentBackendId(defaultsRecord?.backendId)
        ? defaultsRecord!.backendId as AgentBackendId
        : defaults.defaults.backendId,
      modelId: asString(defaultsRecord?.modelId) ?? null,
      executionMode: isExecutionMode(defaultsRecord?.executionMode)
        ? (defaultsRecord!.executionMode as CloudAgentExecutionMode)
        : defaults.defaults.executionMode,
      autoDispatch: defaultsRecord?.autoDispatch !== false,
      workspaceId: asString(defaultsRecord?.workspaceId) ?? null,
    },
    routingRules: Array.isArray(record.routingRules)
      ? record.routingRules
          .map(normalizeRoutingRule)
          .filter((rule): rule is CloudAgentRoutingRule => rule != null)
          .slice(0, 100)
      : [],
    connections: Array.isArray(record.connections)
      ? record.connections
          .map(normalizeConnection)
          .filter((connection): connection is CloudAgentConnection => connection != null)
      : [],
    oauthApps: Array.isArray(record.oauthApps)
      ? record.oauthApps
          .map(normalizeOAuthApp)
          .filter((app): app is CloudAgentOAuthApp => app != null)
      : [],
  };
}

function redactedConnection(connection: CloudAgentConnection): CloudAgentConnectionPublic {
  const { accessToken, webhookSecret, ...rest } = connection;
  return {
    ...rest,
    configured: true,
    tokenLastFour: accessToken.slice(-4),
    webhookSecretConfigured: Boolean(webhookSecret),
  };
}

function redactedOAuthApp(app: CloudAgentOAuthApp): CloudAgentOAuthAppPublic {
  const { clientSecret, ...rest } = app;
  void clientSecret;
  return { ...rest, clientSecretConfigured: true };
}

export function getCloudAgentSettingsPath(): string {
  return SETTINGS_FILE;
}

export async function getCloudAgentSettings(): Promise<CloudAgentSettings> {
  return normalizeSettings(await readJsonFile<unknown>(SETTINGS_FILE, null));
}

export async function saveCloudAgentSettings(
  settings: CloudAgentSettings
): Promise<CloudAgentSettings> {
  const normalized = normalizeSettings({
    ...settings,
    schemaVersion: 1,
    updatedAt: Date.now(),
  });
  await writeJsonFile(SETTINGS_FILE, normalized);
  return normalized;
}

export async function getCloudAgentSettingsPublic(): Promise<CloudAgentSettingsPublic> {
  const settings = await getCloudAgentSettings();
  return {
    ...settings,
    connections: settings.connections.map(redactedConnection),
    oauthApps: settings.oauthApps.map(redactedOAuthApp),
  };
}

export type CloudAgentSettingsPatch = {
  defaults?: Partial<CloudAgentSettings["defaults"]>;
  routingRules?: CloudAgentRoutingRule[];
};

export async function patchCloudAgentSettings(
  patch: CloudAgentSettingsPatch
): Promise<CloudAgentSettingsPublic> {
  const settings = await getCloudAgentSettings();
  await saveCloudAgentSettings({
    ...settings,
    defaults: { ...settings.defaults, ...(patch.defaults ?? {}) },
    ...(patch.routingRules !== undefined ? { routingRules: patch.routingRules } : {}),
  });
  return getCloudAgentSettingsPublic();
}

export async function upsertCloudAgentConnection(input: {
  providerId: CloudAgentProviderId;
  method: CloudAgentConnection["method"];
  accessToken: string;
  webhookSecret?: string;
  accountLabel?: string;
  scopes?: string[];
}): Promise<CloudAgentSettingsPublic> {
  const settings = await getCloudAgentSettings();
  const now = Date.now();
  const existing = settings.connections.find(
    (connection) => connection.providerId === input.providerId
  );
  const next: CloudAgentConnection = {
    providerId: input.providerId,
    method: input.method,
    accessToken: input.accessToken.trim(),
    webhookSecret: input.webhookSecret?.trim() || existing?.webhookSecret,
    accountLabel: input.accountLabel?.trim() || existing?.accountLabel,
    scopes: input.scopes ?? existing?.scopes,
    connectedAt: existing?.connectedAt ?? now,
    updatedAt: now,
  };
  await saveCloudAgentSettings({
    ...settings,
    connections: [
      next,
      ...settings.connections.filter(
        (connection) => connection.providerId !== input.providerId
      ),
    ],
  });
  return getCloudAgentSettingsPublic();
}

export async function setCloudAgentWebhookSecret(input: {
  providerId: CloudAgentProviderId;
  webhookSecret: string | null;
}): Promise<CloudAgentSettingsPublic> {
  const settings = await getCloudAgentSettings();
  const existing = settings.connections.find(
    (connection) => connection.providerId === input.providerId
  );
  if (!existing) {
    throw new Error(`No ${input.providerId} connection configured.`);
  }
  const next: CloudAgentConnection = {
    ...existing,
    webhookSecret: input.webhookSecret?.trim() || undefined,
    updatedAt: Date.now(),
  };
  await saveCloudAgentSettings({
    ...settings,
    connections: [
      next,
      ...settings.connections.filter(
        (connection) => connection.providerId !== input.providerId
      ),
    ],
  });
  return getCloudAgentSettingsPublic();
}

export async function deleteCloudAgentConnection(
  providerId: CloudAgentProviderId
): Promise<CloudAgentSettingsPublic> {
  const settings = await getCloudAgentSettings();
  await saveCloudAgentSettings({
    ...settings,
    connections: settings.connections.filter(
      (connection) => connection.providerId !== providerId
    ),
  });
  return getCloudAgentSettingsPublic();
}

export async function upsertCloudAgentOAuthApp(input: {
  providerId: CloudAgentProviderId;
  clientId: string;
  clientSecret: string;
}): Promise<CloudAgentSettingsPublic> {
  const settings = await getCloudAgentSettings();
  const next: CloudAgentOAuthApp = {
    providerId: input.providerId,
    clientId: input.clientId.trim(),
    clientSecret: input.clientSecret.trim(),
    updatedAt: Date.now(),
  };
  await saveCloudAgentSettings({
    ...settings,
    oauthApps: [
      next,
      ...settings.oauthApps.filter((app) => app.providerId !== input.providerId),
    ],
  });
  return getCloudAgentSettingsPublic();
}

export async function getCloudAgentConnection(
  providerId: CloudAgentProviderId
): Promise<CloudAgentConnection | null> {
  const settings = await getCloudAgentSettings();
  return (
    settings.connections.find((connection) => connection.providerId === providerId) ?? null
  );
}

export async function getCloudAgentOAuthApp(
  providerId: CloudAgentProviderId
): Promise<CloudAgentOAuthApp | null> {
  const settings = await getCloudAgentSettings();
  return settings.oauthApps.find((app) => app.providerId === providerId) ?? null;
}
