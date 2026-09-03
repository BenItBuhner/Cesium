/**
 * Human-readable errors for the Clerk-backed GitHub Codespaces connect flow.
 *
 * Clerk's default copy for a blocked `createExternalAccount` is
 * "You need to provide additional verification to perform this operation".
 * That is a session step-up / SSO-not-ready failure, not a request to add
 * some extra Cesium setting. Map it (and Convex action dumps) to something
 * an operator can act on.
 */

function clerkErrorText(error: unknown): string {
  if (error && typeof error === "object" && "errors" in error) {
    const rows = (error as { errors: unknown }).errors;
    if (Array.isArray(rows)) {
      const parts = rows
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const row = entry as {
            longMessage?: unknown;
            long_message?: unknown;
            message?: unknown;
          };
          if (typeof row.longMessage === "string" && row.longMessage.trim()) {
            return row.longMessage.trim();
          }
          if (typeof row.long_message === "string" && row.long_message.trim()) {
            return row.long_message.trim();
          }
          if (typeof row.message === "string" && row.message.trim()) {
            return row.message.trim();
          }
          return null;
        })
        .filter((part): part is string => Boolean(part));
      if (parts.length > 0) {
        return parts.join(" ");
      }
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export function formatGithubConnectError(error: unknown): string {
  const raw = clerkErrorText(error);
  const lower = raw.toLowerCase();

  if (lower.includes("additional verification")) {
    return [
      "Clerk blocked linking GitHub until the session is re-verified, or until GitHub SSO is actually enabled.",
      "In the Clerk dashboard: SSO connections → GitHub → add your GitHub OAuth App Client ID and Client Secret, add the repo and codespace scopes, then click Enable connection.",
      "If GitHub is already enabled, confirm the email on this Cesium account and try Connect GitHub again (Clerk will ask you to re-enter your password or complete a code).",
    ].join(" ");
  }

  // A bare Convex "Server Error" envelope carries no detail. The deployed
  // `github:connectionStatus` action reports real causes inline (`{ error }`);
  // seeing the envelope usually means the Convex functions are older than the
  // web client. Do not guess at a specific env var here.
  if (
    lower.includes("[convex") &&
    (lower.includes("connectionstatus") || lower.includes("github:"))
  ) {
    return [
      "The Convex deployment returned a server error while checking the GitHub connection.",
      "Redeploy the Convex functions (npx convex deploy) so they match this client, then check the deployment logs for github:connectionStatus if it persists.",
    ].join(" ");
  }

  return raw;
}
