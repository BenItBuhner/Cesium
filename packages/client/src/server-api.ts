"use client";

import type { GlobalSettingsState } from "./global-settings";
import type {
  AgentConversationConfigPatch,
  AgentConversationCreateInput,
  AgentConversationGroupsResult,
  AgentConversationListResult,
  AgentConversationMetadataPatch,
  AgentConversationRecord,
  AgentConversationSnapshot,
  AgentConversationSnapshotHead,
  AgentContextUsageSnapshot,
} from "@cesium/core";
import type { WorkspaceSessionState } from "./workspace-session";
import type {
  FileNode,
  GitWorkspaceStatus,
  GitWorktreeInfo,
  GitWorktreeSetupResult,
  ImageAttachment,
  PlanBuildHandoff,
  QueuedPromptConfigOverride,
  TerminalInfo,
  WorkspaceInfo,
  WorkspaceRecord,
  WorkspaceWindowRecord,
} from "@cesium/core";
import { toWebSocketUrl } from "./ws-client";
import { recordPerfSample } from "./dev-perf";
import {
  attachSessionToken,
  buildAuthenticatedUrl,
  clearStoredAuth,
  getStoredSessionToken,
  syncAuthTokenFromResponse,
} from "./auth-client";
import {
  resolveClientServerBaseUrl,
  resolveExplicitServerBaseUrlForCurrentWindow,
} from "./resolve-server-base-url";
import type {
  McpConnectionStatus,
  McpPresetDefinition,
  McpServerConfig,
  McpServerPublic,
} from "./mcp-types";
import type {
  AgentPluginDefinition,
  AgentPluginDiscoveryResult,
  AgentPluginHarnessCapability,
  AgentPluginInstallRecord,
  AgentPluginPublic,
  AgentPluginVerificationReport,
} from "./plugin-types";
import type { AgentBackendId } from "@cesium/core";
import type {
  OrchestrationBoardRecord,
  OrchestrationBoardSnapshot,
  OrchestrationColumnId,
  OrchestrationIssuePriority,
} from "@cesium/core";

export type ServerRequestContext = {
  serverId?: string;
  baseUrl: string;
  workspaceId?: string | null;
};

export function toServerRequestContext(input: {
  id: string;
  baseUrl: string;
}): ServerRequestContext {
  return {
    serverId: input.id,
    baseUrl: input.baseUrl,
  };
}

let activeWorkspaceId: string | null = null;

export function setActiveWorkspaceId(workspaceId: string | null): void {
  activeWorkspaceId = workspaceId;
}

function getWorkspaceHeaders(
  skipWorkspaceHeader?: boolean,
  workspaceIdOverride?: string | null
): HeadersInit {
  const workspaceId = workspaceIdOverride !== undefined ? workspaceIdOverride : activeWorkspaceId;
  if (skipWorkspaceHeader || !workspaceId) {
    return {};
  }
  return {
    "x-opencursor-workspace-id": workspaceId,
  };
}

function resolveServerRequestBaseUrl(server?: ServerRequestContext): string {
  return server?.baseUrl
    ? resolveExplicitServerBaseUrlForCurrentWindow(server.baseUrl)
    : resolveClientServerBaseUrl();
}

function revisionKeyForServer(revisionKey: string, server?: ServerRequestContext): string {
  return server?.baseUrl ? `${server.baseUrl}\0${revisionKey}` : revisionKey;
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) {
    return `Request failed with status ${response.status}`;
  }
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const message = parsed.error ?? parsed.message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  } catch {
    // Fall through to the raw response body.
  }
  return text;
}

export type FileReadResult = {
  content: string;
  language: string;
  size: number;
  fileKind: "text" | "svg" | "image";
  mimeType: string;
  previewPath?: string;
  readByteOffset?: number;
  readByteLength?: number;
  truncated?: boolean;
  totalSize?: number;
};

export type FileStatResult = {
  exists: boolean;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtime: number | null;
};

export type FileSearchResult = {
  path: string;
  name: string;
  language: string;
};

export type AudioTranscriptionResult = {
  text: string;
};

async function request<T>(
  input: string,
  init?: RequestInit,
  options?: { skipWorkspaceHeader?: boolean; cache?: RequestCache; server?: ServerRequestContext }
): Promise<T> {
  // Mutating methods (POST/PUT/PATCH/DELETE) must never be cached; GETs rely on
  // the server's `Cache-Control: stale-while-revalidate` headers so repeat page
  // loads hit the browser cache first and revalidate in the background.
  const method = (init?.method ?? "GET").toUpperCase();
  const cacheMode: RequestCache = method === "GET" ? "default" : "no-store";
  const startedAt = performance.now();
  const baseUrl = resolveServerRequestBaseUrl(options?.server);
  const serverBaseUrl = options?.server?.baseUrl;
  const hadSessionToken = Boolean(getStoredSessionToken(serverBaseUrl));
  const response = await fetch(`${baseUrl}${input}`, {
    ...init,
    headers: Object.fromEntries(
      attachSessionToken({
        "Content-Type": "application/json",
        ...getWorkspaceHeaders(options?.skipWorkspaceHeader, options?.server?.workspaceId),
        ...(init?.headers ?? {}),
      }, serverBaseUrl).entries()
    ),
    credentials: "include",
    cache: options?.cache ?? cacheMode,
  });
  recordPerfSample("api.request", startedAt, {
    method,
    path: input.split("?")[0] ?? input,
    status: response.status,
    serverMs: Number.parseFloat(response.headers.get("x-opencursor-perf-ms") ?? "0") || null,
  });

  syncAuthTokenFromResponse(response, serverBaseUrl);

  if (response.status === 401 && hadSessionToken) {
    clearStoredAuth(serverBaseUrl);
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as T;
}

/**
 * Per-key revision registry for endpoints that support If-Match optimistic
 * concurrency. Captured from the `ETag` header on GET and echoed back on
 * subsequent PUTs. In-memory only: on page reload the client re-fetches and
 * picks up the current revision from the server.
 */
const etagRegistry = new Map<string, string>();

function parseEtagToRevision(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const match = headerValue.trim().match(/^(?:W\/)?"?(\d+)"?$/);
  if (!match) return null;
  const numeric = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Makes a GET-like request that tracks ETag state for a given revision key.
 * The returned body is parsed as JSON; the captured revision is stored so
 * follow-up mutations can send `If-Match`.
 */
async function requestWithEtag<T>(
  input: string,
  revisionKey: string,
  options?: { skipWorkspaceHeader?: boolean; server?: ServerRequestContext }
): Promise<T> {
  const baseUrl = resolveServerRequestBaseUrl(options?.server);
  const serverBaseUrl = options?.server?.baseUrl;
  const scopedRevisionKey = revisionKeyForServer(revisionKey, options?.server);
  const hadSessionToken = Boolean(getStoredSessionToken(serverBaseUrl));
  const response = await fetch(`${baseUrl}${input}`, {
    headers: Object.fromEntries(
      attachSessionToken({
        "Content-Type": "application/json",
        ...getWorkspaceHeaders(options?.skipWorkspaceHeader, options?.server?.workspaceId),
      }, serverBaseUrl).entries()
    ),
    credentials: "include",
    cache: "no-store",
  });

  syncAuthTokenFromResponse(response, serverBaseUrl);

  if (response.status === 401 && hadSessionToken) {
    clearStoredAuth(serverBaseUrl);
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const etag = response.headers.get("etag");
  if (etag) {
    etagRegistry.set(scopedRevisionKey, etag);
  }

  return (await response.json()) as T;
}

/**
 * Makes a PUT-like request that includes `If-Match` from the registry (if
 * present) and captures the fresh ETag from the response for future writes.
 * On 412 Precondition Failed the cached revision is dropped so the next
 * mutation runs without `If-Match` (or a fresh GET re-primes it).
 */
async function mutateWithEtag(
  input: string,
  body: string,
  revisionKey: string,
  options?: {
    method?: "PUT" | "POST" | "PATCH";
    keepalive?: boolean;
    skipWorkspaceHeader?: boolean;
    server?: ServerRequestContext;
  }
): Promise<{ revision?: number; etag: string | null }> {
  const baseUrl = resolveServerRequestBaseUrl(options?.server);
  const serverBaseUrl = options?.server?.baseUrl;
  const scopedRevisionKey = revisionKeyForServer(revisionKey, options?.server);
  const cachedEtag = etagRegistry.get(scopedRevisionKey);
  const hadSessionToken = Boolean(getStoredSessionToken(serverBaseUrl));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(getWorkspaceHeaders(options?.skipWorkspaceHeader, options?.server?.workspaceId) as Record<
      string,
      string
    >),
  };
  if (cachedEtag) {
    headers["If-Match"] = cachedEtag;
  }
  const response = await fetch(`${baseUrl}${input}`, {
    method: options?.method ?? "PUT",
    body,
    keepalive: options?.keepalive,
    headers: Object.fromEntries(attachSessionToken(headers, serverBaseUrl).entries()),
    credentials: "include",
    cache: "no-store",
  });

  syncAuthTokenFromResponse(response, serverBaseUrl);

  if (response.status === 401 && hadSessionToken) {
    clearStoredAuth(serverBaseUrl);
  }

  if (response.status === 412) {
    // Stale revision — drop the cached tag so the next write succeeds (or a
    // fresh GET primes the registry). Consumers may choose to re-fetch and
    // retry; the default behaviour here is to surface the conflict.
    etagRegistry.delete(scopedRevisionKey);
    const etag = response.headers.get("etag");
    throw new Error(
      `Revision conflict: server rejected If-Match (current: ${etag ?? "unknown"})`
    );
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const etag = response.headers.get("etag");
  if (etag) {
    etagRegistry.set(scopedRevisionKey, etag);
  }
  const revision = parseEtagToRevision(etag) ?? undefined;
  return { revision, etag };
}

/** Clears the cached ETag for a revision key — useful on logout or workspace switch. */
export function clearCachedRevision(revisionKey: string): void {
  etagRegistry.delete(revisionKey);
}

export function getServerBaseUrl(): string {
  return resolveClientServerBaseUrl();
}

export function buildAgentWebSocketUrl(workspaceId: string): string {
  const params = new URLSearchParams({ workspaceId });
  const base = `${toWebSocketUrl(resolveClientServerBaseUrl())}/ws/agent?${params.toString()}`;
  return buildAuthenticatedUrl(base);
}

export function buildOrchestrationWebSocketUrl(workspaceId: string): string {
  const params = new URLSearchParams({ workspaceId });
  const base = `${toWebSocketUrl(resolveClientServerBaseUrl())}/ws/orchestration?${params.toString()}`;
  return buildAuthenticatedUrl(base);
}

export function buildAgentWebSocketUrlForServer(
  workspaceId: string,
  server: ServerRequestContext
): string {
  const params = new URLSearchParams({ workspaceId });
  const base = `${toWebSocketUrl(resolveServerRequestBaseUrl(server))}/ws/agent?${params.toString()}`;
  return buildAuthenticatedUrl(base, server.baseUrl);
}

export async function fetchWorkspaceBootstrap(): Promise<{
  workspaces: WorkspaceRecord[];
  defaultWorkspaceId: string | null;
  startupWorkspaceId: string | null;
  recentWorkspaceIds: string[];
  homeWorkspaceId: string | null;
}> {
  return request(`/api/workspaces/bootstrap`, undefined, {
    skipWorkspaceHeader: true,
  });
}

export async function fetchWorkspaceBootstrapForServer(
  server: ServerRequestContext
): Promise<{
  workspaces: WorkspaceRecord[];
  defaultWorkspaceId: string | null;
  startupWorkspaceId: string | null;
  recentWorkspaceIds: string[];
  homeWorkspaceId: string | null;
}> {
  return request(`/api/workspaces/bootstrap`, undefined, {
    skipWorkspaceHeader: true,
    server,
  });
}

export async function fetchWorkspaces(): Promise<{
  workspaces: WorkspaceRecord[];
  defaultWorkspaceId: string | null;
  lastOpenedWorkspaceId: string | null;
  recentWorkspaceIds: string[];
  homeWorkspaceId: string | null;
}> {
  return request(`/api/workspaces`, undefined, {
    skipWorkspaceHeader: true,
  });
}

export async function fetchWorkspacesForServer(
  server: ServerRequestContext
): Promise<{
  workspaces: WorkspaceRecord[];
  defaultWorkspaceId: string | null;
  lastOpenedWorkspaceId: string | null;
  recentWorkspaceIds: string[];
  homeWorkspaceId: string | null;
}> {
  return request(`/api/workspaces`, undefined, {
    skipWorkspaceHeader: true,
    server,
  });
}

export async function openWorkspaceSelection(input: {
  workspaceId?: string;
  root?: string;
  name?: string;
  trackRecent?: boolean;
}): Promise<{
  workspace: WorkspaceRecord;
  workspaces: WorkspaceRecord[];
  defaultWorkspaceId: string | null;
  recentWorkspaceIds: string[];
  homeWorkspaceId: string | null;
}> {
  return request(
    `/api/workspaces/open`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    { skipWorkspaceHeader: true }
  );
}

export async function markWorkspaceActivity(workspaceId: string): Promise<{
  ok: true;
  workspace: WorkspaceRecord;
  workspaces: WorkspaceRecord[];
  defaultWorkspaceId: string | null;
  recentWorkspaceIds: string[];
  homeWorkspaceId: string | null;
}> {
  return request(
    `/api/workspaces/activity`,
    {
      method: "POST",
      body: JSON.stringify({ workspaceId }),
    },
    { skipWorkspaceHeader: true }
  );
}

export async function createWorkspaceSelection(input: {
  name?: string;
  parentPath: string;
  directoryName: string;
  setDefault?: boolean;
}): Promise<{
  workspace: WorkspaceRecord;
  workspaces: WorkspaceRecord[];
  defaultWorkspaceId: string | null;
  recentWorkspaceIds: string[];
  homeWorkspaceId: string | null;
}> {
  return request(
    `/api/workspaces/create`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    { skipWorkspaceHeader: true }
  );
}

export type SshWorkspaceMetadata = {
  schemaVersion: 1;
  workspaceId: string;
  target: string;
  user: string | null;
  host: string;
  port: number | null;
  remotePath: string;
  localRoot: string;
  keyPath: string | null;
  createdAt: number;
  updatedAt: number;
  lastPulledAt: number | null;
  lastPushedAt: number | null;
};

export async function createSshWorkspaceSelection(input: {
  target: string;
  port?: number;
  remotePath: string;
  mirrorName?: string;
  name?: string;
  keyPath?: string;
  password?: string;
  setDefault?: boolean;
}): Promise<{
  workspace: WorkspaceRecord;
  metadata: SshWorkspaceMetadata;
  workspaces: WorkspaceRecord[];
  defaultWorkspaceId: string | null;
  recentWorkspaceIds: string[];
  homeWorkspaceId: string | null;
}> {
  return request(
    `/api/workspaces/ssh`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    { skipWorkspaceHeader: true }
  );
}

export async function probeSshWorkspaceConnection(input: {
  target: string;
  port?: number;
  keyPath?: string;
  password?: string;
}): Promise<{
  ok: true;
  target: string;
  username: string;
  host: string;
  port: number | null;
}> {
  return request(
    `/api/workspaces/ssh/probe`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    { skipWorkspaceHeader: true }
  );
}

export async function cloneGitRepositoryOnRemoteSsh(input: {
  target: string;
  port?: number;
  repoUrl: string;
  parentRemotePath: string;
  directoryName?: string;
  keyPath?: string;
  password?: string;
}): Promise<{
  currentPath: string;
  parentPath: string | null;
  entries: Array<{ name: string; path: string }>;
}> {
  return request(
    `/api/workspaces/ssh/clone`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    { skipWorkspaceHeader: true }
  );
}

export async function browseSshWorkspaceDirectories(input: {
  target: string;
  port?: number;
  remotePath?: string;
  keyPath?: string;
  password?: string;
}): Promise<{
  currentPath: string;
  parentPath: string | null;
  entries: Array<{ name: string; path: string }>;
}> {
  return request(
    `/api/workspaces/ssh/browse`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    { skipWorkspaceHeader: true }
  );
}

export async function createSshWorkspaceDirectory(input: {
  target: string;
  port?: number;
  remotePath?: string;
  directoryName: string;
  keyPath?: string;
  password?: string;
}): Promise<{
  currentPath: string;
  parentPath: string | null;
  entries: Array<{ name: string; path: string }>;
}> {
  return request(
    `/api/workspaces/ssh/mkdir`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    { skipWorkspaceHeader: true }
  );
}

export async function fetchSshWorkspaceMetadata(
  workspaceId: string
): Promise<{ metadata: SshWorkspaceMetadata }> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/ssh`,
    undefined,
    { skipWorkspaceHeader: true }
  );
}

export async function pullSshWorkspaceSelection(
  workspaceId: string
): Promise<{ ok: true; metadata: SshWorkspaceMetadata }> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/ssh/pull`,
    { method: "POST", body: JSON.stringify({}) },
    { skipWorkspaceHeader: true }
  );
}

export async function pushSshWorkspaceSelection(
  workspaceId: string
): Promise<{ ok: true; metadata: SshWorkspaceMetadata }> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/ssh/push`,
    { method: "POST", body: JSON.stringify({}) },
    { skipWorkspaceHeader: true }
  );
}

export async function setDefaultWorkspaceSelection(
  workspaceId: string
): Promise<{ ok: true; defaultWorkspaceId: string | null }> {
  return request(
    `/api/workspaces/default`,
    {
      method: "PATCH",
      body: JSON.stringify({ workspaceId }),
    },
    { skipWorkspaceHeader: true }
  );
}

export async function browseWorkspaceHostDirectories(path?: string): Promise<
  | {
      roots: Array<{ path: string; label: string }>;
      homeWorkspaceId: string | null;
    }
  | {
      currentPath: string;
      parentPath: string | null;
      entries: Array<{ name: string; path: string }>;
      homeWorkspaceId: string | null;
    }
> {
  const q = path?.trim()
    ? `?path=${encodeURIComponent(path.trim())}`
    : "";
  return request(`/api/workspaces/browse${q}`, undefined, {
    skipWorkspaceHeader: true,
  });
}

export async function cloneWorkspaceFromGit(input: {
  repoUrl: string;
  parentPath: string;
  directoryName?: string;
  name?: string;
  setDefault?: boolean;
}): Promise<{
  workspace: WorkspaceRecord;
  workspaces: WorkspaceRecord[];
  defaultWorkspaceId: string | null;
  recentWorkspaceIds: string[];
  homeWorkspaceId: string | null;
}> {
  return request(
    `/api/workspaces/clone`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    { skipWorkspaceHeader: true }
  );
}

export async function fetchWorkspaceGitStatus(workspaceId: string): Promise<{
  workspace: WorkspaceRecord;
  status: GitWorkspaceStatus;
}> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/git/status`,
    undefined,
    { skipWorkspaceHeader: true }
  );
}

