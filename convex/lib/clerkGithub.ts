/**
 * Clerk Backend API helpers for the GitHub OAuth token used by Codespaces.
 */

export function extractClerkApiErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const errors = (payload as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return null;
  }
  const first = errors[0];
  if (!first || typeof first !== "object") {
    return null;
  }
  const row = first as { long_message?: unknown; message?: unknown };
  if (typeof row.long_message === "string" && row.long_message.trim()) {
    return row.long_message.trim();
  }
  if (typeof row.message === "string" && row.message.trim()) {
    return row.message.trim();
  }
  return null;
}

export function readClerkGithubOauthToken(payload: unknown): string | null {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown[] }).data)
      ? (payload as { data: unknown[] }).data
      : [];
  const first = rows[0] as { token?: string } | undefined;
  return typeof first?.token === "string" && first.token.length > 0
    ? first.token
    : null;
}
