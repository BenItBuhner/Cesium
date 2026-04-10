"use client";

import type { GlobalSettingsState } from "@/lib/global-settings";
import type {
  AgentConversationConfigPatch,
  AgentConversationCreateInput,
  AgentConversationGroupsResult,
  AgentConversationListResult,
  AgentConversationRecord,
  AgentConversationSnapshot,
  AgentConversationSnapshotHead,
} from "@/lib/agent-types";
import type { WorkspaceSessionState } from "@/lib/workspace-session";
import type {
  FileNode,
  ImageAttachment,
  TerminalInfo,
  WorkspaceInfo,
  WorkspaceRecord,
  WorkspaceWindowRecord,
} from "@/lib/types";
import { toWebSocketUrl } from "@/lib/ws-client";
import {
  attachSessionToken,
  buildAuthenticatedUrl,
  clearStoredAuth,
  syncAuthTokenFromResponse,
} from "@/lib/auth-client";

const BASE_URL =
  process.env.NEXT_PUBLIC_SERVER_URL?.replace(/\/+$/, "") ??
  "http://localhost:9100";

function resolveClientBaseUrl(): string {
  if (typeof window === "undefined") {
    return BASE_URL;
  }
  try {
    const configured = new URL(BASE_URL);
    const currentHost = window.location.hostname;
    if (
      currentHost &&
      (configured.hostname === "0.0.0.0" ||
        configured.hostname === "[::]" ||
        configured.hostname === "::") &&
      (currentHost === "127.0.0.1" || currentHost === "localhost")
    ) {
      configured.hostname = currentHost;
      configured.port = configured.port || "9100";
      return configured.toString().replace(/\/+$/, "");
    }
  } catch {
    return BASE_URL;
  }
  return BASE_URL;
}

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
  options?: { skipWorkspaceHeader?: boolean }
): Promise<T> {
  const response = await fetch(`${resolveClientBaseUrl()}${input}`, {
    ...init,
    headers: Object.fromEntries(
      attachSessionToken({
        "Content-Type": "application/json",
        ...getWorkspaceHeaders(options?.skipWorkspaceHeader),
        ...(init?.headers ?? {}),
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
    const message = await response.text();
    throw new Error(message || `Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

export function getServerBaseUrl(): string {
  return resolveClientBaseUrl();
}

export function buildAgentWebSocketUrl(workspaceId: string): string {
  const params = new URLSearchParams({ workspaceId });
  const base = `${toWebSocketUrl(resolveClientBaseUrl())}/ws/agent?${params.toString()}`;
  return buildAuthenticatedUrl(base);
}

export async function fetchWorkspaceBootstrap(): Promise<{
  workspaces: WorkspaceRecord[];
  defaultWorkspaceId: string | null;
  startupWorkspaceId: string | null;
  recentWorkspaceIds: string[];
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

export async function fetchWorkspaceSession(
  workspaceId: string,
  options?: { windowId?: string | null }
): Promise<{ workspace: WorkspaceRecord; session: WorkspaceSessionState | null }> {
  const params = new URLSearchParams();
  if (options?.windowId) {
    params.set("windowId", options.windowId);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/session${suffix}`, undefined, {
    skipWorkspaceHeader: true,
  });
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
  await request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/session${suffix}`,
    {
      method: "PUT",
      body: JSON.stringify(session),
      keepalive: options?.keepalive,
    },
    { skipWorkspaceHeader: true }
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

export async function listAgentConversations(): Promise<AgentConversationListResult> {
  return request(`/api/agents/conversations`);
}

export async function listCrossWorkspaceAgentConversations(): Promise<AgentConversationGroupsResult> {
  return request(`/api/agents/conversations/all`, undefined, {
    skipWorkspaceHeader: true,
  });
}

export async function createAgentConversation(
  input: AgentConversationCreateInput
): Promise<{ conversation: AgentConversationRecord }> {
  return request(`/api/agents/conversations`, {
    method: "POST",
    body: JSON.stringify(input),
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
  return request(`/api/agents/conversations/${encodeURIComponent(conversationId)}${suffix}`);
}

export async function fetchOpenCodeSubagentSession(
  sessionId: string
): Promise<{ session: unknown }> {
  return request(`/api/agents/subagents/${encodeURIComponent(sessionId)}`);
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

export async function promptAgentConversation(
  conversationId: string,
  text: string,
  attachments?: ImageAttachment[]
): Promise<AgentConversationSnapshotResponse> {
  return request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text, attachments }),
  });
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
  const response = await fetch(`${resolveClientBaseUrl()}/api/audio/transcriptions`, {
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

export async function fetchGlobalSettings(): Promise<{ settings: GlobalSettingsState }> {
  return request(`/api/settings/global`, undefined, { skipWorkspaceHeader: true });
}

export async function saveGlobalSettings(
  settings: GlobalSettingsState,
  options?: { keepalive?: boolean }
): Promise<void> {
  await request(
    `/api/settings/global`,
    {
      method: "PUT",
      body: JSON.stringify({ settings }),
      keepalive: options?.keepalive,
    },
    { skipWorkspaceHeader: true }
  );
}

export async function fetchTree(depth?: number): Promise<{
  root: string;
  tree: FileNode;
}> {
  const query = depth ? `?depth=${depth}` : "";
  return request(`/api/fs/tree${query}`);
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
  const response = await fetch(`${resolveClientBaseUrl()}/api/fs/upload`, {
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
  const response = await fetch(`${resolveClientBaseUrl()}/api/agents/attachments`, {
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
  const result = await request<{ terminals: TerminalInfo[] }>(`/api/terminals`);
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