export async function initializeWorkspaceGitRepo(workspaceId: string): Promise<{
  ok: true;
  workspace: WorkspaceRecord;
  status: GitWorkspaceStatus;
}> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/git/init`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
    { skipWorkspaceHeader: true }
  );
}

export async function switchWorkspaceGitBranch(input: {
  workspaceId: string;
  branch: string;
}): Promise<{
  ok: true;
  workspace?: WorkspaceRecord;
  openedWorkspace?: WorkspaceRecord;
  checkedOutWorktree?: GitWorktreeInfo;
  status: GitWorkspaceStatus;
}> {
  return request(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/git/switch`,
    {
      method: "POST",
      body: JSON.stringify({ branch: input.branch }),
    },
    { skipWorkspaceHeader: true }
  );
}

export async function createWorkspaceGitWorktree(input: {
  workspaceId: string;
  branch: string;
  baseBranch?: string;
  newBranch?: boolean;
  targetPath?: string;
  runSetup?: boolean;
  name?: string;
}): Promise<{
  ok: true;
  workspace: WorkspaceRecord;
  workspaces: WorkspaceRecord[];
  defaultWorkspaceId: string | null;
  recentWorkspaceIds: string[];
  homeWorkspaceId: string | null;
  worktree: { path: string; branch: string; existing: boolean };
  setup: GitWorktreeSetupResult;
}> {
  return request(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/git/worktrees`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    { skipWorkspaceHeader: true }
  );
}

export async function deleteWorkspaceGitWorktree(input: {
  workspaceId: string;
  path: string;
  force?: boolean;
}): Promise<{
  ok: true;
  workspaces: WorkspaceRecord[];
  defaultWorkspaceId: string | null;
  recentWorkspaceIds: string[];
  homeWorkspaceId: string | null;
}> {
  return request(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/git/worktrees`,
    {
      method: "DELETE",
      body: JSON.stringify({ path: input.path, force: input.force }),
    },
    { skipWorkspaceHeader: true }
  );
}

export async function deleteWorkspaceFromRegistry(workspaceId: string): Promise<{
  ok: true;
  deletedWorkspaceId: string;
  workspaces: WorkspaceRecord[];
  defaultWorkspaceId: string | null;
  recentWorkspaceIds: string[];
  homeWorkspaceId: string | null;
}> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: "DELETE",
  }, { skipWorkspaceHeader: true });
}

function workspaceSessionRevisionKey(
  workspaceId: string,
  windowId: string | null | undefined
): string {
  return windowId
    ? `workspace:${workspaceId}:window:${windowId}`
    : `workspace:${workspaceId}`;
}

export async function fetchWorkspaceSession(
  workspaceId: string,
  options?: { windowId?: string | null }
): Promise<{
  workspace: WorkspaceRecord;
  session: WorkspaceSessionState | null;
  revision?: number;
}> {
  const params = new URLSearchParams();
  if (options?.windowId) {
    params.set("windowId", options.windowId);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const revisionKey = workspaceSessionRevisionKey(
    workspaceId,
    options?.windowId ?? null
  );
  return requestWithEtag(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/session${suffix}`,
    revisionKey,
    { skipWorkspaceHeader: true }
  );
}

export async function saveWorkspaceSession(
  workspaceId: string,
  session: WorkspaceSessionState,
  options?: { keepalive?: boolean; windowId?: string | null }
): Promise<void> {
  const params = new URLSearchParams();
  if (options?.windowId) {
    params.set("windowId", options.windowId);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const revisionKey = workspaceSessionRevisionKey(
    workspaceId,
    options?.windowId ?? null
  );
  await mutateWithEtag(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/session${suffix}`,
    JSON.stringify(session),
    revisionKey,
    {
      method: "PUT",
      keepalive: options?.keepalive,
      skipWorkspaceHeader: true,
    }
  );
}

export async function fetchWorkspaceWindows(
  workspaceId: string
): Promise<{ workspace: WorkspaceRecord; windows: WorkspaceWindowRecord[] }> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/windows`, undefined, {
    skipWorkspaceHeader: true,
  });
}

export async function createWorkspaceWindow(input: {
  workspaceId: string;
  title?: string;
}): Promise<{
  workspace: WorkspaceRecord;
  window: WorkspaceWindowRecord;
  windows: WorkspaceWindowRecord[];
}> {
  return request(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/windows`,
    {
      method: "POST",
      body: JSON.stringify({ name: input.title }),
    },
    { skipWorkspaceHeader: true }
  );
}

