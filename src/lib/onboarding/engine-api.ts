"use client";

import { attachSessionToken, syncAuthTokenFromResponse } from "@cesium/client";

/**
 * Minimal engine API client for the setup wizard. Every call targets an
 * explicit base URL (the engine being set up) and rides the existing
 * per-server session-token auth, so the wizard works against password-
 * protected remote engines exactly like the main workbench does.
 */

export type EngineHealth = { ok: boolean };

export type EngineAuthStatus = {
  enabled: boolean;
  authenticated: boolean;
};

export type EngineBackendInfo = {
  id: string;
  label: string;
  description: string;
  available: boolean;
  experimental: boolean;
  commandPreview: string | null;
  defaultModelId: string;
  defaultModelName: string;
  installer: { label: string; summary: string; authHint: string } | null;
};

export type EngineImportSource = {
  backendId: string;
  label: string;
  harnessKey: string | null;
  available: boolean;
  reason?: string;
  storageRoot?: string | null;
  sessionCount: number;
};

export type EngineImportSession = {
  id: string;
  title: string;
  cwd?: string;
  createdAt: number | null;
  updatedAt: number | null;
  messageCount: number;
  preview?: string;
  importedConversationId: string | null;
};

export type EngineWorkspace = {
  id: string;
  name: string;
  root: string;
};

export type EngineConversationSnapshotExport = {
  snapshotKey: string;
  title: string;
  backendId: string;
  modelId: string | null;
  modelName: string | null;
  messageCount: number;
  sourceUpdatedAt: number;
  recordJson: string;
  eventsJson: string;
  truncated: boolean;
};

async function engineFetch(
  baseUrl: string,
  path: string,
  init?: RequestInit & { workspaceId?: string }
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.workspaceId) {
    headers.set("x-opencursor-workspace-id", init.workspaceId);
  }
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: attachSessionToken(headers, baseUrl),
    credentials: "include",
  });
  syncAuthTokenFromResponse(response, baseUrl);
  return response;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body?.error) {
      return body.error;
    }
  } catch {
    // fall through
  }
  return `Request failed (${response.status})`;
}

export async function checkEngineHealth(baseUrl: string): Promise<EngineHealth> {
  const response = await engineFetch(baseUrl, "/health");
  if (!response.ok) {
    throw new Error(`Engine responded with status ${response.status}.`);
  }
  return (await response.json()) as EngineHealth;
}

export async function getEngineAuthStatus(
  baseUrl: string
): Promise<EngineAuthStatus> {
  const response = await engineFetch(baseUrl, "/api/auth/status");
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const body = (await response.json()) as {
    enabled?: boolean;
    authenticated?: boolean;
  };
  return {
    enabled: body.enabled === true,
    authenticated: body.authenticated === true,
  };
}

export async function loginToEngine(
  baseUrl: string,
  username: string,
  password: string
): Promise<{ token: string }> {
  const response = await engineFetch(baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password, remember: true }),
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const body = (await response.json()) as { token?: string };
  if (!body.token) {
    throw new Error("Login succeeded but no session token was returned.");
  }
  return { token: body.token };
}

export async function listEngineBackends(
  baseUrl: string
): Promise<{ backends: EngineBackendInfo[]; platform: string }> {
  const response = await engineFetch(baseUrl, "/api/agents/backends");
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as {
    backends: EngineBackendInfo[];
    platform: string;
  };
}

/** Stream a one-click CLI install; yields log lines, resolves on done. */
export async function installEngineBackendCli(
  baseUrl: string,
  backendId: string,
  onLog: (line: string) => void
): Promise<{ ok: boolean; available: boolean; error?: string; authHint?: string }> {
  const response = await engineFetch(
    baseUrl,
    `/api/agents/backends/${encodeURIComponent(backendId)}/install`,
    { method: "POST" }
  );
  if (!response.ok || !response.body) {
    throw new Error(await readError(response));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: { ok: boolean; available: boolean; error?: string; authHint?: string } = {
    ok: false,
    available: false,
    error: "Install stream ended unexpectedly.",
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = JSON.parse(line) as {
          type: string;
          line?: string;
          ok?: boolean;
          available?: boolean;
          error?: string;
          authHint?: string;
        };
        if (event.type === "log" && event.line) {
          onLog(event.line);
        } else if (event.type === "done") {
          result = {
            ok: event.ok === true,
            available: event.available === true,
            ...(event.error ? { error: event.error } : {}),
            ...(event.authHint ? { authHint: event.authHint } : {}),
          };
        }
      } catch {
        // Ignore malformed stream lines.
      }
    }
  }
  return result;
}

