"use client";

import type { GlobalSettingsState } from "@/lib/global-settings";
import type {
  AgentConversationConfigPatch,
  AgentConversationCreateInput,
  AgentConversationGroupsResult,
  AgentConversationListResult,
  AgentConversationMetadataPatch,
  AgentConversationRecord,
  AgentConversationSnapshot,
  AgentConversationSnapshotHead,
} from "@/lib/agent-types";
import type { WorkspaceSessionState } from "@/lib/workspace-session";
import type {
  FileNode,
  GitWorkspaceStatus,
  GitWorktreeInfo,
  GitWorktreeSetupResult,
  ImageAttachment,
  QueuedPromptConfigOverride,
  TerminalInfo,
  WorkspaceInfo,
  WorkspaceRecord,
  WorkspaceWindowRecord,
} from "@/lib/types";
import { toWebSocketUrl } from "@/lib/ws-client";
import { recordPerfSample } from "@/lib/dev-perf";
import {
  attachSessionToken,
  buildAuthenticatedUrl,
  clearStoredAuth,
  syncAuthTokenFromResponse,
} from "@/lib/auth-client";
import { resolveClientServerBaseUrl } from "@/lib/resolve-server-base-url";

let activeWorkspaceId: string | null = null;

export function setActiveWorkspaceId(workspaceId: string | null): void {
  activeWorkspaceId = workspaceId;
}

function getWorkspaceHeaders(skipWorkspaceHeader?: boolean): HeadersInit {
  if (skipWorkspaceHeader || !activeWorkspaceId) {
    return {};
  }
  return {
    "x-opencursor-workspace-id": activeWorkspaceId,
  };
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
  options?: { skipWorkspaceHeader?: boolean; cache?: RequestCache }
): Promise<T> {
  // Mutating methods (POST/PUT/PATCH/DELETE) must never be cached; GETs rely on
  // the server's `Cache-Control: stale-while-revalidate` headers so repeat page
  // loads hit the browser cache first and revalidate in the background.
  const method = (init?.method ?? "GET").toUpperCase();
  const cacheMode: RequestCache = method === "GET" ? "default" : "no-store";
  const startedAt = performance.now();
  const response = await fetch(`${resolveClientServerBaseUrl()}${input}`, {
    ...init,
    headers: Object.fromEntries(
      attachSessionToken({
        "Content-Type": "application/json",
        ...getWorkspaceHeaders(options?.skipWorkspaceHeader),
        ...(init?.headers ?? {}),
      }).entries()
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

  syncAuthTokenFromResponse(response);

  if (response.status === 401) {
    clearStoredAuth();
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
  options?: { skipWorkspaceHeader?: boolean }
): Promise<T> {
  const response = await fetch(`${resolveClientServerBaseUrl()}${input}`, {
    headers: Object.fromEntries(
      attachSessionToken({
        "Content-Type": "application/json",
        ...getWorkspaceHeaders(options?.skipWorkspaceHeader),
      }).entries()
    ),
    credentials: "include",
    cache: "no-store",
  });

  syncAuthTokenFromResponse(response);

  if (response.status === 401) {
    clearStoredAuth();
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const etag = response.headers.get("etag");
  if (etag) {
    etagRegistry.set(revisionKey, etag);
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
  }
): Promise<{ revision?: number; etag: string | null }> {
  const cachedEtag = etagRegistry.get(revisionKey);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(getWorkspaceHeaders(options?.skipWorkspaceHeader) as Record<
      string,
      string
    >),
  };
  if (cachedEtag) {
    headers["If-Match"] = cachedEtag;
  }
  const response = await fetch(`${resolveClientServerBaseUrl()}${input}`, {
    method: options?.method ?? "PUT",
    body,
    keepalive: options?.keepalive,
    headers: Object.fromEntries(attachSessionToken(headers).entries()),
    credentials: "include",
    cache: "no-store",
  });

  syncAuthTokenFromResponse(response);

  if (response.status === 401) {
    clearStoredAuth();
  }

  if (response.status === 412) {
    // Stale revision — drop the cached tag so the next write succeeds (or a
    // fresh GET primes the registry). Consumers may choose to re-fetch and
    // retry; the default behaviour here is to surface the conflict.
    etagRegistry.delete(revisionKey);
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
    etagRegistry.set(revisionKey, etag);
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
}): Promise<AgentConversationListResult> {
  return request(`/api/agents/conversations${buildPageQuery(params)}`);
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
  ids?: { clientEventId?: string; clientMessageId?: string }
): Promise<AgentConversationSnapshotResponse> {
  return request(`/api/agents/conversations/create-and-prompt`, {
    method: "POST",
    body: JSON.stringify({
      conversation: input,
      text,
      attachments,
      ...ids,
    }),
  });
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
  patch: AgentConversationMetadataPatch
): Promise<{ conversation: AgentConversationRecord }> {
  return request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/metadata`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function promptAgentConversation(
  conversationId: string,
  text: string,
  attachments?: ImageAttachment[],
  configOverride?: QueuedPromptConfigOverride,
  ids?: { clientEventId?: string; clientMessageId?: string }
): Promise<AgentConversationSnapshotResponse> {
  return request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text, attachments, configOverride, ...ids }),
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

export async function answerAgentPermission(
  conversationId: string,
  input: { requestId: string; optionId?: string; cancelled?: boolean }
): Promise<{ conversation: AgentConversationRecord }> {
  return request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/permission`, {
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

export async function fetchGlobalSettings(): Promise<{
  settings: GlobalSettingsState;
  revision?: number;
}> {
  return requestWithEtag(
    `/api/settings/global`,
    GLOBAL_SETTINGS_REVISION_KEY,
    { skipWorkspaceHeader: true }
  );
}

export async function saveGlobalSettings(
  settings: GlobalSettingsState,
  options?: { keepalive?: boolean }
): Promise<void> {
  await mutateWithEtag(
    `/api/settings/global`,
    JSON.stringify({ settings }),
    GLOBAL_SETTINGS_REVISION_KEY,
    {
      method: "PUT",
      keepalive: options?.keepalive,
      skipWorkspaceHeader: true,
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

export async function fetchModelToggleState(): Promise<ModelToggleStateResponse> {
  return request<ModelToggleStateResponse>("/api/settings/models", {
    method: "GET",
  });
}

export async function refreshModelToggleState(): Promise<RefreshModelsResponse> {
  return request<RefreshModelsResponse>("/api/settings/models/refresh", {
    method: "POST",
  });
}

export type ModelToggleUpdate = {
  backendId: string;
  modelId: string;
  on: boolean;
};

export async function saveModelToggles(
  toggles: ModelToggleUpdate[]
): Promise<ModelToggleStateResponse> {
  return request<ModelToggleStateResponse>("/api/settings/models/toggles", {
    method: "PUT",
    body: JSON.stringify({ toggles }),
  });
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

export async function uploadAttachments(
  files: File[]
): Promise<UploadedAttachment[]> {
  const form = new FormData();
  for (const file of files) {
    form.append("files", file);
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

export type BrowserRenderedElementScreenshotInput = {
  pageUrl: string;
  pathIndices: number[];
  rect?: { left: number; top: number; width: number; height: number } | null;
  viewport?: { width: number; height: number } | null;
  scroll?: { x: number; y: number } | null;
};

export async function createBrowserDebugSession(
  input: BrowserDebugSessionCreateInput
): Promise<BrowserDebugSessionCreateResult> {
  return request(`/api/browser-debug/sessions`, {
    method: "POST",
    body: JSON.stringify(input),
  });
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