export async function fetchWorkspaceWindowSession(
  workspaceId: string,
  windowId: string
): Promise<{
  workspace: WorkspaceRecord;
  window: WorkspaceWindowRecord;
  session: WorkspaceSessionState | null;
}> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/session?${new URLSearchParams({
      windowId,
    }).toString()}`,
    undefined,
    {
      skipWorkspaceHeader: true,
    }
  );
}

export async function updateWorkspaceWindow(
  input: {
    workspaceId: string;
    windowId: string;
    name?: string;
    lastOpenedAt?: number;
    lastFocusedAt?: number;
    markClosed?: boolean;
  }
): Promise<{
  workspace: WorkspaceRecord;
  window: WorkspaceWindowRecord;
  windows: WorkspaceWindowRecord[];
}> {
  return request(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/windows/${encodeURIComponent(input.windowId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        name: input.name,
        lastOpenedAt: input.lastOpenedAt,
        lastFocusedAt: input.lastFocusedAt,
        markClosed: input.markClosed,
      }),
    },
    { skipWorkspaceHeader: true }
  );
}

export async function saveWorkspaceWindowSession(
  workspaceId: string,
  windowId: string,
  session: WorkspaceSessionState,
  options?: { keepalive?: boolean }
): Promise<void> {
  await saveWorkspaceSession(workspaceId, session, {
    keepalive: options?.keepalive,
    windowId,
  });
}

export type CursorAgentDeploymentHintsPayload = {
  cursorAgent: {
    resolved: boolean;
    commandPreview: string | null;
    extraArgs: string[];
    permissionModeEnv: string | null;
    acpCapabilitiesJsonSet: boolean;
    cursorBinEnvSet: boolean;
  };
};

export async function fetchAgentDeploymentHints(): Promise<CursorAgentDeploymentHintsPayload> {
  return request(`/api/agents/deployment-hints`);
}

function buildPageQuery(params?: {
  limit?: number;
  cursor?: string | null;
}): string {
  if (!params) return "";
  const search = new URLSearchParams();
  if (typeof params.limit === "number" && params.limit > 0) {
    search.set("limit", String(Math.floor(params.limit)));
  }
  if (params.cursor) {
    search.set("cursor", params.cursor);
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export async function listAgentConversations(params?: {
  limit?: number;
  cursor?: string | null;
  cache?: RequestCache;
}): Promise<AgentConversationListResult> {
  return request(
    `/api/agents/conversations${buildPageQuery(params)}`,
    undefined,
    params?.cache ? { cache: params.cache } : undefined
  );
}

export async function listAgentConversationsForServer(
  server: ServerRequestContext,
  params?: {
    limit?: number;
    cursor?: string | null;
  }
): Promise<AgentConversationListResult> {
  return request(`/api/agents/conversations${buildPageQuery(params)}`, undefined, {
    server,
  });
}

export async function listCrossWorkspaceAgentConversations(params?: {
  limit?: number;
  cursor?: string | null;
}): Promise<AgentConversationGroupsResult> {
  return request(
    `/api/agents/conversations/all${buildPageQuery(params)}`,
    undefined,
    { skipWorkspaceHeader: true }
  );
}

export async function listCrossWorkspaceAgentConversationsForServer(
  server: ServerRequestContext,
  params?: {
    limit?: number;
    cursor?: string | null;
  }
): Promise<AgentConversationGroupsResult> {
  return request(
    `/api/agents/conversations/all${buildPageQuery(params)}`,
    undefined,
    { skipWorkspaceHeader: true, server }
  );
}

export async function createAgentConversation(
  input: AgentConversationCreateInput
): Promise<{ conversation: AgentConversationRecord }> {
  return request(`/api/agents/conversations`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function createAndPromptAgentConversation(
  input: AgentConversationCreateInput,
  text: string,
  attachments?: ImageAttachment[],
  ids?: {
    clientEventId?: string;
    clientMessageId?: string;
    configOverride?: QueuedPromptConfigOverride;
  }
): Promise<AgentConversationSnapshotResponse> {
  return request(`/api/agents/conversations/create-and-prompt`, {
    method: "POST",
    body: JSON.stringify({
      conversation: input,
      text,
      attachments,
      clientEventId: ids?.clientEventId,
      clientMessageId: ids?.clientMessageId,
      configOverride: ids?.configOverride,
    }),
  });
}

/** Create a no-workspace chat (temp dir sandbox) and send the first prompt. */
export async function createAndPromptStandaloneAgentConversation(
  input: AgentConversationCreateInput,
  text: string,
  attachments?: ImageAttachment[],
  ids?: { clientEventId?: string; clientMessageId?: string; title?: string }
): Promise<AgentConversationSnapshotResponse & { workspace: WorkspaceRecord }> {
  return request(
    `/api/agents/conversations/standalone/create-and-prompt`,
    {
      method: "POST",
      body: JSON.stringify({
        conversation: input,
        text,
        attachments,
        clientEventId: ids?.clientEventId,
        clientMessageId: ids?.clientMessageId,
        title: ids?.title,
      }),
    },
    { skipWorkspaceHeader: true }
  );
}

export async function generateDraftTitle(
  text: string
): Promise<{ title: string }> {
  return request(`/api/agents/conversations/draft-title`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export type AgentConversationSnapshotResponse = {
  snapshot: AgentConversationSnapshot | AgentConversationSnapshotHead;
};

export async function fetchAgentContextUsage(
  conversationId: string,
  options?: { signal?: AbortSignal }
): Promise<{ usage: AgentContextUsageSnapshot }> {
  return request(
    `/api/agents/conversations/${encodeURIComponent(conversationId)}/context-usage`,
    options?.signal ? { signal: options.signal } : undefined
  );
}

export async function fetchAgentConversationSnapshot(
  conversationId: string,
  options?: {
    hydrateRuntime?: boolean;
    /** Full event log (large). Default is paginated tail. */
    full?: boolean;
    limitTurns?: number;
    limitEvents?: number;
    signal?: AbortSignal;
  }
): Promise<AgentConversationSnapshotResponse> {
  const params = new URLSearchParams();
  if (options?.hydrateRuntime) {
    params.set("hydrate", "1");
  }
  if (options?.full) {
    params.set("full", "1");
  }
  if (options?.limitTurns != null && Number.isFinite(options.limitTurns)) {
    params.set("limitTurns", String(options.limitTurns));
  }
  if (options?.limitEvents != null && Number.isFinite(options.limitEvents)) {
    params.set("limitEvents", String(options.limitEvents));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request(
    `/api/agents/conversations/${encodeURIComponent(conversationId)}${suffix}`,
    options?.signal ? { signal: options.signal } : undefined
  );
}

export async function updateAgentConversationConfig(
  conversationId: string,
  patch: AgentConversationConfigPatch
): Promise<{ conversation: AgentConversationRecord }> {
  return request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/config`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function patchAgentConversationMetadata(
  conversationId: string,
  patch: AgentConversationMetadataPatch,
  options?: { server?: ServerRequestContext }
): Promise<{ conversation: AgentConversationRecord }> {
  return request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/metadata`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  }, options);
}

export async function promptAgentConversation(
  conversationId: string,
  text: string,
  attachments?: ImageAttachment[],
  configOverride?: QueuedPromptConfigOverride,
  ids?: {
    clientEventId?: string;
    clientMessageId?: string;
    delivery?: "normal" | "steer";
    planHandoff?: PlanBuildHandoff;
  }
): Promise<AgentConversationSnapshotResponse> {
  return request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text, attachments, configOverride, ...ids }),
  });
}

export async function retryAgentConversation(
  conversationId: string
): Promise<AgentConversationSnapshotResponse> {
  return request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/retry`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function deleteAgentConversationQueueItem(
  conversationId: string,
  itemId: string
): Promise<{ conversation: AgentConversationRecord }> {
  return request(
    `/api/agents/conversations/${encodeURIComponent(conversationId)}/queue/${encodeURIComponent(itemId)}`,
    { method: "DELETE" }
  );
}

export async function cancelAgentConversation(
  conversationId: string
): Promise<{ conversation: AgentConversationRecord }> {
  return request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function pauseAgentConversation(
  conversationId: string
): Promise<{ conversation: AgentConversationRecord }> {
  return request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/pause`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function resumeAgentConversation(
  conversationId: string
): Promise<{ conversation: AgentConversationRecord }> {
  return request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/resume`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function answerAgentPermission(
  conversationId: string,
  input: { requestId: string; optionId?: string; cancelled?: boolean }
): Promise<{ conversation: AgentConversationRecord }> {
  return request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/permission`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function answerAgentQuestion(
  conversationId: string,
  input: { questionId: string; answer: string }
): Promise<{ conversation: AgentConversationRecord }> {
  return request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/question`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function handoffAgentConversation(
  conversationId: string,
  targetAgentBackend: string,
  messageLimit?: number
): Promise<{ newConversationId: string; handoffMessageId?: string }> {
  return request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/handoff`, {
    method: "POST",
    body: JSON.stringify({ targetAgentBackend, messageLimit }),
  });
}

export async function prepareRedoAgentConversation(
  conversationId: string,
  options: { beforeMessageId: string }
): Promise<{ conversation: AgentConversationRecord }> {
  return request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/redo`, {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export async function forkAgentConversation(
  conversationId: string,
  options?: { upToMessageId?: string; beforeMessageId?: string }
): Promise<{ conversation: AgentConversationRecord }> {
  return request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/fork`, {
    method: "POST",
    body: JSON.stringify(options ?? {}),
  });
}

export async function listOrchestrationBoards(): Promise<{
  boards: OrchestrationBoardRecord[];
}> {
  return request("/api/orchestration/boards");
}

export async function createOrchestrationBoard(input?: {
  title?: string;
  description?: string;
  headConversationId?: string | null;
}): Promise<{ snapshot: OrchestrationBoardSnapshot }> {
  return request("/api/orchestration/boards", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function startOrchestrationMode(input?: {
  title?: string;
  description?: string;
  prompt?: string;
}): Promise<{
  snapshot: OrchestrationBoardSnapshot;
  headConversation: AgentConversationRecord;
}> {
  return request("/api/orchestration/start", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function fetchOrchestrationBoardSnapshot(
  boardId: string
): Promise<{ snapshot: OrchestrationBoardSnapshot }> {
  return request(`/api/orchestration/boards/${encodeURIComponent(boardId)}`);
}

export async function patchOrchestrationBoard(
  boardId: string,
  patch: {
    title?: string;
    description?: string;
    headConversationId?: string | null;
    archived?: boolean;
  }
): Promise<{ snapshot: OrchestrationBoardSnapshot }> {
  return request(`/api/orchestration/boards/${encodeURIComponent(boardId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function createOrchestrationIssue(
  boardId: string,
  input: {
    title: string;
    description?: string;
    columnId?: OrchestrationColumnId;
    priority?: OrchestrationIssuePriority;
    acceptanceCriteria?: string[];
  }
): Promise<{ snapshot: OrchestrationBoardSnapshot }> {
  return request(
    `/api/orchestration/boards/${encodeURIComponent(boardId)}/issues`,
    {
      method: "POST",
      body: JSON.stringify(input),
    }
  );
}

export async function patchOrchestrationIssue(
  boardId: string,
  issueId: string,
  patch: {
    title?: string;
    description?: string;
    columnId?: OrchestrationColumnId;
    priority?: OrchestrationIssuePriority;
    sortOrder?: number;
    acceptanceCriteria?: string[];
    dependencyIssueIds?: string[];
    blockedReason?: string | null;
  }
): Promise<{ snapshot: OrchestrationBoardSnapshot }> {
  return request(
    `/api/orchestration/boards/${encodeURIComponent(boardId)}/issues/${encodeURIComponent(issueId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(patch),
    }
  );
}

export async function deleteOrchestrationIssue(
  boardId: string,
  issueId: string
): Promise<{ snapshot: OrchestrationBoardSnapshot }> {
  return request(
    `/api/orchestration/boards/${encodeURIComponent(boardId)}/issues/${encodeURIComponent(issueId)}`,
    { method: "DELETE" }
  );
}

export async function addOrchestrationIssueComment(
  boardId: string,
  issueId: string,
  message: string
): Promise<{ snapshot: OrchestrationBoardSnapshot }> {
  return request(
    `/api/orchestration/boards/${encodeURIComponent(boardId)}/issues/${encodeURIComponent(issueId)}/comments`,
    {
      method: "POST",
      body: JSON.stringify({ message }),
    }
  );
}

export async function transcribeAudio(
  file: File,
  options?: { language?: string; prompt?: string }
): Promise<AudioTranscriptionResult> {
  const form = new FormData();
  form.set("file", file);
  if (options?.language) {
    form.set("language", options.language);
  }
  if (options?.prompt) {
    form.set("prompt", options.prompt);
  }
  const response = await fetch(`${resolveClientServerBaseUrl()}/api/audio/transcriptions`, {
    method: "POST",
    body: form,
    headers: Object.fromEntries(
      attachSessionToken(getWorkspaceHeaders()).entries()
    ),
    credentials: "include",
    cache: "no-store",
  });
  syncAuthTokenFromResponse(response);
  if (response.status === 401) {
    clearStoredAuth();
  }
  if (!response.ok) {
    const message = await response.text();
    let parsedError = "";
    try {
      parsedError = (JSON.parse(message) as { error?: string })?.error ?? "";
    } catch {
      parsedError = "";
    }
    throw new Error(parsedError || message || `Request failed with status ${response.status}`);
  }
  return (await response.json()) as AudioTranscriptionResult;
}

const GLOBAL_SETTINGS_REVISION_KEY = "settings:global";

export async function fetchGlobalSettings(options?: {
  server?: ServerRequestContext;
}): Promise<{
  settings: GlobalSettingsState;
  revision?: number;
}> {
  return requestWithEtag(
    `/api/settings/global`,
    GLOBAL_SETTINGS_REVISION_KEY,
    { skipWorkspaceHeader: true, server: options?.server }
  );
}

export async function saveGlobalSettings(
  settings: GlobalSettingsState,
  options?: { keepalive?: boolean; server?: ServerRequestContext }
): Promise<void> {
  await mutateWithEtag(
    `/api/settings/global`,
    JSON.stringify({ settings }),
    GLOBAL_SETTINGS_REVISION_KEY,
    {
      method: "PUT",
      keepalive: options?.keepalive,
      skipWorkspaceHeader: true,
      server: options?.server,
    }
  );
}

export type ModelsByBackendResponse = {
  byBackend: Record<string, Array<{ id: string; name: string }>>;
};

export async function fetchModelsByBackend(): Promise<ModelsByBackendResponse> {
  return request<ModelsByBackendResponse>("/api/settings/models-by-backend", {
    method: "GET",
  });
}

export type ModelToggleEntry = {
  id: string;
  name: string;
  on: boolean;
  backendId?: string;
};

export type ModelToggleStateResponse = {
  byBackend: Record<string, ModelToggleEntry[]>;
};

export type RefreshModelsResponse = {
  byBackend: Record<string, ModelToggleEntry[]>;
  timedOut: string[];
  failed: string[];
};

export async function fetchModelToggleState(options?: {
  server?: ServerRequestContext;
}): Promise<ModelToggleStateResponse> {
  return request<ModelToggleStateResponse>(
    "/api/settings/models",
    { method: "GET" },
    { server: options?.server }
  );
}

export async function refreshModelToggleState(options?: {
  server?: ServerRequestContext;
}): Promise<RefreshModelsResponse> {
  return request<RefreshModelsResponse>(
    "/api/settings/models/refresh",
    { method: "POST" },
    { server: options?.server }
  );
}

export type ModelToggleUpdate = {
  backendId: string;
  modelId: string;
  on: boolean;
};

export async function saveModelToggles(
  toggles: ModelToggleUpdate[],
  options?: { server?: ServerRequestContext }
): Promise<ModelToggleStateResponse> {
  return request<ModelToggleStateResponse>(
    "/api/settings/models/toggles",
    {
      method: "PUT",
      body: JSON.stringify({ toggles }),
    },
    { server: options?.server }
  );
}

export type CursorSdkCredentialStatus = {
  configured: boolean;
  source: "env" | "stored" | null;
  apiKeyName?: string;
  userEmail?: string;
  updatedAt?: number;
};

export async function fetchCursorSdkCredentialStatus(): Promise<{
  status: CursorSdkCredentialStatus;
}> {
  return request<{ status: CursorSdkCredentialStatus }>("/api/settings/cursor-sdk", {
    method: "GET",
  });
}

export async function saveCursorSdkApiKey(apiKey: string): Promise<{
  ok: true;
  status: CursorSdkCredentialStatus;
}> {
  return request<{ ok: true; status: CursorSdkCredentialStatus }>("/api/settings/cursor-sdk", {
    method: "PUT",
    body: JSON.stringify({ apiKey }),
  });
}

export async function deleteCursorSdkApiKey(): Promise<{
  ok: true;
  status: CursorSdkCredentialStatus;
}> {
  return request<{ ok: true; status: CursorSdkCredentialStatus }>("/api/settings/cursor-sdk", {
    method: "DELETE",
  });
}

export type ClaudeCodeSdkSettingsPayload = {
  configured: boolean;
  source: "stored" | "env" | null;
  updatedAt?: number;
  baseUrl?: string;
  model?: string;
  pathToExecutable?: string;
  apiKeyLastFour?: string;
  baseUrlSource?: "stored" | "env";
  modelSource?: "stored" | "env";
  pathSource?: "stored" | "env";
  apiKeySource?: "stored" | "env";
};

export async function fetchClaudeCodeSdkSettings(): Promise<{
  settings: ClaudeCodeSdkSettingsPayload;
}> {
  return request<{ settings: ClaudeCodeSdkSettingsPayload }>("/api/settings/claude-code-sdk", {
    method: "GET",
  });
}

export async function saveClaudeCodeSdkSettings(input: {
  baseUrl?: string | null;
  apiKey?: string | null;
  model?: string | null;
  pathToExecutable?: string | null;
}): Promise<{
  ok: true;
  settings: ClaudeCodeSdkSettingsPayload;
}> {
  return request<{ ok: true; settings: ClaudeCodeSdkSettingsPayload }>(
    "/api/settings/claude-code-sdk",
    {
      method: "PUT",
      body: JSON.stringify(input),
    }
  );
}

export async function deleteClaudeCodeSdkSettings(): Promise<{
  ok: true;
  settings: ClaudeCodeSdkSettingsPayload;
}> {
  return request<{ ok: true; settings: ClaudeCodeSdkSettingsPayload }>(
    "/api/settings/claude-code-sdk",
    {
      method: "DELETE",
    }
  );
}

export type PiAgentProviderAuthMethod = "oauth" | "api_key" | "env" | null;

export type PiAgentProviderStatus = {
  id: string;
  name: string;
  oauthSupported: boolean;
  usesCallbackServer?: boolean;
  authMethod: PiAgentProviderAuthMethod;
  configured: boolean;
  authLabel?: string;
  modelCount: number;
  modelsAvailable: boolean;
  apiKeyLastFour?: string;
};

export type PiAgentHomeMode = "native" | "isolated";

export type PiAgentHomeInfo = {
  agentHome: PiAgentHomeMode;
  agentDir: string;
  nativeAgentDir: string;
  isolatedAgentDir: string;
  envOverride: string | null;
  usesEnvOverride: boolean;
};

export type PiAgentSettingsPayload = {
  schemaVersion: 1;
  updatedAt: number;
  defaultProviderKeyId: string | null;
  agentHome: PiAgentHomeMode;
  configured: boolean;
  providerKeys: Array<{
    id: string;
    providerId: string;
    label: string;
    source: "stored";
    createdAt: number;
    updatedAt: number;
    lastFour?: string;
  }>;
};

export type PiAgentSettingsResponse = {
  settings: PiAgentSettingsPayload;
  providers: PiAgentProviderStatus[];
  home: PiAgentHomeInfo;
};

export type PiAgentOAuthStartResponse = {
  providerId: string;
  authUrl?: string;
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
  instructions?: string;
  callbackUrl?: string;
};

export async function fetchPiAgentSettings(): Promise<PiAgentSettingsResponse> {
  return request<PiAgentSettingsResponse>("/api/settings/pi-agent", {
    method: "GET",
  });
}

export async function savePiAgentHome(
  agentHome: PiAgentHomeMode
): Promise<
  PiAgentSettingsResponse & {
    ok: true;
    refresh?: unknown;
  }
> {
  return request<
    PiAgentSettingsResponse & {
      ok: true;
      refresh?: unknown;
    }
  >("/api/settings/pi-agent", {
    method: "PUT",
    body: JSON.stringify({ agentHome }),
  });
}

export async function startPiAgentOAuth(
  providerId: string
): Promise<PiAgentOAuthStartResponse> {
  return request<PiAgentOAuthStartResponse>(
    `/api/settings/pi-agent/oauth/${encodeURIComponent(providerId)}/start`,
    { method: "GET" }
  );
}

export async function disconnectPiAgentOAuth(providerId: string): Promise<
  PiAgentSettingsResponse & {
    ok: true;
    refresh?: unknown;
  }
> {
  return request<
    PiAgentSettingsResponse & {
      ok: true;
      refresh?: unknown;
    }
  >(`/api/settings/pi-agent/oauth/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
  });
}

export async function savePiAgentProviderKey(input: {
  id?: string;
  providerId: string;
  label?: string;
  apiKey: string;
}): Promise<
  PiAgentSettingsResponse & {
    ok: true;
    refresh?: unknown;
  }
> {
  return request<
    PiAgentSettingsResponse & {
      ok: true;
      refresh?: unknown;
    }
  >("/api/settings/pi-agent/provider-key", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export type CesiumProviderKind =
  | "openai-chat-completions"
  | "openai-responses"
  | "openai-realtime"
  | "anthropic"
  | "google-genai"
  | "openai-compatible";

export type CesiumProviderKeyStatus = {
  id: string;
  providerId: string;
  label: string;
  apiKind: CesiumProviderKind;
  baseUrl?: string;
  source: "env" | "stored";
  createdAt: number;
  updatedAt: number;
  lastFour?: string;
};

export type CesiumCustomProvider = {
  id: string;
  name: string;
  apiKind: CesiumProviderKind;
  baseUrl?: string;
  models: Array<{
    id: string;
    name: string;
    contextWindow?: number;
    supportsTools?: boolean;
    supportsReasoning?: boolean;
  }>;
};

export type CesiumAgentSettingsPayload = {
  schemaVersion: 1;
  updatedAt: number;
  configured: boolean;
  defaultProviderKeyId: string | null;
  defaultModelId: string;
  defaultApiKind: CesiumProviderKind;
  compression: {
    enabled: boolean;
    modelId: string | null;
    thresholdRatio: number;
  };
  orchestration: {
    continueWhenIncomplete: boolean;
  };
  modes: {
    enabled: Record<
      "agent" | "plan" | "orchestration" | "burn" | "workflow" | "ask",
      boolean
    >;
  };
  modeCatalog: Array<{
    id: "agent" | "plan" | "orchestration" | "burn" | "workflow" | "ask";
    label: string;
    description: string;
  }>;
  harness: {
    features: Record<string, { version: number }> & {
      subagents: {
        version: 1 | 2;
      };
    };
    limits: {
      waitMaxSeconds: number;
      waitAgentDefaultTimeoutMs: number;
      waitAgentMinTimeoutMs: number;
      waitAgentMaxTimeoutMs: number;
      maxConcurrentSubagents: number;
    };
  };
  harnessCatalog: Array<{
    id: string;
    label: string;
    description: string;
    defaultVersion: number;
    versions: Array<{
      version: number;
      label: string;
      description: string;
    }>;
  }>;
  toolPermissions: {
    editFile: "ask" | "allow" | "deny";
    terminal: "ask" | "allow" | "deny";
  };
  providerKeys: CesiumProviderKeyStatus[];
  customProviders: CesiumCustomProvider[];
};

export type CesiumModelCatalogEntry = {
  providerId: string;
  providerName: string;
  providerApiBaseUrl?: string;
  providerDocUrl?: string;
  modelId: string;
  modelName: string;
  apiKind: CesiumProviderKind;
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsStructuredOutput: boolean;
  contextWindow?: number;
  outputLimit?: number;
};

export async function fetchCesiumAgentSettings(): Promise<{
  settings: CesiumAgentSettingsPayload;
}> {
  return request<{ settings: CesiumAgentSettingsPayload }>("/api/settings/cesium-agent", {
    method: "GET",
  });
}

export async function patchCesiumAgentSettings(
  patch: Partial<
    Pick<
      CesiumAgentSettingsPayload,
      | "defaultProviderKeyId"
      | "defaultModelId"
      | "defaultApiKind"
      | "compression"
      | "orchestration"
      | "modes"
      | "harness"
      | "toolPermissions"
      | "customProviders"
    >
  >
): Promise<{ ok: true; settings: CesiumAgentSettingsPayload }> {
  return request<{ ok: true; settings: CesiumAgentSettingsPayload }>("/api/settings/cesium-agent", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function saveCesiumProviderKey(input: {
  id?: string;
  providerId: string;
  label?: string;
  apiKind: CesiumProviderKind;
  apiKey: string;
  baseUrl?: string;
}): Promise<{ ok: true; settings: CesiumAgentSettingsPayload }> {
  return request<{ ok: true; settings: CesiumAgentSettingsPayload }>(
    "/api/settings/cesium-agent/provider-key",
    {
      method: "PUT",
      body: JSON.stringify(input),
    }
  );
}

export async function deleteCesiumProviderKey(
  id: string
): Promise<{ ok: true; settings: CesiumAgentSettingsPayload }> {
  return request<{ ok: true; settings: CesiumAgentSettingsPayload }>(
    `/api/settings/cesium-agent/provider-key/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
    }
  );
}

export async function fetchCesiumModelCatalog(): Promise<{
  models: CesiumModelCatalogEntry[];
}> {
  return request<{ models: CesiumModelCatalogEntry[] }>("/api/settings/cesium-agent/models", {
    method: "GET",
  });
}

export async function refreshCesiumModelCatalog(): Promise<{
  ok: true;
  models: CesiumModelCatalogEntry[];
}> {
  return request<{ ok: true; models: CesiumModelCatalogEntry[] }>(
    "/api/settings/cesium-agent/models/refresh",
    {
      method: "POST",
    }
  );
}

export type CesiumDiscoveredProviderModel = {
  id: string;
  name: string;
  contextWindow?: number;
};

export async function discoverCesiumProviderModels(input: {
  apiKind: CesiumProviderKind;
  apiKey: string;
  baseUrl: string;
}): Promise<{ ok: true; models: CesiumDiscoveredProviderModel[] }> {
  return request<{ ok: true; models: CesiumDiscoveredProviderModel[] }>(
    "/api/settings/cesium-agent/providers/discover",
    {
      method: "POST",
      body: JSON.stringify(input),
    }
  );
}

export async function fetchTree(depth?: number): Promise<{
  root: string;
  tree: FileNode;
}> {
  // Shallow default avoids 30-90s workspace-bootstrap stalls on big home
  // directories. The explorer already lazy-loads children on expand via
  // `fetchFolderChildren`. Override by passing `depth` for tests/scripts.
  const resolved = depth ?? 2;
  return request(`/api/fs/tree?depth=${resolved}`);
}

export async function fetchFolderChildren(
  path: string,
  depth = 1
): Promise<{ path: string; children: FileNode[] }> {
  const params = new URLSearchParams({
    path,
    depth: String(depth),
  });
  return request(`/api/fs/tree/children?${params.toString()}`);
}

export async function readFile(
  path: string,
  options?: { full?: boolean; byteOffset?: number; byteLength?: number }
): Promise<FileReadResult> {
  const params = new URLSearchParams({ path });
  if (options?.full) {
    params.set("full", "1");
  }
  if (options?.byteOffset != null && Number.isFinite(options.byteOffset)) {
    params.set("byteOffset", String(Math.floor(options.byteOffset)));
  }
  if (options?.byteLength != null && Number.isFinite(options.byteLength)) {
    params.set("byteLength", String(Math.floor(options.byteLength)));
  }
  return request(`/api/fs/read?${params.toString()}`);
}

export async function writeFile(path: string, content: string): Promise<void> {
  await request(`/api/fs/write`, {
    method: "POST",
    body: JSON.stringify({ path, content }),
  });
}

export async function mkdir(relativePath: string): Promise<void> {
  await request(`/api/fs/mkdir`, {
    method: "POST",
    body: JSON.stringify({ path: relativePath }),
  });
}

export async function deletePath(relativePath: string): Promise<void> {
  await request(`/api/fs/delete`, {
    method: "POST",
    body: JSON.stringify({ path: relativePath }),
  });
}

export async function renamePath(from: string, to: string): Promise<void> {
  await request(`/api/fs/rename`, {
    method: "POST",
    body: JSON.stringify({ from, to }),
  });
}

/** Write a binary file (multipart). `relativePath` is workspace-relative. */
export async function uploadFile(relativePath: string, file: File): Promise<void> {
  const form = new FormData();
  form.set("path", relativePath);
  form.set("file", file);
  const response = await fetch(`${resolveClientServerBaseUrl()}/api/fs/upload`, {
    method: "POST",
    body: form,
    headers: Object.fromEntries(
      attachSessionToken(getWorkspaceHeaders()).entries()
    ),
    credentials: "include",
    cache: "no-store",
  });
  syncAuthTokenFromResponse(response);
  if (response.status === 401) {
    clearStoredAuth();
  }
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with status ${response.status}`);
  }
  await response.json();
}

export type UploadedAttachment = {
  id: string;
  path: string;
};

/**
 * Browser `File` or a React Native FormData file descriptor (`uri`/`name`/`type`).
 * RN's FormData accepts the descriptor shape; web continues to pass real `File`s.
 */
export type AttachmentUploadSource =
  | File
  | {
      uri: string;
      name: string;
      type: string;
    };

export async function uploadAttachments(
  files: AttachmentUploadSource[]
): Promise<UploadedAttachment[]> {
  const form = new FormData();
  for (const file of files) {
    // RN FormData typings only know Blob/File; the uri descriptor is runtime-valid.
    form.append("files", file as Blob);
  }
  const response = await fetch(`${resolveClientServerBaseUrl()}/api/agents/attachments`, {
    method: "POST",
    body: form,
    headers: Object.fromEntries(
      attachSessionToken(getWorkspaceHeaders()).entries()
    ),
    credentials: "include",
    cache: "no-store",
  });
  syncAuthTokenFromResponse(response);
  if (response.status === 401) {
    clearStoredAuth();
  }
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with status ${response.status}`);
  }
  const result = await response.json();
  return result.attachments;
}

export async function statFile(path: string): Promise<FileStatResult> {
  return request(`/api/fs/stat?path=${encodeURIComponent(path)}`);
}

export async function searchFiles(
  query: string,
  glob?: string
): Promise<FileSearchResult[]> {
  const params = new URLSearchParams();
  params.set("q", query);
  if (glob) params.set("glob", glob);
  const result = await request<{ matches: FileSearchResult[] }>(
    `/api/fs/search?${params.toString()}`
  );
  return result.matches;
}

export async function getWorkspace(): Promise<WorkspaceInfo> {
  const workspace = activeWorkspaceId
    ? await fetchWorkspaceSession(activeWorkspaceId)
    : null;
  if (!workspace) {
    throw new Error("No active workspace.");
  }
  return workspace.workspace;
}

export async function listTerminals(): Promise<TerminalInfo[]> {
  const result = await request<{ terminals: TerminalInfo[] }>(
    `/api/terminals`,
    undefined,
    { cache: "no-store" }
  );
  return result.terminals;
}

export async function createTerminal(shell?: string): Promise<{ id: string }> {
  return request(`/api/terminals`, {
    method: "POST",
    body: JSON.stringify(shell ? { shell } : {}),
  });
}

export async function deleteTerminal(id: string): Promise<void> {
  await request(`/api/terminals/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// ----- Storage driver administration -----

export type StorageDriverKind = "legacy-json" | "pg";

export type StorageDriverStats = {
  driver: StorageDriverKind;
  workspaces: number;
  agentConversations: number;
  authSessions: number;
  providerCacheEntries: number;
  hasGlobalSettings: boolean;
  hasAuthState: boolean;
};

export type StorageDriverDiagnostic = {
  stats: StorageDriverStats | null;
  available: boolean;
  error?: string;
};

export type StorageStatusResponse = {
  currentDriver: StorageDriverKind;
  drivers: Record<StorageDriverKind, StorageDriverDiagnostic>;
  migrationRunning: boolean;
};

export type StorageMigrationPhase =
  | "workspaces"
  | "workspace-profile"
  | "global-settings"
  | "auth-state"
  | "auth-sessions"
  | "workspace-sessions"
  | "workspace-windows"
  | "workspace-window-sessions"
  | "agent-conversations"
  | "agent-events"
  | "burn-goals"
  | "extensions"
  | "provider-cache";

export type StorageMigrationProgress = {
  phase: StorageMigrationPhase;
  completed: number;
  total: number | null;
  currentKey?: string;
};

export type StorageMigrationPhaseReport = {
  phase: StorageMigrationPhase;
  migrated: number;
  skipped: number;
  errors: Array<{ key: string; message: string }>;
};

export type StorageMigrationResult = {
  ok: boolean;
  fromDriver: StorageDriverKind;
  toDriver: StorageDriverKind;
  overwrite: boolean;
  phases: StorageMigrationPhaseReport[];
};

export type StorageMigrationInput = {
  from: StorageDriverKind;
  to: StorageDriverKind;
  overwrite?: boolean;
  phases?: StorageMigrationPhase[];
};

export type StorageMigrationCallbacks = {
  onStart?: (event: {
    from: StorageDriverKind;
    to: StorageDriverKind;
    overwrite: boolean;
  }) => void;
  onProgress?: (event: StorageMigrationProgress) => void;
  onResult?: (event: StorageMigrationResult) => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
};

export async function fetchStorageStatus(): Promise<StorageStatusResponse> {
  return request(`/api/storage/status`, undefined, {
    skipWorkspaceHeader: true,
  });
}

/**
 * Kicks off a migration and streams NDJSON progress events from the server.
 * Resolves when the stream ends. Throws on network errors; per-phase errors
 * are surfaced via `onResult` so the UI can render a summary.
 */
export async function runStorageMigration(
  input: StorageMigrationInput,
  callbacks: StorageMigrationCallbacks = {}
): Promise<void> {
  const response = await fetch(`${resolveClientServerBaseUrl()}/api/storage/migrate`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    signal: callbacks.signal,
    headers: Object.fromEntries(
      attachSessionToken({ "Content-Type": "application/json" }).entries()
    ),
    body: JSON.stringify(input),
  });
  syncAuthTokenFromResponse(response);
  if (response.status === 401) {
    clearStoredAuth();
  }
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Migration failed with status ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line.length > 0) {
          try {
            const parsed = JSON.parse(line) as
              | { type: "start"; from: StorageDriverKind; to: StorageDriverKind; overwrite: boolean }
              | ({ type: "progress" } & StorageMigrationProgress)
              | { type: "result"; result: StorageMigrationResult }
              | { type: "error"; message: string };
            switch (parsed.type) {
              case "start":
                callbacks.onStart?.({
                  from: parsed.from,
                  to: parsed.to,
                  overwrite: parsed.overwrite,
                });
                break;
              case "progress":
                callbacks.onProgress?.(parsed);
                break;
              case "result":
                callbacks.onResult?.(parsed.result);
                break;
              case "error":
                callbacks.onError?.(parsed.message);
                break;
              default: {
                const exhaustive: never = parsed;
                throw new Error(`Unknown migration event: ${JSON.stringify(exhaustive)}`);
              }
            }
          } catch (error) {
            callbacks.onError?.((error as Error).message);
          }
        }
        newlineIdx = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function buildStorageExportUrl(driver?: StorageDriverKind): string {
  const base = resolveClientServerBaseUrl();
  const params = new URLSearchParams();
  if (driver) params.set("driver", driver);
  const query = params.toString();
  const url = `${base}/api/storage/export${query ? `?${query}` : ""}`;
  return buildAuthenticatedUrl(url);
}

export type StorageImportResponse = {
  ok: boolean;
  applied: number;
  errors: Array<{ line: number; message: string }>;
  targetDriver: StorageDriverKind;
  overwrite: boolean;
};

export async function importStorageArchive(
  archiveText: string,
  options: { driver?: StorageDriverKind; overwrite?: boolean } = {}
): Promise<StorageImportResponse> {
  const params = new URLSearchParams();
  if (options.driver) params.set("driver", options.driver);
  if (options.overwrite) params.set("overwrite", "1");
  const query = params.toString();
  const response = await fetch(
    `${resolveClientServerBaseUrl()}/api/storage/import${query ? `?${query}` : ""}`,
    {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: Object.fromEntries(
        attachSessionToken({ "Content-Type": "application/x-ndjson" }).entries()
      ),
      body: archiveText,
    }
  );
  syncAuthTokenFromResponse(response);
  if (response.status === 401) {
    clearStoredAuth();
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Import failed with status ${response.status}`);
  }
  return (await response.json()) as StorageImportResponse;
}

export type BrowserDebugSessionCreateInput = {
  targetUrl: string;
  /** Navigate via the workspace HTML proxy (closer to in-IDE iframe). */
  useIframeProxy?: boolean;
};

export type BrowserDebugSessionCreateResult = {
  sessionId: string;
  workspaceId: string;
  targetId: string;
  /**
   * Absolute-path URL (starts with `/`) to load in the DevTools iframe. Points at
   * Chromium's real DevTools frontend proxied through the workspace server, with
   * the `?ws=` query param already rewritten to our WebSocket bridge path.
   */
  devtoolsPath: string;
  /** Current URL of the inspected Chromium page (for IDE URL bar sync). */
  currentUrl?: string | null;
};

export type BrowserDebugNavigateInput =
  | { op: "goto"; url: string }
  | { op: "reload" | "back" | "forward"; url?: undefined };

export type BrowserDebugViewportResult = {
  imageDataUrl: string | null;
  currentUrl?: string | null;
};

export type BrowserDebugInputEvent =
  | { type: "mouse"; action: "move" | "down" | "up" | "click"; x: number; y: number; button?: "left" | "middle" | "right" }
  | { type: "wheel"; deltaX?: number; deltaY?: number }
  | { type: "key"; action: "down" | "up" | "press" | "type"; key: string };

export type BrowserDebugEvent =
  | {
      seq: number;
      ts: number;
      type: "console";
      level: "log" | "info" | "warning" | "error" | "debug";
      source: "console" | "exception" | "log";
      text: string;
      url?: string;
      lineNumber?: number;
      columnNumber?: number;
    }
  | {
      seq: number;
      ts: number;
      type: "network";
      url: string;
      method?: string;
      status?: number;
      statusText?: string;
      resourceType?: string;
    };

export type BrowserRenderedElementScreenshotInput = {
  pageUrl: string;
  pathIndices: number[];
  rect?: { left: number; top: number; width: number; height: number } | null;
  viewport?: { width: number; height: number } | null;
  scroll?: { x: number; y: number } | null;
};

export type BrowserControlGroup = "left" | "right";
export type BrowserControlViewportPreset =
  | "watch"
  | "mobile"
  | "tablet"
  | "laptop"
  | "desktop"
  | "custom";
export type BrowserControlViewport = {
  preset: BrowserControlViewportPreset;
  width: number;
  height: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  touch?: boolean;
};
export type BrowserControlTab = {
  tabId: string;
  workspaceId: string;
  group: BrowserControlGroup;
  title: string;
  targetUrl: string;
  currentUrl?: string | null;
  engine: "proxy" | "electron-native" | "server-chromium";
  debugSessionId?: string | null;
  nativeSessionId?: string | null;
  active: boolean;
  focused: boolean;
  capabilities: Record<string, boolean>;
  viewport: BrowserControlViewport;
  lockState: {
    locked: boolean;
    lockVersion: number;
    lockedByConversationId?: string | null;
    lockReason?: string | null;
    lockedAt?: number | null;
    userUnlockedAt?: number | null;
    userAlteredAt?: number | null;
  };
  createdAt: number;
  updatedAt: number;
};
export type BrowserControlInput =
  | {
      type: "mouse";
      action: "move" | "down" | "up" | "click";
      x: number;
      y: number;
      button?: "left" | "middle" | "right";
      visualLabel?: string;
    }
  | { type: "wheel"; deltaX?: number; deltaY?: number }
  | { type: "key"; action: "down" | "up" | "press" | "type"; key: string };
export type BrowserControlCommandPayload =
  | {
      type: "input";
      input: BrowserControlInput;
    }
  | {
      type: "snapshot";
    }
  | {
      type: "evaluate";
      script: string;
    }
  | {
      type: "screenshot";
    };
export type BrowserControlCommand = {
  seq: number;
  ts: number;
  tabId: string;
} & BrowserControlCommandPayload;
export type BrowserControlCommandResult = {
  seq: number;
  tabId: string;
  ok: boolean;
  ts: number;
  result?: unknown;
  error?: string;
};
export type BrowserControlSnapshot = {
  tab: BrowserControlTab;
  title?: string | null;
  url?: string | null;
  visibleText: string;
  html?: string;
  accessibilityText?: string;
  elementRefs: Array<{
    ref: string;
    tag: string;
    text?: string;
    role?: string;
    selector?: string;
    rect?: { x: number; y: number; width: number; height: number };
  }>;
  truncated?: boolean;
};

export async function createBrowserDebugSession(
  input: BrowserDebugSessionCreateInput
): Promise<BrowserDebugSessionCreateResult> {
  return request(`/api/browser-debug/sessions`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listBrowserControlTabs(): Promise<{ tabs: BrowserControlTab[] }> {
  return request("/api/browser-control/tabs", undefined, { skipWorkspaceHeader: false });
}

export async function openBrowserControlTab(input: {
  url: string;
  title?: string;
  group?: BrowserControlGroup;
  engine?: "proxy" | "electron-native" | "server-chromium";
  active?: boolean;
  viewport?: Partial<BrowserControlViewport>;
}): Promise<{ tab: BrowserControlTab }> {
  return request("/api/browser-control/tabs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function closeBrowserControlTab(tabId: string): Promise<void> {
  await request(`/api/browser-control/tabs/${encodeURIComponent(tabId)}`, {
    method: "DELETE",
  });
}

export async function focusBrowserControlTab(tabId: string): Promise<{ tab: BrowserControlTab }> {
  return request(`/api/browser-control/tabs/${encodeURIComponent(tabId)}/focus`, {
    method: "POST",
  });
}

export async function moveBrowserControlTab(
  tabId: string,
  group: BrowserControlGroup
): Promise<{ tab: BrowserControlTab }> {
  return request(`/api/browser-control/tabs/${encodeURIComponent(tabId)}/move`, {
    method: "POST",
    body: JSON.stringify({ group }),
  });
}

export async function navigateBrowserControlTab(
  tabId: string,
  input: BrowserDebugNavigateInput
): Promise<{ tab: BrowserControlTab }> {
  return request(`/api/browser-control/tabs/${encodeURIComponent(tabId)}/navigate`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function setBrowserControlLock(
  tabId: string,
  input: {
    locked?: boolean;
    conversationId?: string | null;
    reason?: string | null;
    userInitiated?: boolean;
  }
): Promise<{ tab: BrowserControlTab }> {
  return request(`/api/browser-control/tabs/${encodeURIComponent(tabId)}/lock`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function markBrowserControlUserIntervention(
  tabId: string,
  detail?: string
): Promise<{ tab: BrowserControlTab }> {
  return request(`/api/browser-control/tabs/${encodeURIComponent(tabId)}/user-intervention`, {
    method: "POST",
    body: JSON.stringify({ detail }),
  });
}

export async function setBrowserControlViewport(
  tabId: string,
  viewport: Partial<BrowserControlViewport>
): Promise<{ tab: BrowserControlTab }> {
  return request(`/api/browser-control/tabs/${encodeURIComponent(tabId)}/viewport`, {
    method: "POST",
    body: JSON.stringify(viewport),
  });
}

export async function sendBrowserControlInput(
  tabId: string,
  input: BrowserDebugInputEvent
): Promise<{ ok: boolean }> {
  return request(`/api/browser-control/tabs/${encodeURIComponent(tabId)}/input`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function evaluateBrowserControlTab(
  tabId: string,
  script: string
): Promise<{ result: unknown; exception?: string }> {
  return request(`/api/browser-control/tabs/${encodeURIComponent(tabId)}/evaluate`, {
    method: "POST",
    body: JSON.stringify({ script }),
  });
}

export async function snapshotBrowserControlTab(
  tabId: string
): Promise<{ snapshot: BrowserControlSnapshot }> {
  return request(`/api/browser-control/tabs/${encodeURIComponent(tabId)}/snapshot`);
}

export async function screenshotBrowserControlTab(
  tabId: string
): Promise<{ imageDataUrl: string | null; tab: BrowserControlTab }> {
  return request(`/api/browser-control/tabs/${encodeURIComponent(tabId)}/screenshot`);
}

export async function readBrowserControlCommands(
  tabId: string,
  after = 0
): Promise<{ commands: BrowserControlCommand[]; cursor: number }> {
  const suffix = after > 0 ? `?after=${encodeURIComponent(String(after))}` : "";
  return request(`/api/browser-control/tabs/${encodeURIComponent(tabId)}/commands${suffix}`);
}

export async function completeBrowserControlCommand(
  tabId: string,
  seq: number,
  input: { ok: boolean; result?: unknown; error?: string }
): Promise<{ result: BrowserControlCommandResult }> {
  return request(
    `/api/browser-control/tabs/${encodeURIComponent(tabId)}/commands/${encodeURIComponent(String(seq))}/result`,
    {
      method: "POST",
      body: JSON.stringify(input),
    }
  );
}

export async function deleteBrowserDebugSession(sessionId: string): Promise<void> {
  const response = await fetch(
    `${resolveClientServerBaseUrl()}/api/browser-debug/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "DELETE",
      headers: Object.fromEntries(
        attachSessionToken({
          "Content-Type": "application/json",
          ...getWorkspaceHeaders(),
        }).entries()
      ),
      credentials: "include",
      cache: "no-store",
    }
  );
  syncAuthTokenFromResponse(response);
  if (response.status === 401) {
    clearStoredAuth();
  }
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with status ${response.status}`);
  }
}

/**
 * Ping the server to verify a debug session is still alive (Chromium process
 * still running, not wiped by a server restart). Returns `null` if the session
 * is gone (HTTP 404) so callers can reset their cached state.
 */
export async function getBrowserDebugSession(
  sessionId: string
): Promise<BrowserDebugSessionCreateResult | null> {
  const response = await fetch(
    `${resolveClientServerBaseUrl()}/api/browser-debug/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "GET",
      headers: Object.fromEntries(
        attachSessionToken({
          "Content-Type": "application/json",
          ...getWorkspaceHeaders(),
        }).entries()
      ),
      credentials: "include",
      cache: "no-store",
    }
  );
  syncAuthTokenFromResponse(response);
  if (response.status === 401) {
    clearStoredAuth();
    return null;
  }
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  return (await response.json()) as BrowserDebugSessionCreateResult;
}

/**
 * Drive the headless Chromium attached to a debug session (Playwright `Page`)
 * from the IDE URL bar / nav buttons. Returns the page URL *after* the
 * navigation so the caller can sync the UI.
 */
export async function navigateBrowserDebugSession(
  sessionId: string,
  input: BrowserDebugNavigateInput
): Promise<{ url: string | null } | null> {
  const response = await fetch(
    `${resolveClientServerBaseUrl()}/api/browser-debug/sessions/${encodeURIComponent(sessionId)}/navigate`,
    {
      method: "POST",
      headers: Object.fromEntries(
        attachSessionToken({
          "Content-Type": "application/json",
          ...getWorkspaceHeaders(),
        }).entries()
      ),
      credentials: "include",
      cache: "no-store",
      body: JSON.stringify(input),
    }
  );
  syncAuthTokenFromResponse(response);
  if (response.status === 401) {
    clearStoredAuth();
    return null;
  }
  if (!response.ok) {
    return null;
  }
  return (await response.json()) as { url: string | null };
}

export async function captureBrowserDebugViewport(
  sessionId: string,
  viewport: { width: number; height: number }
): Promise<BrowserDebugViewportResult | null> {
  const params = new URLSearchParams({
    width: String(Math.max(1, Math.floor(viewport.width))),
    height: String(Math.max(1, Math.floor(viewport.height))),
  });
  const response = await fetch(
    `${resolveClientServerBaseUrl()}/api/browser-debug/sessions/${encodeURIComponent(sessionId)}/viewport?${params.toString()}`,
    {
      method: "GET",
      headers: Object.fromEntries(
        attachSessionToken({
          "Content-Type": "application/json",
          ...getWorkspaceHeaders(),
        }).entries()
      ),
      credentials: "include",
      cache: "no-store",
    }
  );
  syncAuthTokenFromResponse(response);
  if (response.status === 401) {
    clearStoredAuth();
    return null;
  }
  if (!response.ok) return null;
  return (await response.json()) as BrowserDebugViewportResult;
}

export async function sendBrowserDebugInput(
  sessionId: string,
  input: BrowserDebugInputEvent
): Promise<boolean> {
  const response = await fetch(
    `${resolveClientServerBaseUrl()}/api/browser-debug/sessions/${encodeURIComponent(sessionId)}/input`,
    {
      method: "POST",
      headers: Object.fromEntries(
        attachSessionToken({
          "Content-Type": "application/json",
          ...getWorkspaceHeaders(),
        }).entries()
      ),
      credentials: "include",
      cache: "no-store",
      body: JSON.stringify(input),
    }
  );
  syncAuthTokenFromResponse(response);
  if (response.status === 401) {
    clearStoredAuth();
    return false;
  }
  if (!response.ok) return false;
  const payload = (await response.json()) as { ok?: boolean };
  return Boolean(payload.ok);
}

export async function getBrowserDebugEvents(
  sessionId: string,
  after = 0
): Promise<{ events: BrowserDebugEvent[]; cursor: number } | null> {
  const params = new URLSearchParams({ after: String(Math.max(0, Math.floor(after))) });
  const response = await fetch(
    `${resolveClientServerBaseUrl()}/api/browser-debug/sessions/${encodeURIComponent(sessionId)}/events?${params.toString()}`,
    {
      method: "GET",
      headers: Object.fromEntries(
        attachSessionToken({
          "Content-Type": "application/json",
          ...getWorkspaceHeaders(),
        }).entries()
      ),
      credentials: "include",
      cache: "no-store",
    }
  );
  syncAuthTokenFromResponse(response);
  if (response.status === 401) {
    clearStoredAuth();
    return null;
  }
  if (!response.ok) return null;
  return (await response.json()) as { events: BrowserDebugEvent[]; cursor: number };
}

/**
 * Fallback screenshot for design-mode clicks when the browser-side
 * SVG/foreignObject capture fails. Returns a data URL (or null) for the
 * rendered element as seen in the proxied page.
 */
export async function captureRenderedBrowserElementScreenshot(
  input: BrowserRenderedElementScreenshotInput
): Promise<string | null> {
  const response = await fetch(
    `${resolveClientServerBaseUrl()}/api/browser-debug/rendered-element-screenshot`,
    {
      method: "POST",
      headers: Object.fromEntries(
        attachSessionToken({
          "Content-Type": "application/json",
          ...getWorkspaceHeaders(),
        }).entries()
      ),
      credentials: "include",
      cache: "no-store",
      body: JSON.stringify(input),
    }
  );
  syncAuthTokenFromResponse(response);
  if (response.status === 401) {
    clearStoredAuth();
    return null;
  }
  if (!response.ok) {
    return null;
  }
  const payload = (await response.json()) as { imageDataUrl?: string | null };
  return payload.imageDataUrl ?? null;
}

async function mcpJsonRequest<T>(
  path: string,
  init?: RequestInit & { workspaceId?: string | null }
): Promise<T> {
  const response = await fetch(`${resolveClientServerBaseUrl()}${path}`, {
    ...init,
    headers: Object.fromEntries(
      attachSessionToken({
        ...(init?.headers ?? {}),
        ...getWorkspaceHeaders(false, init?.workspaceId),
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      }).entries()
    ),
    credentials: "include",
    cache: "no-store",
  });
  syncAuthTokenFromResponse(response);
  if (response.status === 401) {
    clearStoredAuth();
    throw new Error("Unauthorized");
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export async function fetchMcpPresets(): Promise<McpPresetDefinition[]> {
  const result = await mcpJsonRequest<{ presets: McpPresetDefinition[] }>("/api/mcp/presets");
  return result.presets;
}

export async function fetchMcpServers(workspaceId: string): Promise<McpServerPublic[]> {
  const result = await mcpJsonRequest<{ servers: McpServerPublic[] }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/servers`,
    { workspaceId }
  );
  return result.servers;
}

export async function upsertMcpServer(
  workspaceId: string,
  input: {
    presetId?: string;
    server?: Partial<McpServerConfig> & { label: string };
    secretValues?: Record<string, string>;
  }
): Promise<McpServerPublic> {
  const result = await mcpJsonRequest<{ server: McpServerPublic }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/servers`,
    {
      method: "PUT",
      workspaceId,
      body: JSON.stringify(input),
    }
  );
  return result.server;
}

export async function deleteMcpServer(
  workspaceId: string,
  serverId: string
): Promise<void> {
  await mcpJsonRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/servers/${encodeURIComponent(serverId)}`, {
    method: "DELETE",
    workspaceId,
  });
}

export async function setBuiltInMcpServerEnabled(
  workspaceId: string,
  serverId: string,
  enabled: boolean
): Promise<void> {
  await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/builtins/${encodeURIComponent(serverId)}`,
    {
      method: "PATCH",
      workspaceId,
      body: JSON.stringify({ enabled }),
    }
  );
}

export async function testMcpServerConnection(
  workspaceId: string,
  serverId: string
): Promise<McpConnectionStatus> {
  const result = await mcpJsonRequest<{ status: McpConnectionStatus }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/servers/${encodeURIComponent(serverId)}/test`,
    { method: "POST", workspaceId }
  );
  return result.status;
}

export async function refreshMcpServerMirror(
  workspaceId: string,
  serverId: string
): Promise<void> {
  await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/servers/${encodeURIComponent(serverId)}/refresh`,
    { method: "POST", workspaceId }
  );
}

export async function startMcpOAuth(
  workspaceId: string,
  serverId: string
): Promise<{ authorizationUrl: string; state: string }> {
  return await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/oauth/${encodeURIComponent(serverId)}/start`,
    { workspaceId }
  );
}

export async function fetchAgentPlugins(workspaceId: string): Promise<AgentPluginPublic[]> {
  const result = await mcpJsonRequest<{ plugins: AgentPluginPublic[] }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/plugins`,
    { workspaceId }
  );
  return result.plugins;
}

export async function discoverAgentPlugins(query = ""): Promise<AgentPluginDiscoveryResult> {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return await mcpJsonRequest<AgentPluginDiscoveryResult>(`/api/plugins/discover${suffix}`);
}

export async function fetchAgentPluginHarnessCapabilities(): Promise<
  AgentPluginHarnessCapability[]
> {
  const result = await mcpJsonRequest<{ harnesses: AgentPluginHarnessCapability[] }>(
    "/api/plugins/harness-capabilities"
  );
  return result.harnesses;
}

export async function verifyAgentPlugins(
  workspaceId: string
): Promise<AgentPluginVerificationReport> {
  const result = await mcpJsonRequest<{ report: AgentPluginVerificationReport }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/plugins/verify`,
    { workspaceId }
  );
  return result.report;
}

export async function installAgentPlugin(
  workspaceId: string,
  pluginId: string
): Promise<AgentPluginPublic[]> {
  const result = await mcpJsonRequest<{
    install: AgentPluginInstallRecord;
    plugins: AgentPluginPublic[];
  }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/plugins/${encodeURIComponent(pluginId)}/install`,
    { method: "POST", workspaceId }
  );
  return result.plugins;
}

export async function createCustomAgentPlugin(
  workspaceId: string,
  definition: AgentPluginDefinition
): Promise<AgentPluginPublic[]> {
  const result = await mcpJsonRequest<{
    install: AgentPluginInstallRecord;
    plugins: AgentPluginPublic[];
  }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/plugins/custom`,
    {
      method: "POST",
      workspaceId,
      body: JSON.stringify({ definition }),
    }
  );
  return result.plugins;
}

export async function setAgentPluginEnabled(
  workspaceId: string,
  pluginId: string,
  enabled: boolean
): Promise<AgentPluginPublic[]> {
  const result = await mcpJsonRequest<{
    install: AgentPluginInstallRecord;
    plugins: AgentPluginPublic[];
  }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/plugins/${encodeURIComponent(pluginId)}`,
    {
      method: "PATCH",
      workspaceId,
      body: JSON.stringify({ enabled }),
    }
  );
  return result.plugins;
}

export async function setAgentPluginHarnessOverride(
  workspaceId: string,
  pluginId: string,
  backendId: AgentBackendId,
  enabled: boolean
): Promise<AgentPluginPublic[]> {
  const result = await mcpJsonRequest<{
    install: AgentPluginInstallRecord;
    plugins: AgentPluginPublic[];
  }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/plugins/${encodeURIComponent(pluginId)}/harnesses/${encodeURIComponent(backendId)}`,
    {
      method: "PATCH",
      workspaceId,
      body: JSON.stringify({ enabled }),
    }
  );
  return result.plugins;
}

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

export type ExtensionWebviewThemeSnapshot = {
  colorScheme: "dark" | "light";
  variables: Record<string, string>;
};

export type ExtensionSurfacePlacement = "sidebar" | "editor";

export type ExtensionSurfaceSession = {
  sessionId: string;
  workspaceId: string;
  extensionId: string;
  surfaceId: string;
  title: string;
  kind: "marketplace" | "webview" | "customEditor" | "view" | "output";
  viewType?: string;
  placements: ExtensionSurfacePlacement[];
  createdAt: number;
  updatedAt: number;
  lastAttachedAt?: number;
  attachedClientCount: number;
  html: string;
  htmlVersion: number;
  messageCursor: number;
  messages: Array<{ seq: number; ts: number; message: unknown }>;
  externalUrls: string[];
  vscodeState?: unknown;
  theme?: ExtensionWebviewThemeSnapshot;
  activationMs?: number;
  resolveMs?: number;
  htmlBytes?: number;
  lastError?: string;
  missingProvider?: boolean;
  message?: string;
  host: ExtensionHostStatus;
};

export type ExtensionSurfaceSnapshot = {
  session: ExtensionSurfaceSession;
  html: string;
  htmlVersion: number;
  messages: Array<{ seq: number; ts: number; message: unknown }>;
  externalUrls: string[];
  vscodeState?: unknown;
  theme?: ExtensionWebviewThemeSnapshot;
  host: ExtensionHostStatus;
  missingProvider?: boolean;
  message?: string;
};

export type ExtensionSurfaceEvent = {
  seq: number;
  ts: number;
  type: "html" | "message" | "external-url" | "state" | "theme" | "status";
  sessionId: string;
  payload?: unknown;
};

export type ExtensionIconDescriptor =
  | { kind: "resource"; path: string; render: "mask" | "image"; theme?: "dark" | "light" }
  | { kind: "codicon"; name: string }
  | { kind: "fallback"; label: string };

export type ExtensionActivitySurfaceCapability = {
  kind: "activity.webviewView" | "activity.treeView";
  containerId: string;
  surfaceId: string;
  title: string;
  icon: ExtensionIconDescriptor;
  visibility: "always" | "conditional";
  when?: string;
};

export type ExtensionManifestCapabilities = {
  status: "supported" | "degraded" | "staticOnly" | "hidden" | "blocked";
  reasons: string[];
  activitySurfaces: ExtensionActivitySurfaceCapability[];
  staticContributions: Array<{
    kind: "static.theme" | "static.iconTheme" | "static.productIconTheme";
    id: string;
    label: string;
    path?: string;
  }>;
  commandContributions: Array<{
    kind: "commandOnly" | "editor.contextMenu";
    command: string;
    title: string;
    category?: string;
    when?: string;
  }>;
  languageContributions: Array<{
    kind: "language.formatter" | "language.diagnostics";
    languageId: string;
  }>;
  unsupportedContributions: Array<{
    kind: "unsupported.debug" | "unsupported.scm" | "unsupported.notebook" | "unsupported.testing";
    reason: string;
  }>;
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
  compatibility: "high" | "partial" | "unsupported" | "dangerous";
  compatibilityWarnings: string[];
  source:
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
  vsixSha256: string;
  vsixSizeBytes: number;
  installPath: string;
  manifest: {
    name: string;
    publisher: string;
    displayName: string;
    description: string;
    version: string;
    engines: { vscode?: string };
    main?: string;
    browser?: string;
    activationEvents: string[];
    categories: string[];
    contributes: Record<string, number>;
    capabilities?: ExtensionManifestCapabilities;
    raw: Record<string, unknown>;
  };
  settings: Record<string, unknown>;
  permissions: Array<{
    id: string;
    workspaceId: string;
    extensionId: string;
    permission: string;
    granted: boolean;
    reason?: string;
    createdAt: number;
    updatedAt: number;
  }>;
  runtime: {
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

export async function searchExtensionMarketplace(input: {
  query: string;
  size?: number;
  category?: string;
}): Promise<{
  offset: number;
  totalSize: number;
  extensions: ExtensionMarketplaceSearchResult[];
}> {
  const params = new URLSearchParams();
  params.set("query", input.query || "*");
  if (input.size) params.set("size", String(input.size));
  if (input.category) params.set("category", input.category);
  return await request(`/api/extensions/marketplace/search?${params.toString()}`);
}

export async function fetchInstalledExtensions(workspaceId: string): Promise<{
  extensions: ExtensionInstallRecord[];
  host: ExtensionHostStatus;
}> {
  return await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/extensions`,
    { method: "GET", workspaceId }
  );
}

export async function installOpenVsxExtensionClient(input: {
  workspaceId: string;
  namespace: string;
  name: string;
  version?: string;
}): Promise<ExtensionInstallRecord> {
  const result = await mcpJsonRequest<{ extension: ExtensionInstallRecord }>(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/extensions/install`,
    {
      method: "POST",
      workspaceId: input.workspaceId,
      body: JSON.stringify({
        source: "open-vsx",
        namespace: input.namespace,
        name: input.name,
        version: input.version,
      }),
    }
  );
  return result.extension;
}

export async function setExtensionEnabled(
  workspaceId: string,
  extensionId: string,
  enabled: boolean
): Promise<{ extension: ExtensionInstallRecord; host: ExtensionHostStatus }> {
  return await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/extensions/${encodeURIComponent(extensionId)}`,
    {
      method: "PATCH",
      workspaceId,
      body: JSON.stringify({ enabled }),
    }
  );
}

export async function deleteInstalledExtensionClient(
  workspaceId: string,
  extensionId: string
): Promise<{ ok: true; host: ExtensionHostStatus }> {
  return await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/extensions/${encodeURIComponent(extensionId)}`,
    {
      method: "DELETE",
      workspaceId,
    }
  );
}

export async function grantExtensionPermission(input: {
  workspaceId: string;
  extensionId: string;
  permission: string;
  granted: boolean;
  reason?: string;
}): Promise<{ extension: ExtensionInstallRecord | null }> {
  return await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/extensions/${encodeURIComponent(input.extensionId)}/permissions/${encodeURIComponent(input.permission)}`,
    {
      method: "POST",
      workspaceId: input.workspaceId,
      body: JSON.stringify({ granted: input.granted, reason: input.reason }),
    }
  );
}

export async function activateInstalledExtension(
  workspaceId: string,
  extensionId: string
): Promise<{ extension: ExtensionInstallRecord; host: ExtensionHostStatus; result: unknown }> {
  return await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/extensions/${encodeURIComponent(extensionId)}/activate`,
    { method: "POST", workspaceId }
  );
}

export async function executeInstalledExtensionCommand(input: {
  workspaceId: string;
  command: string;
  args?: unknown[];
  editorContext?: unknown;
}): Promise<{ result: unknown; externalUrls?: string[]; host: ExtensionHostStatus }> {
  return await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/extensions/commands/execute`,
    {
      method: "POST",
      workspaceId: input.workspaceId,
      body: JSON.stringify({
        command: input.command,
        args: input.args ?? [],
        editorContext: input.editorContext,
      }),
    }
  );
}

export async function resolveInstalledExtensionSurface(input: {
  workspaceId: string;
  extensionId: string;
  surfaceId: string;
  title?: string;
  kind?: ExtensionSurfaceSession["kind"];
  viewType?: string;
  placement?: ExtensionSurfacePlacement;
  sessionId?: string;
  theme?: ExtensionWebviewThemeSnapshot;
  includeMessages?: boolean;
}): Promise<ExtensionSurfaceSnapshot> {
  return await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/extensions/${encodeURIComponent(input.extensionId)}/surfaces/${encodeURIComponent(input.surfaceId)}/resolve`,
    {
      method: "POST",
      workspaceId: input.workspaceId,
      body: JSON.stringify({
        title: input.title,
        kind: input.kind,
        viewType: input.viewType,
        placement: input.placement,
        sessionId: input.sessionId,
        theme: input.theme,
        includeMessages: input.includeMessages,
      }),
    }
  );
}

export async function deliverInstalledExtensionSurfaceMessage(input: {
  workspaceId: string;
  extensionId: string;
  surfaceId: string;
  sessionId?: string;
  message: unknown;
}): Promise<ExtensionSurfaceSnapshot & { missingWebview: boolean }> {
  return await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/extensions/${encodeURIComponent(input.extensionId)}/surfaces/${encodeURIComponent(input.surfaceId)}/message`,
    {
      method: "POST",
      workspaceId: input.workspaceId,
      body: JSON.stringify({ message: input.message, sessionId: input.sessionId }),
    }
  );
}