export async function saveCesiumAgentProviderKey(
  baseUrl: string,
  input: {
    providerId: string;
    apiKind:
      | "openai-chat-completions"
      | "openai-responses"
      | "anthropic"
      | "google-genai"
      | "openai-compatible";
    apiKey: string;
    label?: string;
    providerBaseUrl?: string;
  }
): Promise<void> {
  const response = await engineFetch(baseUrl, "/api/settings/cesium-agent/provider-key", {
    method: "PUT",
    body: JSON.stringify({
      providerId: input.providerId,
      apiKind: input.apiKind,
      apiKey: input.apiKey,
      ...(input.label ? { label: input.label } : {}),
      ...(input.providerBaseUrl ? { baseUrl: input.providerBaseUrl } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

export async function listEngineImportSources(
  baseUrl: string
): Promise<EngineImportSource[]> {
  const response = await engineFetch(baseUrl, "/api/agents/imports/sources");
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const body = (await response.json()) as { sources: EngineImportSource[] };
  return body.sources;
}

export async function listEngineImportSessions(
  baseUrl: string,
  backendId: string,
  workspaceId: string
): Promise<EngineImportSession[]> {
  const response = await engineFetch(
    baseUrl,
    `/api/agents/imports/${encodeURIComponent(backendId)}/sessions`,
    { workspaceId }
  );
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const body = (await response.json()) as { sessions: EngineImportSession[] };
  return body.sessions;
}

export async function importEngineHarnessSession(
  baseUrl: string,
  backendId: string,
  workspaceId: string,
  sessionId: string
): Promise<{ conversationId: string; title: string }> {
  const response = await engineFetch(
    baseUrl,
    `/api/agents/imports/${encodeURIComponent(backendId)}/import`,
    {
      method: "POST",
      workspaceId,
      body: JSON.stringify({ sessionId }),
    }
  );
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const body = (await response.json()) as {
    result: { conversationId: string; title: string };
  };
  return body.result;
}

export async function bootstrapEngineWorkspaces(baseUrl: string): Promise<{
  workspaces: EngineWorkspace[];
  defaultWorkspaceId: string | null;
}> {
  const response = await engineFetch(baseUrl, "/api/workspaces/bootstrap");
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const body = (await response.json()) as {
    workspaces: EngineWorkspace[];
    defaultWorkspaceId?: string | null;
  };
  return {
    workspaces: body.workspaces,
    defaultWorkspaceId: body.defaultWorkspaceId ?? null,
  };
}

export async function openEngineWorkspace(
  baseUrl: string,
  root: string
): Promise<EngineWorkspace> {
  const response = await engineFetch(baseUrl, "/api/workspaces/open", {
    method: "POST",
    body: JSON.stringify({ root, trackRecent: true }),
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const body = (await response.json()) as { workspace: EngineWorkspace };
  return body.workspace;
}

/**
 * Starts a first conversation with no workspace at all: the engine spins up an
 * ephemeral standalone-chat sandbox. This is the onboarding fallback when the
 * user does not care to create or open a workspace.
 */
export async function createEngineStandaloneConversationWithPrompt(
  baseUrl: string,
  input: {
    backendId: string;
    modelId?: string;
    modelName?: string;
    text: string;
  }
): Promise<{ conversationId: string; title: string; workspaceId: string }> {
  const response = await engineFetch(
    baseUrl,
    "/api/agents/conversations/standalone/create-and-prompt",
    {
      method: "POST",
      body: JSON.stringify({
        conversation: {
          backendId: input.backendId,
          ...(input.modelId ? { modelId: input.modelId } : {}),
          ...(input.modelName ? { modelName: input.modelName } : {}),
        },
        text: input.text,
      }),
    }
  );
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const body = (await response.json()) as {
    snapshot: { conversation: { id: string; title: string } };
    workspace: { id: string };
  };
  return {
    conversationId: body.snapshot.conversation.id,
    title: body.snapshot.conversation.title,
    workspaceId: body.workspace.id,
  };
}

export async function createEngineConversationWithPrompt(
  baseUrl: string,
  workspaceId: string,
  input: {
    backendId: string;
    modelId?: string;
    modelName?: string;
    text: string;
  }
): Promise<{ conversationId: string; title: string }> {
  const response = await engineFetch(
    baseUrl,
    "/api/agents/conversations/create-and-prompt",
    {
      method: "POST",
      workspaceId,
      body: JSON.stringify({
        conversation: {
          backendId: input.backendId,
          ...(input.modelId ? { modelId: input.modelId } : {}),
          ...(input.modelName ? { modelName: input.modelName } : {}),
        },
        text: input.text,
      }),
    }
  );
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const body = (await response.json()) as {
    snapshot: { conversation: { id: string; title: string } };
  };
  return {
    conversationId: body.snapshot.conversation.id,
    title: body.snapshot.conversation.title,
  };
}

export async function exportEngineConversationSnapshot(
  baseUrl: string,
  workspaceId: string,
  conversationId: string
): Promise<EngineConversationSnapshotExport> {
  const response = await engineFetch(
    baseUrl,
    `/api/agents/conversations/${encodeURIComponent(conversationId)}/snapshot`,
    { workspaceId }
  );
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const body = (await response.json()) as {
    snapshot: EngineConversationSnapshotExport;
  };
  return body.snapshot;
}

export async function materializeEngineCloudSnapshot(
  baseUrl: string,
  workspaceId: string,
  input: {
    snapshotKey: string;
    recordJson: string;
    eventsJson: string;
    sourceServerName?: string | null;
    sourceWorkspaceName?: string | null;
    sourceUpdatedAt?: number | null;
  }
): Promise<{ conversationId: string; created: boolean; title: string }> {
  const response = await engineFetch(baseUrl, "/api/agents/imports/cloud-snapshot", {
    method: "POST",
    workspaceId,
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const body = (await response.json()) as {
    result: { conversationId: string; created: boolean; title: string };
  };
  return body.result;
}
