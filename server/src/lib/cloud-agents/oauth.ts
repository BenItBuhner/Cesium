import { createHash, randomBytes } from "node:crypto";
import { oauthCompletionHtml } from "../oauth/callback-html.js";
import {
  createOAuthCoordinatorSession,
  getOAuthCoordinatorSession,
  updateOAuthCoordinatorSession,
} from "../oauth/sessions.js";
import { getCloudAgentOAuthApp, upsertCloudAgentConnection } from "./settings.js";
import { CLOUD_AGENT_PROVIDER_LABELS, verifyCloudAgentToken } from "./connections.js";
import type { CloudAgentProviderId } from "./types.js";

const PENDING_TTL_MS = 15 * 60 * 1000;

export function buildCloudAgentOAuthCallbackUrl(publicOrigin: string): string {
  return `${publicOrigin.replace(/\/$/, "")}/api/cloud-agents/oauth/callback`;
}

export function buildCloudAgentWebhookUrl(
  publicOrigin: string,
  providerId: CloudAgentProviderId
): string {
  return `${publicOrigin.replace(/\/$/, "")}/api/cloud-agents/webhooks/${providerId}`;
}

const DEFAULT_OAUTH_SCOPES: Record<CloudAgentProviderId, string> = {
  linear: "read,write,issues:create,comments:create",
  github: "repo,read:user",
  slack: "app_mentions:read,chat:write,channels:history,channels:read",
};

function pkcePair(): { codeVerifier: string; challenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  return {
    codeVerifier,
    challenge: createHash("sha256").update(codeVerifier).digest("base64url"),
  };
}

export function buildCloudAgentAuthorizeUrl(input: {
  providerId: CloudAgentProviderId;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge?: string;
}): string {
  switch (input.providerId) {
    case "linear": {
      const params = new URLSearchParams({
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        response_type: "code",
        scope: DEFAULT_OAUTH_SCOPES.linear,
        state: input.state,
        actor: "app",
        ...(input.codeChallenge
          ? { code_challenge: input.codeChallenge, code_challenge_method: "S256" }
          : {}),
      });
      return `https://linear.app/oauth/authorize?${params.toString()}`;
    }
    case "github": {
      const params = new URLSearchParams({
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        scope: DEFAULT_OAUTH_SCOPES.github,
        state: input.state,
        ...(input.codeChallenge
          ? { code_challenge: input.codeChallenge, code_challenge_method: "S256" }
          : {}),
      });
      return `https://github.com/login/oauth/authorize?${params.toString()}`;
    }
    case "slack": {
      const params = new URLSearchParams({
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        scope: DEFAULT_OAUTH_SCOPES.slack,
        state: input.state,
      });
      return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
    }
  }
}

export async function startCloudAgentOAuth(input: {
  providerId: CloudAgentProviderId;
  publicOrigin: string;
}): Promise<{
  providerId: CloudAgentProviderId;
  authUrl: string;
  callbackUrl: string;
  sessionId: string;
}> {
  const app = await getCloudAgentOAuthApp(input.providerId);
  if (!app) {
    throw new Error(
      `Save an OAuth client id and secret for ${CLOUD_AGENT_PROVIDER_LABELS[input.providerId]} first, or connect with a personal access token instead.`
    );
  }
  const state = randomBytes(24).toString("base64url");
  const redirectUri = buildCloudAgentOAuthCallbackUrl(input.publicOrigin);
  const pkce = input.providerId === "slack" ? null : pkcePair();
  await createOAuthCoordinatorSession({
    id: state,
    kind: "cloud-agents",
    label: CLOUD_AGENT_PROVIDER_LABELS[input.providerId],
    ttlMs: PENDING_TTL_MS,
    payload: {
      providerId: input.providerId,
      redirectUri,
      ...(pkce ? { codeVerifier: pkce.codeVerifier } : {}),
    },
  });
  return {
    providerId: input.providerId,
    authUrl: buildCloudAgentAuthorizeUrl({
      providerId: input.providerId,
      clientId: app.clientId,
      redirectUri,
      state,
      ...(pkce ? { codeChallenge: pkce.challenge } : {}),
    }),
    callbackUrl: redirectUri,
    sessionId: state,
  };
}

type TokenExchangeResult = {
  accessToken: string;
  scopes?: string[];
  accountLabel?: string;
};