export async function listExtensionSurfaceSessions(
  workspaceId: string
): Promise<{ sessions: ExtensionSurfaceSession[]; host: ExtensionHostStatus }> {
  return await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/extensions/surfaces`,
    { workspaceId }
  );
}

export async function createExtensionSurfaceSession(input: {
  workspaceId: string;
  extensionId: string;
  surfaceId: string;
  title?: string;
  kind?: ExtensionSurfaceSession["kind"];
  viewType?: string;
  placement?: ExtensionSurfacePlacement;
  sessionId?: string;
  theme?: ExtensionWebviewThemeSnapshot;
  includeMessages?: boolean;
}): Promise<ExtensionSurfaceSnapshot> {
  return await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/extensions/${encodeURIComponent(input.extensionId)}/surfaces/${encodeURIComponent(input.surfaceId)}/sessions`,
    {
      method: "POST",
      workspaceId: input.workspaceId,
      body: JSON.stringify({
        title: input.title,
        kind: input.kind,
        viewType: input.viewType,
        placement: input.placement,
        sessionId: input.sessionId,
        theme: input.theme,
        includeMessages: input.includeMessages,
      }),
    }
  );
}

export async function fetchExtensionSurfaceSnapshot(input: {
  workspaceId: string;
  sessionId: string;
}): Promise<ExtensionSurfaceSnapshot> {
  return await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/extensions/surface-sessions/${encodeURIComponent(input.sessionId)}/snapshot`,
    { workspaceId: input.workspaceId }
  );
}

export async function attachExtensionSurfaceSessionClient(input: {
  workspaceId: string;
  sessionId: string;
  clientId?: string;
  theme?: ExtensionWebviewThemeSnapshot;
}): Promise<ExtensionSurfaceSnapshot> {
  return await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/extensions/surface-sessions/${encodeURIComponent(input.sessionId)}/attach`,
    {
      method: "POST",
      workspaceId: input.workspaceId,
      body: JSON.stringify({ clientId: input.clientId, theme: input.theme }),
    }
  );
}

