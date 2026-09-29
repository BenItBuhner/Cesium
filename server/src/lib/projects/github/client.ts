import { githubApiBaseUrl, resolveGithubCredential, type GithubCredential } from "./credentials.js";

const REQUEST_TIMEOUT_MS = 20_000;
const ETAG_CACHE_LIMIT = 500;
/** Below this many remaining requests, polling pauses until the window resets. */
const RATE_LIMIT_FLOOR = 25;

export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

/** Wire shapes, trimmed to what Projects read. */
export type GithubPull = {
  number: number;
  html_url: string;
  title: string;
  state: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  mergeable?: boolean | null;
  body?: string | null;
  updated_at?: string;
  head: { ref: string; sha: string; repo?: { full_name?: string } | null };
  base: { ref: string };
  user?: { login?: string } | null;
};

export type GithubIssueComment = {
  id: number;
  html_url?: string;
  body?: string | null;
  created_at: string;
  user?: { login?: string; type?: string } | null;
};

export type GithubReview = {
  id: number;
  state: string;
  body?: string | null;
  html_url?: string;
  submitted_at?: string | null;
  user?: { login?: string } | null;
};

export type GithubReviewComment = {
  id: number;
  html_url?: string;
  body?: string | null;
  path?: string;
  line?: number | null;
  created_at: string;
  user?: { login?: string } | null;
};

export type GithubCheckRun = {
  name: string;
  status: string;
  conclusion: string | null;
};

export type GithubCombinedStatus = {
  state: string;
  statuses: Array<{ context: string; state: string }>;
};

type CachedResponse = { etag: string; data: unknown };

/**
 * Minimal GitHub REST client. GETs are sent with `If-None-Match` so unchanged
 * resources answer 304 (free against the rate limit), and the client stops
 * polling calls when the remaining quota runs low.
 */
export class GithubClient {
  private readonly etags = new Map<string, CachedResponse>();
  private rateLimitedUntil = 0;

  constructor(
    private readonly credential: GithubCredential,
    private readonly baseUrl = githubApiBaseUrl(),
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  get source(): GithubCredential["source"] {
    return this.credential.source;
  }

  /** True while the quota is nearly spent; background polls should wait. */
  isRateLimited(now = Date.now()): boolean {
    return now < this.rateLimitedUntil;
  }

  private remember(key: string, entry: CachedResponse): void {
    this.etags.delete(key);
    this.etags.set(key, entry);
    if (this.etags.size > ETAG_CACHE_LIMIT) {
      const oldest = this.etags.keys().next().value;
      if (oldest !== undefined) {
        this.etags.delete(oldest);
      }
    }
  }

  private noteRateLimit(response: Response): void {
    const remaining = Number(response.headers.get("x-ratelimit-remaining"));
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(remaining) && remaining < RATE_LIMIT_FLOOR && Number.isFinite(reset) && reset > 0) {
      this.rateLimitedUntil = reset * 1000;
    }
  }

