import { getCloudAgentConnection } from "./settings.js";
import type { CloudAgentProviderId, CloudAgentTaskRecord } from "./types.js";

export const CLOUD_AGENT_PROVIDER_LABELS: Record<CloudAgentProviderId, string> = {
  linear: "Linear",
  github: "GitHub",
  slack: "Slack",
};

export type CloudAgentVerifiedIdentity = {
  accountLabel: string;
  scopes?: string[];
};

async function fetchJson(
  url: string,
  init: RequestInit
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const response = await fetch(url, init);
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON responses fall through with a null body.
  }
  return { status: response.status, headers: response.headers, body };
}

/**
 * Verifies a token against the provider's identity endpoint and returns a
 * human-readable account label. Throws with a useful message on failure.
 */
export async function verifyCloudAgentToken(
  providerId: CloudAgentProviderId,
  accessToken: string
): Promise<CloudAgentVerifiedIdentity> {
  switch (providerId) {
    case "github": {
      const githubHeaders = {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "cesium-cloud-agents",
      };
      const { status, headers, body } = await fetchJson("https://api.github.com/user", {
        headers: githubHeaders,
      });
      if (status === 200) {
        const login = (body as { login?: string })?.login;
        const scopes = headers
          .get("x-oauth-scopes")
          ?.split(",")
          .map((scope) => scope.trim())
          .filter(Boolean);
        return {
          accountLabel: login ? `@${login}` : "GitHub account",
          ...(scopes && scopes.length > 0 ? { scopes } : {}),
        };
      }
      // GitHub App installation tokens cannot access /user; identify them via
      // the installation's repository listing instead.
      if (status === 403 || status === 401) {
        const installation = await fetchJson(
          "https://api.github.com/installation/repositories?per_page=1",
          { headers: githubHeaders }
        );
        if (installation.status === 200) {
          const repos = (installation.body as {
            total_count?: number;
            repositories?: Array<{ owner?: { login?: string } }>;
          }) ?? {};
          const owner = repos.repositories?.[0]?.owner?.login;
          return {
            accountLabel: owner
              ? `GitHub App · ${owner} (${repos.total_count ?? "?"} repos)`
              : "GitHub App installation",
          };
        }
      }
      throw new Error(`GitHub rejected the token (HTTP ${status}).`);
    }
    case "linear": {
      const { status, body } = await fetchJson("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          Authorization: accessToken.startsWith("Bearer ")
            ? accessToken
            : accessToken.startsWith("lin_oauth_")
              ? `Bearer ${accessToken}`
              : accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: "{ viewer { id name email } organization { name } }",
        }),
      });
      const data = (body as { data?: { viewer?: { name?: string }; organization?: { name?: string } } })
        ?.data;
      if (status !== 200 || !data?.viewer) {
        throw new Error(`Linear rejected the token (HTTP ${status}).`);
      }
      const parts = [data.viewer.name, data.organization?.name].filter(Boolean);
      return { accountLabel: parts.join(" · ") || "Linear account" };
    }
    case "slack": {
      const { status, body } = await fetchJson("https://slack.com/api/auth.test", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });
      const payload = body as { ok?: boolean; error?: string; team?: string; user?: string };
      if (status !== 200 || !payload?.ok) {
        throw new Error(`Slack rejected the token (${payload?.error ?? `HTTP ${status}`}).`);
      }
      const parts = [payload.user, payload.team].filter(Boolean);
      return { accountLabel: parts.join(" · ") || "Slack workspace" };
    }
  }
}

/**
 * Posts a progress/update comment back to the task's source (Linear comment,
 * GitHub issue comment, or Slack message). Requires a stored connection.
 */
export async function postCloudAgentUpdate(
  task: CloudAgentTaskRecord,
  message: string
): Promise<{ delivered: true; detail: string }> {
  const providerId = task.source.providerId;
  if (providerId === "manual") {
    throw new Error("Manual tasks have no external source to post updates to.");
  }
  const connection = await getCloudAgentConnection(providerId);
  if (!connection) {
    throw new Error(
      `No ${CLOUD_AGENT_PROVIDER_LABELS[providerId]} connection configured.`
    );
  }

  switch (providerId) {
    case "github": {
      const repo = task.source.repo;
      const issueNumber = task.source.externalId;
      if (!repo || !issueNumber) {
        throw new Error("Task is missing GitHub repo/issue metadata.");
      }
      const response = await fetch(
        `https://api.github.com/repos/${repo}/issues/${encodeURIComponent(issueNumber)}/comments`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${connection.accessToken}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "cesium-cloud-agents",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ body: message }),
        }
      );
      if (response.status !== 201) {
        throw new Error(`GitHub comment failed (HTTP ${response.status}).`);
      }
      return { delivered: true, detail: `Commented on ${repo}#${issueNumber}` };
    }
    case "linear": {
      const issueId = task.source.externalId;
      if (!issueId) {
        throw new Error("Task is missing its Linear issue id.");
      }
      const response = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          Authorization: connection.accessToken.startsWith("lin_oauth_")
            ? `Bearer ${connection.accessToken}`
            : connection.accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query:
            "mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
          variables: { input: { issueId, body: message } },
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        data?: { commentCreate?: { success?: boolean } };
        errors?: Array<{ message?: string }>;
      } | null;
      if (!body?.data?.commentCreate?.success) {
        throw new Error(
          `Linear comment failed (${body?.errors?.[0]?.message ?? `HTTP ${response.status}`}).`
        );
      }
      return { delivered: true, detail: `Commented on Linear issue ${issueId}` };
    }
    case "slack": {
      const channel = task.source.channel;
      if (!channel) {
        throw new Error("Task is missing its Slack channel.");
      }
      const response = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${connection.accessToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel,
          text: message,
          ...(task.source.externalId ? { thread_ts: task.source.externalId } : {}),
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!body?.ok) {
        throw new Error(`Slack message failed (${body?.error ?? `HTTP ${response.status}`}).`);
      }
      return { delivered: true, detail: `Posted to Slack channel ${channel}` };
    }
  }
}
