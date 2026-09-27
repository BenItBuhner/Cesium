import { githubWebHost } from "./credentials.js";

/** GitHub owners are alphanumerics and inner dashes; repo names never are `.` or `..`. */
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;

export function isGithubRepoSlug(value: string | null | undefined): value is string {
  return typeof value === "string" && REPO_PATTERN.test(value);
}

/**
 * `owner/repo` from a git remote URL on the GitHub host (https, ssh or scp
 * form, with or without credentials and `.git`), else null.
 */
export function parseGithubRepo(remoteUrl: string | null | undefined, host = githubWebHost()): string | null {
  const raw = remoteUrl?.trim();
  if (!raw) {
    return null;
  }
  const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`^(?:https?|ssh|git)://(?:[^@/]+@)?${escapedHost}(?::\\d+)?/([^/]+)/([^/]+?)(?:\\.git)?/?$`, "i"),
    new RegExp(`^[^@/]+@${escapedHost}:([^/]+)/([^/]+?)(?:\\.git)?/?$`, "i"),
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) {
      const slug = `${match[1]}/${match[2]}`;
      return isGithubRepoSlug(slug) ? slug : null;
    }
  }
  return null;
}
