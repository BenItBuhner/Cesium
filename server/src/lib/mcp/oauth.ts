import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { McpServerConfig } from "@cesium/core/mcp";
import { oauthCompletionHtml } from "../oauth/callback-html.js";
import {
  createOAuthCoordinatorSession,
  getOAuthCoordinatorSession,
  updateOAuthCoordinatorSession,
} from "../oauth/sessions.js";
import {
  createSecretId,
  getMcpSecret,
  getMcpServer,
  setMcpSecret,
  upsertMcpServer,
} from "./server-store.js";
import {
  discoverAuthorizationServer,
  mcpResourceFromRemoteUrl,
  probeMcpRemoteAuth,
  registerOAuthClient,
} from "./oauth-discovery.js";

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export function buildMcpOAuthCallbackUrl(publicOrigin: string): string {
  return `${publicOrigin.replace(/\/$/, "")}/api/mcp/oauth/callback`;
}

function mcpOAuthTokenSecretId(serverId: string): string {
  return `${serverId}:oauth:access`;
}

async function persistClientCredentials(
  workspaceId: string,
  config: McpServerConfig,
  credentials: { clientId: string; clientSecret?: string }
): Promise<McpServerConfig> {
  if (config.auth.kind !== "oauth") {
    return config;
  }
  const clientIdSecretId = config.auth.clientIdSecretId ?? createSecretId(config.id, "clientId");
  await setMcpSecret(workspaceId, clientIdSecretId, {
    kind: "value",
    value: credentials.clientId,
    updatedAt: Date.now(),
  });
  let clientSecretSecretId = config.auth.clientSecretSecretId;
  if (credentials.clientSecret) {
    clientSecretSecretId = clientSecretSecretId ?? createSecretId(config.id, "clientSecret");
    await setMcpSecret(workspaceId, clientSecretSecretId, {
      kind: "value",
      value: credentials.clientSecret,
      updatedAt: Date.now(),
    });
  }
  const next: McpServerConfig = {
    ...config,
    auth: {
      ...config.auth,
      clientIdSecretId,
      ...(clientSecretSecretId ? { clientSecretSecretId } : {}),
    },
    updatedAt: Date.now(),
  };
  return upsertMcpServer(workspaceId, next);
}

