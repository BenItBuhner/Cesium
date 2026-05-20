import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { McpServerConfig } from "@cesium/core/mcp";
import { getMcpServer, setMcpSecret } from "./server-store.js";
import type { McpOAuthPending } from "./types.js";

const pendingByState = new Map<string, McpOAuthPending>();
const PENDING_TTL_MS = 15 * 60 * 1000;

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function cleanupPending(): void {
  const now = Date.now();
  for (const [state, pending] of pendingByState.entries()) {
    if (now - pending.createdAt > PENDING_TTL_MS) {
      pendingByState.delete(state);
    }
  }
}

export function buildMcpOAuthCallbackUrl(publicOrigin: string): string {
  return `${publicOrigin.replace(/\/$/, "")}/api/mcp/oauth/callback`;
}

export async function startMcpOAuth(input: {
  workspaceId: string;
  serverId: string;
  publicOrigin: string;
}): Promise<{ authorizationUrl: string; state: string }> {
  cleanupPending();
  const config = await getMcpServer(input.workspaceId, input.serverId);
  if (!config) {
    throw new Error(`Unknown MCP server: ${input.serverId}`);
  }
  if (config.auth.kind !== "oauth") {
    throw new Error("This MCP server does not use OAuth.");
  }
  const auth = config.auth;
  const authorizationUrl =
    auth.authorizationUrl?.trim() ||
    (auth.discoveryUrl
      ? await discoverAuthorizationUrl(auth.discoveryUrl.trim())
      : null);
  const tokenUrl =
    auth.tokenUrl?.trim() ||
    (auth.discoveryUrl ? await discoverTokenUrl(auth.discoveryUrl.trim()) : null);
  if (!authorizationUrl || !tokenUrl) {
    throw new Error(
      "OAuth URLs are not configured. Set authorizationUrl and tokenUrl on this server."
    );
  }

  const codeVerifier = base64Url(randomBytes(32));
  const challenge = base64Url(
    createHash("sha256").update(codeVerifier).digest()
  );
  const state = randomUUID();
  const redirectUri = buildMcpOAuthCallbackUrl(input.publicOrigin);

  pendingByState.set(state, {
    workspaceId: input.workspaceId,
    serverId: input.serverId,
    codeVerifier,
    createdAt: Date.now(),
    redirectUri,
    tokenUrl,
  });

  const url = new URL(authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", await resolveOAuthClientId(input.workspaceId, config));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (auth.scopes?.length) {
    url.searchParams.set("scope", auth.scopes.join(" "));
  }

  return { authorizationUrl: url.toString(), state };
}

async function resolveOAuthClientId(
  workspaceId: string,
  config: McpServerConfig
): Promise<string> {
  if (config.auth.kind !== "oauth" || !config.auth.clientIdSecretId) {
    throw new Error("OAuth client id is not configured for this MCP server.");
  }
  const { getMcpSecret } = await import("./server-store.js");
  const secret = await getMcpSecret(workspaceId, config.auth.clientIdSecretId);
  if (!secret || secret.kind !== "value" || !secret.value.trim()) {
    throw new Error("OAuth client id secret is missing.");
  }
  return secret.value.trim();
}

async function resolveOAuthClientSecret(
  workspaceId: string,
  config: McpServerConfig
): Promise<string | undefined> {
  if (config.auth.kind !== "oauth" || !config.auth.clientSecretSecretId) {
    return undefined;
  }
  const { getMcpSecret } = await import("./server-store.js");
  const secret = await getMcpSecret(workspaceId, config.auth.clientSecretSecretId);
  if (!secret || secret.kind !== "value") {
    return undefined;
  }
  return secret.value.trim() || undefined;
}

async function discoverAuthorizationUrl(discoveryUrl: string): Promise<string | null> {
  const doc = await fetchOAuthMetadata(discoveryUrl);
  return typeof doc.authorization_endpoint === "string"
    ? doc.authorization_endpoint
    : null;
}

async function discoverTokenUrl(discoveryUrl: string): Promise<string | null> {
  const doc = await fetchOAuthMetadata(discoveryUrl);
  return typeof doc.token_endpoint === "string" ? doc.token_endpoint : null;
}

async function fetchOAuthMetadata(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`OAuth discovery failed (${response.status}).`);
  }
  return (await response.json()) as Record<string, unknown>;
}

export async function completeMcpOAuthCallback(input: {
  code: string;
  state: string;
}): Promise<{ workspaceId: string; serverId: string }> {
  cleanupPending();
  const pending = pendingByState.get(input.state);
  if (!pending) {
    throw new Error("OAuth state is invalid or expired.");
  }
  pendingByState.delete(input.state);

  const config = await getMcpServer(pending.workspaceId, pending.serverId);
  if (!config || config.auth.kind !== "oauth") {
    throw new Error("OAuth MCP server configuration is missing.");
  }

  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", input.code);
  body.set("redirect_uri", pending.redirectUri);
  body.set("client_id", await resolveOAuthClientId(pending.workspaceId, config));
  body.set("code_verifier", pending.codeVerifier);
  const clientSecret = await resolveOAuthClientSecret(pending.workspaceId, config);
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const response = await fetch(pending.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OAuth token exchange failed (${response.status}): ${text}`);
  }
  const tokenPayload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!tokenPayload.access_token?.trim()) {
    throw new Error("OAuth token response did not include access_token.");
  }

  const expiresAt =
    typeof tokenPayload.expires_in === "number"
      ? Date.now() + tokenPayload.expires_in * 1000
      : undefined;

  await setMcpSecret(pending.workspaceId, `${pending.serverId}:oauth:access`, {
    kind: "oauth",
    accessToken: tokenPayload.access_token.trim(),
    refreshToken: tokenPayload.refresh_token?.trim(),
    expiresAt,
    scopes: tokenPayload.scope?.split(/\s+/).filter(Boolean),
    updatedAt: Date.now(),
  });

  return { workspaceId: pending.workspaceId, serverId: pending.serverId };
}

export function oauthSuccessHtml(serverLabel: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>MCP connected</title></head><body style="font-family:system-ui;padding:2rem;"><h1>Connected</h1><p>${serverLabel} is authenticated. You can close this window and return to OpenCursor.</p><script>if(window.opener){window.opener.postMessage({type:"opencursor-mcp-oauth",ok:true}, "*");}</script></body></html>`;
}

export function oauthFailureHtml(message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>MCP OAuth failed</title></head><body style="font-family:system-ui;padding:2rem;"><h1>Authentication failed</h1><p>${message}</p></body></html>`;
}