  async request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${pathname}`;
    const cached = method === "GET" ? this.etags.get(url) : undefined;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.credential.token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "cesium-projects",
          ...(cached ? { "if-none-match": cached.etag } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new GithubApiError(
        `GitHub is unreachable (${error instanceof Error ? error.message : String(error)}).`,
        0,
        "github_unreachable"
      );
    }
    this.noteRateLimit(response);
    if (response.status === 304 && cached) {
      return cached.data as T;
    }
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && typeof (payload as { message?: unknown }).message === "string"
          ? (payload as { message: string }).message
          : `HTTP ${response.status}`;
      if (response.status === 403 && /rate limit/i.test(message)) {
        const reset = Number(response.headers.get("x-ratelimit-reset"));
        this.rateLimitedUntil = Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + 60_000;
      }
      throw new GithubApiError(
        `GitHub ${method} ${pathname}: ${message}`,
        response.status,
        response.status === 404 ? "github_not_found" : "github_error"
      );
    }
    const etag = response.headers.get("etag");
    if (method === "GET" && etag) {
      this.remember(url, { etag, data: payload });
    }
    return payload as T;
  }

  getPull(repo: string, number: number): Promise<GithubPull> {
    return this.request("GET", `/repos/${repo}/pulls/${number}`);
  }

  async findPullByHead(repo: string, branch: string): Promise<GithubPull | null> {
    const owner = repo.split("/")[0]!;
    const pulls = await this.request<GithubPull[]>(
      "GET",
      `/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=10`
    );
    const matching = (pulls ?? []).filter((pull) => pull.head.ref === branch);
    return matching.find((pull) => pull.state === "open") ?? matching[0] ?? null;
  }

  createPull(
    repo: string,
    input: { title: string; head: string; base: string; body: string; draft: boolean }
  ): Promise<GithubPull> {
    return this.request("POST", `/repos/${repo}/pulls`, input);
  }

  mergePull(
    repo: string,
    number: number,
    input: { mergeMethod: "squash" | "merge" | "rebase"; commitTitle: string; sha: string | null }
  ): Promise<{ merged: boolean; sha?: string; message?: string }> {
    return this.request("PUT", `/repos/${repo}/pulls/${number}/merge`, {
      merge_method: input.mergeMethod,
      commit_title: input.commitTitle,
      ...(input.sha ? { sha: input.sha } : {}),
    });
  }

  closePull(repo: string, number: number): Promise<GithubPull> {
    return this.request("PATCH", `/repos/${repo}/pulls/${number}`, { state: "closed" });
  }

  addIssueComment(repo: string, number: number, body: string): Promise<GithubIssueComment> {
    return this.request("POST", `/repos/${repo}/issues/${number}/comments`, { body });
  }

  /** Requests (or re-requests, for someone who already reviewed) reviews from these users. */
  requestReviewers(repo: string, number: number, reviewers: readonly string[]): Promise<GithubPull> {
    return this.request("POST", `/repos/${repo}/pulls/${number}/requested_reviewers`, { reviewers });
  }

  listIssueComments(repo: string, number: number): Promise<GithubIssueComment[]> {
    return this.request("GET", `/repos/${repo}/issues/${number}/comments?per_page=100`);
  }

  listReviews(repo: string, number: number): Promise<GithubReview[]> {
    return this.request("GET", `/repos/${repo}/pulls/${number}/reviews?per_page=100`);
  }

  listReviewComments(repo: string, number: number): Promise<GithubReviewComment[]> {
    return this.request("GET", `/repos/${repo}/pulls/${number}/comments?per_page=100`);
  }

  async getBranchHead(repo: string, branch: string): Promise<string | null> {
    try {
      const result = await this.request<{ commit?: { sha?: string } }>(
        "GET",
        `/repos/${repo}/branches/${encodeURIComponent(branch)}`
      );
      return result?.commit?.sha ?? null;
    } catch (error) {
      if (error instanceof GithubApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /** How far `head` is ahead of `base`, with its commit messages oldest first. */
  async compare(repo: string, base: string, head: string): Promise<{ aheadBy: number; commitMessages: string[] }> {
    const result = await this.request<{ ahead_by?: number; commits?: Array<{ commit?: { message?: string } }> }>(
      "GET",
      `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
    );
    return {
      aheadBy: typeof result?.ahead_by === "number" ? result.ahead_by : 0,
      commitMessages: (result?.commits ?? []).map((entry) => entry.commit?.message?.trim() ?? "").filter(Boolean),
    };
  }

  async listCheckRuns(repo: string, sha: string): Promise<GithubCheckRun[]> {
    const result = await this.request<{ check_runs?: GithubCheckRun[] }>(
      "GET",
      `/repos/${repo}/commits/${sha}/check-runs?per_page=100`
    );
    return result?.check_runs ?? [];
  }

  getCombinedStatus(repo: string, sha: string): Promise<GithubCombinedStatus> {
    return this.request("GET", `/repos/${repo}/commits/${sha}/status`);
  }
}

let shared: { client: GithubClient; token: string; baseUrl: string } | null = null;

/** The engine's GitHub client, or null when no credential is available. */
export async function projectGithubClient(): Promise<GithubClient | null> {
  const credential = await resolveGithubCredential();
  if (!credential) {
    return null;
  }
  const baseUrl = githubApiBaseUrl();
  if (!shared || shared.token !== credential.token || shared.baseUrl !== baseUrl) {
    shared = { client: new GithubClient(credential, baseUrl), token: credential.token, baseUrl };
  }
  return shared.client;
}

/** Test hook: drop the shared client (and its ETag cache). */
export function resetProjectGithubClient(): void {
  shared = null;
}

/** One commit-wide CI result from check runs plus commit statuses. */
export function summarizeCi(
  checkRuns: readonly GithubCheckRun[],
  combined: GithubCombinedStatus | null
): { state: "pending" | "success" | "failure" | "none"; total: number; failed: string[] } {
  const statuses = combined?.statuses ?? [];
  const total = checkRuns.length + statuses.length;
  if (total === 0) {
    return { state: "none", total: 0, failed: [] };
  }
  const failing = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);
  const failed = [
    ...checkRuns
      .filter((run) => run.status === "completed" && run.conclusion && failing.has(run.conclusion))
      .map((run) => run.name),
    ...statuses.filter((status) => status.state === "failure" || status.state === "error").map((status) => status.context),
  ];
  const pending =
    checkRuns.some((run) => run.status !== "completed") ||
    statuses.some((status) => status.state === "pending");
  if (pending) {
    return { state: "pending", total, failed };
  }
  return { state: failed.length > 0 ? "failure" : "success", total, failed };
}