async function resolveOAuthClientId(
  workspaceId: string,
  config: McpServerConfig
): Promise<string | null> {
  if (config.auth.kind !== "oauth" || !config.auth.clientIdSecretId) {
    return null;
  }
  const secret = await getMcpSecret(workspaceId, config.auth.clientIdSecretId);
  if (!secret || secret.kind !== "value" || !secret.value.trim()) {
    return null;
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
  const secret = await getMcpSecret(workspaceId, config.auth.clientSecretSecretId);
  if (!secret || secret.kind !== "value") {
    return undefined;
  }
  return secret.value.trim() || undefined;
}

async function resolveOAuthEndpoints(
  config: McpServerConfig
): Promise<{
  authorizationUrl: string;
  tokenUrl: string;
  registrationUrl?: string;
  resource?: string;
}> {
  if (config.auth.kind !== "oauth") {
    throw new Error("This MCP server does not use OAuth.");
  }
  const auth = config.auth;
  let authorizationUrl = auth.authorizationUrl?.trim() || "";
  let tokenUrl = auth.tokenUrl?.trim() || "";
  let registrationUrl = auth.registrationUrl?.trim() || "";
  let resource = auth.resource?.trim() || config.remote?.url?.trim() || "";

  if (auth.discoveryUrl?.trim() && (!authorizationUrl || !tokenUrl)) {
    const metadata = await discoverAuthorizationServer(auth.discoveryUrl.trim());
    authorizationUrl = authorizationUrl || metadata.authorization_endpoint?.trim() || "";
    tokenUrl = tokenUrl || metadata.token_endpoint?.trim() || "";
    registrationUrl = registrationUrl || metadata.registration_endpoint?.trim() || "";
  }

  if ((!authorizationUrl || !tokenUrl) && config.remote?.url?.trim()) {
    const probed = await probeMcpRemoteAuth(config.remote.url.trim());
    if (probed.kind === "oauth") {
      authorizationUrl = authorizationUrl || probed.authorizationUrl || "";
      tokenUrl = tokenUrl || probed.tokenUrl || "";
      registrationUrl = registrationUrl || probed.registrationUrl || "";
      resource = resource || probed.resource || config.remote.url.trim();
    }
  }

  if (!authorizationUrl || !tokenUrl) {
    throw new Error(
      "OAuth URLs are not configured. Set authorizationUrl and tokenUrl, or use a server that supports OAuth discovery."
    );
  }
  return {
    authorizationUrl,
    tokenUrl,
    ...(registrationUrl ? { registrationUrl } : {}),
    ...(resource ? { resource } : {}),
  };
}

export async function startMcpOAuth(input: {
  workspaceId: string;
  serverId: string;
  publicOrigin: string;
}): Promise<{ authorizationUrl: string; state: string; sessionId: string }> {
  let config = await getMcpServer(input.workspaceId, input.serverId);
  if (!config) {
    throw new Error(`Unknown MCP server: ${input.serverId}`);
  }
  if (config.auth.kind !== "oauth") {
    throw new Error("This MCP server does not use OAuth.");
  }

  const endpoints = await resolveOAuthEndpoints(config);
  const redirectUri = buildMcpOAuthCallbackUrl(input.publicOrigin);
  let clientId = await resolveOAuthClientId(input.workspaceId, config);
  if (!clientId) {
    if (!endpoints.registrationUrl) {
      throw new Error(
        "OAuth client id is not configured. Save a client id or use a server that supports dynamic client registration."
      );
    }
    const registered = await registerOAuthClient({
      registrationUrl: endpoints.registrationUrl,
      redirectUri,
      clientName: `Cesium (${config.label})`,
    });
    config = await persistClientCredentials(input.workspaceId, config, registered);
    clientId = registered.clientId;
  }

  const codeVerifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(codeVerifier).digest());
  const state = randomUUID();
  const resource = endpoints.resource || mcpResourceFromRemoteUrl(config.remote?.url ?? "");

  await createOAuthCoordinatorSession({
    id: state,
    kind: "mcp",
    label: config.label,
    payload: {
      workspaceId: input.workspaceId,
      serverId: input.serverId,
      codeVerifier,
      redirectUri,
      tokenUrl: endpoints.tokenUrl,
      resource,
    },
  });

  const url = new URL(endpoints.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (config.auth.kind === "oauth" && config.auth.scopes?.length) {
    url.searchParams.set("scope", config.auth.scopes.join(" "));
  }
  if (resource) {
    url.searchParams.set("resource", resource);
  }

  return { authorizationUrl: url.toString(), state, sessionId: state };
}

async function persistTokenResponse(input: {
  workspaceId: string;
  serverId: string;
  tokenPayload: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  fallbackRefreshToken?: string;
}): Promise<void> {
  if (!input.tokenPayload.access_token?.trim()) {
    throw new Error("OAuth token response did not include access_token.");
  }
  const expiresAt =
    typeof input.tokenPayload.expires_in === "number"
      ? Date.now() + input.tokenPayload.expires_in * 1000
      : undefined;
  await setMcpSecret(input.workspaceId, mcpOAuthTokenSecretId(input.serverId), {
    kind: "oauth",
    accessToken: input.tokenPayload.access_token.trim(),
    refreshToken: input.tokenPayload.refresh_token?.trim() || input.fallbackRefreshToken,
    expiresAt,
    scopes: input.tokenPayload.scope?.split(/\s+/).filter(Boolean),
    updatedAt: Date.now(),
  });
}

export async function completeMcpOAuthCallback(input: {
  code: string;
  state: string;
}): Promise<{ workspaceId: string; serverId: string; sessionId: string }> {
  const pending = await getOAuthCoordinatorSession(input.state);
  if (!pending || pending.kind !== "mcp" || pending.status !== "pending") {
    throw new Error("OAuth state is invalid or expired.");
  }
  const workspaceId = String(pending.payload.workspaceId ?? "");
  const serverId = String(pending.payload.serverId ?? "");
  const codeVerifier = String(pending.payload.codeVerifier ?? "");
  const redirectUri = String(pending.payload.redirectUri ?? "");
  const tokenUrl = String(pending.payload.tokenUrl ?? "");
  const resource = String(pending.payload.resource ?? "");
  if (!workspaceId || !serverId || !codeVerifier || !redirectUri || !tokenUrl) {
    throw new Error("OAuth session is missing required MCP fields.");
  }

  const config = await getMcpServer(workspaceId, serverId);
  if (!config || config.auth.kind !== "oauth") {
    throw new Error("OAuth MCP server configuration is missing.");
  }

  const clientId = await resolveOAuthClientId(workspaceId, config);
  if (!clientId) {
    throw new Error("OAuth client id is missing.");
  }

  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", input.code);
  body.set("redirect_uri", redirectUri);
  body.set("client_id", clientId);
  body.set("code_verifier", codeVerifier);
  const clientSecret = await resolveOAuthClientSecret(workspaceId, config);
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }
  if (resource) {
    body.set("resource", resource);
  }

  try {
    const response = await fetch(tokenUrl, {
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
    await persistTokenResponse({ workspaceId, serverId, tokenPayload });
    await updateOAuthCoordinatorSession(input.state, { status: "complete" });
    return { workspaceId, serverId, sessionId: input.state };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateOAuthCoordinatorSession(input.state, { status: "failed", error: message });
    throw error;
  }
}

export async function refreshMcpOAuthAccessToken(input: {
  workspaceId: string;
  config: McpServerConfig;
  force?: boolean;
}): Promise<string | null> {
  const { workspaceId, config } = input;
  if (config.auth.kind !== "oauth") {
    return null;
  }
  const secret = await getMcpSecret(workspaceId, mcpOAuthTokenSecretId(config.id));
  if (!secret || secret.kind !== "oauth" || !secret.accessToken.trim()) {
    return null;
  }
  const expiringSoon =
    typeof secret.expiresAt === "number" && secret.expiresAt <= Date.now() + 60_000;
  if (!input.force && !expiringSoon) {
    return secret.accessToken.trim();
  }
  if (!secret.refreshToken?.trim()) {
    if (expiringSoon) {
      return null;
    }
    return secret.accessToken.trim();
  }

  const endpoints = await resolveOAuthEndpoints(config);
  const clientId = await resolveOAuthClientId(workspaceId, config);
  if (!clientId) {
    return secret.accessToken.trim();
  }
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", secret.refreshToken.trim());
  body.set("client_id", clientId);
  const clientSecret = await resolveOAuthClientSecret(workspaceId, config);
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }
  if (endpoints.resource) {
    body.set("resource", endpoints.resource);
  }
  const response = await fetch(endpoints.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    return expiringSoon ? null : secret.accessToken.trim();
  }
  const tokenPayload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  await persistTokenResponse({
    workspaceId,
    serverId: config.id,
    tokenPayload,
    fallbackRefreshToken: secret.refreshToken,
  });
  return tokenPayload.access_token?.trim() ?? secret.accessToken.trim();
}

export async function disconnectMcpOAuth(
  workspaceId: string,
  serverId: string
): Promise<void> {
  const { deleteMcpSecret } = await import("./server-store.js");
  await deleteMcpSecret(workspaceId, mcpOAuthTokenSecretId(serverId));
}

export function oauthSuccessHtml(serverLabel: string, sessionId?: string): string {
  return oauthCompletionHtml({
    title: "MCP connected",
    heading: "Connected",
    message: `${serverLabel} is authenticated.`,
    postMessageType: "opencursor-mcp-oauth",
    sessionId,
    kind: "mcp",
    ok: true,
  });
}

export function oauthFailureHtml(message: string, sessionId?: string): string {
  return oauthCompletionHtml({
    title: "MCP OAuth failed",
    heading: "Authentication failed",
    message,
    postMessageType: "opencursor-mcp-oauth",
    sessionId,
    kind: "mcp",
    ok: false,
  });
}
