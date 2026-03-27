"use client";

import type { GlobalSettingsState } from "@/lib/global-settings";
import type { WorkspaceSessionState } from "@/lib/workspace-session";
import type { FileNode, TerminalInfo, WorkspaceInfo, WorkspaceRecord } from "@/lib/types";

const BASE_URL =
  process.env.NEXT_PUBLIC_SERVER_URL?.replace(/\/+$/, "") ??
  "http://localhost:9100";

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

async function request<T>(
  input: string,
  init?: RequestInit,
  options?: { skipWorkspaceHeader?: boolean }
): Promise<T> {
  const response = await fetch(`${BASE_URL}${input}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...getWorkspaceHeaders(options?.skipWorkspaceHeader),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

export function getServerBaseUrl(): string {
  return BASE_URL;
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
  workspaceId: string
): Promise<{ workspace: WorkspaceRecord; session: WorkspaceSessionState | null }> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/session`, undefined, {
    skipWorkspaceHeader: true,
  });
}

export async function saveWorkspaceSession(
  workspaceId: string,
  session: WorkspaceSessionState,
  options?: { keepalive?: boolean }
): Promise<void> {
  await request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/session`,
    {
      method: "PUT",
      body: JSON.stringify(session),
      keepalive: options?.keepalive,
    },
    { skipWorkspaceHeader: true }
  );
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

export async function readFile(path: string): Promise<FileReadResult> {
  return request(`/api/fs/read?path=${encodeURIComponent(path)}`);
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
  const response = await fetch(`${BASE_URL}/api/fs/upload`, {
    method: "POST",
    body: form,
    headers: getWorkspaceHeaders(),
    cache: "no-store",
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with status ${response.status}`);
  }
  await response.json();
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