export async function detachExtensionSurfaceSessionClient(input: {
  workspaceId: string;
  sessionId: string;
  clientId?: string;
}): Promise<{ session: ExtensionSurfaceSession | null }> {
  return await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/extensions/surface-sessions/${encodeURIComponent(input.sessionId)}/detach`,
    {
      method: "POST",
      workspaceId: input.workspaceId,
      body: JSON.stringify({ clientId: input.clientId }),
    }
  );
}

export async function closeExtensionSurfaceSessionClient(input: {
  workspaceId: string;
  sessionId: string;
}): Promise<{ ok: boolean; host: ExtensionHostStatus }> {
  return await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/extensions/surface-sessions/${encodeURIComponent(input.sessionId)}`,
    { method: "DELETE", workspaceId: input.workspaceId }
  );
}

export async function deliverExtensionSurfaceSessionMessageClient(input: {
  workspaceId: string;
  sessionId: string;
  message: unknown;
}): Promise<ExtensionSurfaceSnapshot & { missingWebview: boolean }> {
  return await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/extensions/surface-sessions/${encodeURIComponent(input.sessionId)}/message`,
    {
      method: "POST",
      workspaceId: input.workspaceId,
      body: JSON.stringify({ message: input.message }),
    }
  );
}

export async function updateExtensionSurfaceStateClient(input: {
  workspaceId: string;
  sessionId: string;
  state: unknown;
}): Promise<ExtensionSurfaceSnapshot> {
  return await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/extensions/surface-sessions/${encodeURIComponent(input.sessionId)}/state`,
    {
      method: "POST",
      workspaceId: input.workspaceId,
      body: JSON.stringify({ state: input.state }),
    }
  );
}