async function exchangeCodeForToken(input: {
  providerId: CloudAgentProviderId;
  code: string;
  redirectUri: string;
  codeVerifier?: string;
}): Promise<TokenExchangeResult> {
  const app = await getCloudAgentOAuthApp(input.providerId);
  if (!app) {
    throw new Error(`OAuth app credentials for ${input.providerId} are missing.`);
  }

  switch (input.providerId) {
    case "linear": {
      const response = await fetch("https://api.linear.app/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: app.clientId,
          client_secret: app.clientSecret,
          redirect_uri: input.redirectUri,
          code: input.code,
          grant_type: "authorization_code",
          ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}),
        }).toString(),
      });
      const body = (await response.json().catch(() => null)) as {
        access_token?: string;
        scope?: string;
        error?: string;
      } | null;
      if (!body?.access_token) {
        throw new Error(`Linear token exchange failed (${body?.error ?? response.status}).`);
      }
      return {
        accessToken: body.access_token,
        scopes: body.scope?.split(/[,\s]+/).filter(Boolean),
      };
    }
    case "github": {
      const response = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          client_id: app.clientId,
          client_secret: app.clientSecret,
          redirect_uri: input.redirectUri,
          code: input.code,
          ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}),
        }).toString(),
      });
      const body = (await response.json().catch(() => null)) as {
        access_token?: string;
        scope?: string;
        error_description?: string;
      } | null;
      if (!body?.access_token) {
        throw new Error(
          `GitHub token exchange failed (${body?.error_description ?? response.status}).`
        );
      }
      return {
        accessToken: body.access_token,
        scopes: body.scope?.split(/[,\s]+/).filter(Boolean),
      };
    }
    case "slack": {
      const response = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: app.clientId,
          client_secret: app.clientSecret,
          redirect_uri: input.redirectUri,
          code: input.code,
        }).toString(),
      });
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        access_token?: string;
        scope?: string;
        team?: { name?: string };
      } | null;
      if (!body?.ok || !body.access_token) {
        throw new Error(`Slack token exchange failed (${body?.error ?? response.status}).`);
      }
      return {
        accessToken: body.access_token,
        scopes: body.scope?.split(/[,\s]+/).filter(Boolean),
        ...(body.team?.name ? { accountLabel: body.team.name } : {}),
      };
    }
  }
}

export async function completeCloudAgentOAuthCallback(input: {
  code: string;
  state: string;
}): Promise<{ providerId: CloudAgentProviderId; sessionId: string }> {
  const pending = await getOAuthCoordinatorSession(input.state);
  if (!pending || pending.kind !== "cloud-agents" || pending.status !== "pending") {
    throw new Error("OAuth flow is invalid or expired.");
  }
  const providerId = pending.payload.providerId as CloudAgentProviderId;
  const redirectUri = String(pending.payload.redirectUri ?? "");
  const codeVerifier =
    typeof pending.payload.codeVerifier === "string" ? pending.payload.codeVerifier : undefined;

  try {
    const exchanged = await exchangeCodeForToken({
      providerId,
      code: input.code,
      redirectUri,
      codeVerifier,
    });

    let accountLabel = exchanged.accountLabel;
    if (!accountLabel) {
      try {
        accountLabel = (await verifyCloudAgentToken(providerId, exchanged.accessToken)).accountLabel;
      } catch {
        // Identity lookup is best-effort; the token itself already exchanged fine.
      }
    }

    await upsertCloudAgentConnection({
      providerId,
      method: "oauth",
      accessToken: exchanged.accessToken,
      ...(accountLabel ? { accountLabel } : {}),
      ...(exchanged.scopes ? { scopes: exchanged.scopes } : {}),
    });
    await updateOAuthCoordinatorSession(input.state, { status: "complete" });
    return { providerId, sessionId: input.state };
  } catch (error) {
    await updateOAuthCoordinatorSession(input.state, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function cloudAgentOAuthSuccessHtml(providerLabel: string, sessionId?: string): string {
  return oauthCompletionHtml({
    title: "Cloud Agents connected",
    heading: "Connected",
    message: `${providerLabel} is now linked to Cloud Agents.`,
    postMessageType: "opencursor-cloud-agents-oauth",
    sessionId,
    kind: "cloud-agents",
    ok: true,
  });
}

export function cloudAgentOAuthFailureHtml(message: string, sessionId?: string): string {
  return oauthCompletionHtml({
    title: "Cloud Agents OAuth failed",
    heading: "Connection failed",
    message,
    postMessageType: "opencursor-cloud-agents-oauth",
    sessionId,
    kind: "cloud-agents",
    ok: false,
  });
}
