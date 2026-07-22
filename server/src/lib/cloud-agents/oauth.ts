import { randomBytes } from "node:crypto";
import { getCloudAgentOAuthApp, upsertCloudAgentConnection } from "./settings.js";
import { CLOUD_AGENT_PROVIDER_LABELS, verifyCloudAgentToken } from "./connections.js";
import type { CloudAgentProviderId } from "./types.js";

type PendingOAuthState = {
  providerId: CloudAgentProviderId;
  createdAt: number;
  redirectUri: string;
};

const pendingByState = new Map<string, PendingOAuthState>();
const PENDING_TTL_MS = 15 * 60 * 1000;

function cleanupPending(): void {
  const now = Date.now();
  for (const [state, pending] of pendingByState.entries()) {
    if (now - pending.createdAt > PENDING_TTL_MS) {
      pendingByState.delete(state);
    }
  }
}

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

export function buildCloudAgentAuthorizeUrl(input: {
  providerId: CloudAgentProviderId;
  clientId: string;
  redirectUri: string;
  state: string;
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
      });
      return `https://linear.app/oauth/authorize?${params.toString()}`;
    }
    case "github": {
      const params = new URLSearchParams({
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        scope: DEFAULT_OAUTH_SCOPES.github,
        state: input.state,
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
}): Promise<{ providerId: CloudAgentProviderId; authUrl: string; callbackUrl: string }> {
  cleanupPending();
  const app = await getCloudAgentOAuthApp(input.providerId);
  if (!app) {
    throw new Error(
      `Save an OAuth client id and secret for ${CLOUD_AGENT_PROVIDER_LABELS[input.providerId]} first, or connect with a personal access token instead.`
    );
  }
  const state = randomBytes(24).toString("base64url");
  const redirectUri = buildCloudAgentOAuthCallbackUrl(input.publicOrigin);
  pendingByState.set(state, {
    providerId: input.providerId,
    createdAt: Date.now(),
    redirectUri,
  });
  return {
    providerId: input.providerId,
    authUrl: buildCloudAgentAuthorizeUrl({
      providerId: input.providerId,
      clientId: app.clientId,
      redirectUri,
      state,
    }),
    callbackUrl: redirectUri,
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
}): Promise<{ providerId: CloudAgentProviderId }> {
  cleanupPending();
  const pending = pendingByState.get(input.state);
  if (!pending) {
    throw new Error("OAuth flow is invalid or expired.");
  }
  pendingByState.delete(input.state);

  const exchanged = await exchangeCodeForToken({
    providerId: pending.providerId,
    code: input.code,
    redirectUri: pending.redirectUri,
  });

  let accountLabel = exchanged.accountLabel;
  if (!accountLabel) {
    try {
      accountLabel = (
        await verifyCloudAgentToken(pending.providerId, exchanged.accessToken)
      ).accountLabel;
    } catch {
      // Identity lookup is best-effort; the token itself already exchanged fine.
    }
  }

  await upsertCloudAgentConnection({
    providerId: pending.providerId,
    method: "oauth",
    accessToken: exchanged.accessToken,
    ...(accountLabel ? { accountLabel } : {}),
    ...(exchanged.scopes ? { scopes: exchanged.scopes } : {}),
  });
  return { providerId: pending.providerId };
}

export function cloudAgentOAuthSuccessHtml(providerLabel: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Cloud Agents connected</title></head><body style="font-family:system-ui;padding:2rem;"><h1>Connected</h1><p>${providerLabel} is now linked to Cloud Agents. You can close this window and return to Cesium.</p><script>if(window.opener){window.opener.postMessage({type:"opencursor-cloud-agents-oauth",ok:true}, "*");}</script></body></html>`;
}

export function cloudAgentOAuthFailureHtml(message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Cloud Agents OAuth failed</title></head><body style="font-family:system-ui;padding:2rem;"><h1>Connection failed</h1><p>${message}</p></body></html>`;
}