export async function updateExtensionSurfaceThemeClient(input: {
  workspaceId: string;
  sessionId: string;
  theme: ExtensionWebviewThemeSnapshot;
}): Promise<ExtensionSurfaceSnapshot> {
  return await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/extensions/surface-sessions/${encodeURIComponent(input.sessionId)}/theme`,
    {
      method: "POST",
      workspaceId: input.workspaceId,
      body: JSON.stringify({ theme: input.theme }),
    }
  );
}

export async function readExtensionSurfaceEvents(input: {
  workspaceId: string;
  sessionId: string;
  cursor?: number;
}): Promise<{ events: ExtensionSurfaceEvent[]; cursor: number }> {
  const params = new URLSearchParams();
  if (typeof input.cursor === "number") {
    params.set("cursor", String(input.cursor));
  }
  return await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/extensions/surface-sessions/${encodeURIComponent(input.sessionId)}/events${params.size ? `?${params}` : ""}`,
    { workspaceId: input.workspaceId }
  );
}

export async function stopExtensionHostClient(
  workspaceId: string
): Promise<{ host: ExtensionHostStatus }> {
  return await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/extensions/host/stop`,
    { method: "POST", workspaceId }
  );
}

export async function disableAllExtensionsClient(
  workspaceId: string
): Promise<{ extensions: ExtensionInstallRecord[]; host: ExtensionHostStatus }> {
  return await mcpJsonRequest(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/extensions/disable-all`,
    { method: "POST", workspaceId }
  );
}
