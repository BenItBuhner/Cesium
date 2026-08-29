/**
 * Minimal GitHub REST client for the Codespaces device integration.
 *
 * Runs inside Convex actions with a user OAuth token (obtained via Clerk's
 * connected-accounts backend API; the token never reaches Cesium clients).
 * `fetch` is injectable so the whole surface is unit-testable offline.
 */

const GITHUB_API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export class GithubApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GithubApiError";
    this.status = status;
  }
}

export type GithubClient = {
  request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { allow404?: boolean }
  ): Promise<T | null>;
};

export function createGithubClient(
  token: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): GithubClient {
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { allow404?: boolean }
  ): Promise<T | null> {
    const response = await fetchImpl(`${GITHUB_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "cesium-workbench",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 404 && options?.allow404) {
      return null;
    }
    if (!response.ok) {
      let message = `GitHub API ${method} ${path} failed (${response.status})`;
      try {
        const payload = (await response.json()) as { message?: string };
        if (payload?.message) {
          message = `${message}: ${payload.message}`;
        }
      } catch {
        // Non-JSON error body; keep the generic message.
      }
      throw new GithubApiError(response.status, message);
    }
    if (response.status === 204) {
      return null;
    }
    try {
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }
  return { request };
}

/* ----------------------------- repositories ----------------------------- */

export type GithubRepo = {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
  description: string | null;
};

type RawRepo = {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
  pushed_at?: string | null;
  description?: string | null;
};

export async function listRepos(client: GithubClient): Promise<GithubRepo[]> {
  const rows =
    (await client.request<RawRepo[]>(
      "GET",
      "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member"
    )) ?? [];
  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    private: row.private,
    defaultBranch: row.default_branch,
    pushedAt: row.pushed_at ?? null,
    description: row.description ?? null,
  }));
}

export async function getAuthenticatedLogin(client: GithubClient): Promise<string> {
  const user = await client.request<{ login: string }>("GET", "/user");
  if (!user?.login) {
    throw new Error("GitHub token did not resolve to a user.");
  }
  return user.login;
}

/* ------------------------------ codespaces ------------------------------ */

export type GithubCodespaceMachine = {
  name: string;
  displayName: string;
  cpus: number;
  memoryInBytes: number;
  storageInBytes: number;
  prebuildAvailability: string | null;
};

export async function listMachines(
  client: GithubClient,
  owner: string,
  repo: string
): Promise<GithubCodespaceMachine[]> {
  const payload = await client.request<{
    machines: Array<{
      name: string;
      display_name: string;
      cpus: number;
      memory_in_bytes: number;
      storage_in_bytes: number;
      prebuild_availability?: string | null;
    }>;
  }>("GET", `/repos/${owner}/${repo}/codespaces/machines`);
  return (payload?.machines ?? []).map((machine) => ({
    name: machine.name,
    displayName: machine.display_name,
    cpus: machine.cpus,
    memoryInBytes: machine.memory_in_bytes,
    storageInBytes: machine.storage_in_bytes,
    prebuildAvailability: machine.prebuild_availability ?? null,
  }));
}

export type GithubCodespace = {
  name: string;
  displayName: string | null;
  state: string;
  repositoryFullName: string | null;
  machine: string | null;
  gitRef: string | null;
  lastUsedAt: string | null;
  webUrl: string | null;
  idleTimeoutMinutes: number | null;
  retentionExpiresAt: string | null;
};

type RawCodespace = {
  name: string;
  display_name?: string | null;
  state: string;
  repository?: { full_name?: string } | null;
  machine?: { name?: string } | null;
  git_status?: { ref?: string | null } | null;
  last_used_at?: string | null;
  web_url?: string | null;
  idle_timeout_minutes?: number | null;
  retention_expires_at?: string | null;
};

function mapCodespace(raw: RawCodespace): GithubCodespace {
  return {
    name: raw.name,
    displayName: raw.display_name ?? null,
    state: raw.state,
    repositoryFullName: raw.repository?.full_name ?? null,
    machine: raw.machine?.name ?? null,
    gitRef: raw.git_status?.ref ?? null,
    lastUsedAt: raw.last_used_at ?? null,
    webUrl: raw.web_url ?? null,
    idleTimeoutMinutes: raw.idle_timeout_minutes ?? null,
    retentionExpiresAt: raw.retention_expires_at ?? null,
  };
}

export async function getCodespace(
  client: GithubClient,
  codespaceName: string
): Promise<GithubCodespace | null> {
  const raw = await client.request<RawCodespace>(
    "GET",
    `/user/codespaces/${encodeURIComponent(codespaceName)}`,
    undefined,
    { allow404: true }
  );
  return raw ? mapCodespace(raw) : null;
}

export async function createCodespace(
  client: GithubClient,
  input: {
    owner: string;
    repo: string;
    ref?: string;
    machine?: string;
    devcontainerPath: string;
    displayName: string;
    idleTimeoutMinutes?: number;
    retentionPeriodMinutes?: number;
  }
): Promise<GithubCodespace> {
  const raw = await client.request<RawCodespace>(
    "POST",
    `/repos/${input.owner}/${input.repo}/codespaces`,
    {
      ...(input.ref ? { ref: input.ref } : {}),
      ...(input.machine ? { machine: input.machine } : {}),
      devcontainer_path: input.devcontainerPath,
      display_name: input.displayName,
      ...(input.idleTimeoutMinutes
        ? { idle_timeout_minutes: input.idleTimeoutMinutes }
        : {}),
      ...(input.retentionPeriodMinutes
        ? { retention_period_minutes: input.retentionPeriodMinutes }
        : {}),
    }
  );
  if (!raw) {
    throw new Error("GitHub did not return the created codespace.");
  }
  return mapCodespace(raw);
}

export async function startCodespace(
  client: GithubClient,
  codespaceName: string
): Promise<GithubCodespace> {
  const raw = await client.request<RawCodespace>(
    "POST",
    `/user/codespaces/${encodeURIComponent(codespaceName)}/start`
  );
  if (!raw) {
    throw new Error("GitHub did not return the started codespace.");
  }
  return mapCodespace(raw);
}

export async function stopCodespace(
  client: GithubClient,
  codespaceName: string
): Promise<GithubCodespace> {
  const raw = await client.request<RawCodespace>(
    "POST",
    `/user/codespaces/${encodeURIComponent(codespaceName)}/stop`
  );
  if (!raw) {
    throw new Error("GitHub did not return the stopped codespace.");
  }
  return mapCodespace(raw);
}

export async function deleteCodespace(
  client: GithubClient,
  codespaceName: string
): Promise<void> {
  await client.request(
    "DELETE",
    `/user/codespaces/${encodeURIComponent(codespaceName)}`,
    undefined,
    { allow404: true }
  );
}

/* ------------------------- codespaces user secrets ----------------------- */

export type CodespacesPublicKey = { keyId: string; key: string };

export async function getCodespacesPublicKey(
  client: GithubClient
): Promise<CodespacesPublicKey> {
  const payload = await client.request<{ key_id: string; key: string }>(
    "GET",
    "/user/codespaces/secrets/public-key"
  );
  if (!payload?.key_id || !payload.key) {
    throw new Error("GitHub did not return a Codespaces public key.");
  }
  return { keyId: payload.key_id, key: payload.key };
}

/**
 * Upsert a user Codespaces secret without clobbering the repositories other
 * pairings already granted access to: PUT replaces the entire visibility
 * list, so union the existing repository ids with the new one first.
 */
export async function putUserCodespaceSecret(
  client: GithubClient,
  input: {
    name: string;
    encryptedValue: string;
    keyId: string;
    repositoryId: number;
  }
): Promise<void> {
  const existing = await client.request<{
    repositories?: Array<{ id: number }>;
  }>(
    "GET",
    `/user/codespaces/secrets/${encodeURIComponent(input.name)}/repositories`,
    undefined,
    { allow404: true }
  );
  const repositoryIds = new Set<number>(
    (existing?.repositories ?? []).map((repo) => repo.id)
  );
  repositoryIds.add(input.repositoryId);
  await client.request(
    "PUT",
    `/user/codespaces/secrets/${encodeURIComponent(input.name)}`,
    {
      encrypted_value: input.encryptedValue,
      key_id: input.keyId,
      selected_repository_ids: [...repositoryIds],
    }
  );
}

/* ----------------------------- repo contents ----------------------------- */

export type RepoFileState = {
  path: string;
  sha: string;
  content: string;
} | null;

export async function getRepoFile(
  client: GithubClient,
  owner: string,
  repo: string,
  path: string,
  ref?: string
): Promise<RepoFileState> {
  const payload = await client.request<{
    sha: string;
    content?: string;
    encoding?: string;
  }>(
    "GET",
    `/repos/${owner}/${repo}/contents/${encodePath(path)}${
      ref ? `?ref=${encodeURIComponent(ref)}` : ""
    }`,
    undefined,
    { allow404: true }
  );
  if (!payload) {
    return null;
  }
  const content =
    payload.encoding === "base64" && payload.content
      ? decodeBase64(payload.content)
      : "";
  return { path, sha: payload.sha, content };
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export async function getDefaultBranch(
  client: GithubClient,
  owner: string,
  repo: string
): Promise<string> {
  const payload = await client.request<{ default_branch: string }>(
    "GET",
    `/repos/${owner}/${repo}`
  );
  if (!payload?.default_branch) {
    throw new Error("Repository default branch is unknown.");
  }
  return payload.default_branch;
}

/**
 * Commit multiple files in ONE commit via the Git Data API (blobs are inlined
 * into the tree as utf-8 content). Creates or fast-forwards `branch` from
 * `fromBranch` when they differ (the PR flow).
 */
export async function commitFiles(
  client: GithubClient,
  input: {
    owner: string;
    repo: string;
    branch: string;
    fromBranch: string;
    message: string;
    files: Array<{ path: string; content: string; executable?: boolean }>;
  }
): Promise<{ commitSha: string }> {
  const { owner, repo } = input;
  const baseRef = await client.request<{ object: { sha: string } }>(
    "GET",
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(input.fromBranch)}`
  );
  if (!baseRef?.object?.sha) {
    throw new Error(`Branch ${input.fromBranch} was not found.`);
  }
  const baseSha = baseRef.object.sha;

  let headSha = baseSha;
  if (input.branch !== input.fromBranch) {
    const existing = await client.request<{ object: { sha: string } }>(
      "GET",
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(input.branch)}`,
      undefined,
      { allow404: true }
    );
    if (existing?.object?.sha) {
      headSha = existing.object.sha;
    } else {
      await client.request("POST", `/repos/${owner}/${repo}/git/refs`, {
        ref: `refs/heads/${input.branch}`,
        sha: baseSha,
      });
    }
  }

  const headCommit = await client.request<{ tree: { sha: string } }>(
    "GET",
    `/repos/${owner}/${repo}/git/commits/${headSha}`
  );
  if (!headCommit?.tree?.sha) {
    throw new Error("Could not resolve the branch head commit.");
  }

  const tree = await client.request<{ sha: string }>(
    "POST",
    `/repos/${owner}/${repo}/git/trees`,
    {
      base_tree: headCommit.tree.sha,
      tree: input.files.map((file) => ({
        path: file.path,
        mode: file.executable ? "100755" : "100644",
        type: "blob",
        content: file.content,
      })),
    }
  );
  if (!tree?.sha) {
    throw new Error("Could not create the commit tree.");
  }

  const commit = await client.request<{ sha: string }>(
    "POST",
    `/repos/${owner}/${repo}/git/commits`,
    { message: input.message, tree: tree.sha, parents: [headSha] }
  );
  if (!commit?.sha) {
    throw new Error("Could not create the commit.");
  }

  await client.request(
    "PATCH",
    `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(input.branch)}`,
    { sha: commit.sha }
  );
  return { commitSha: commit.sha };
}

export async function findOpenPullRequest(
  client: GithubClient,
  owner: string,
  repo: string,
  headBranch: string
): Promise<{ number: number; htmlUrl: string } | null> {
  const rows =
    (await client.request<Array<{ number: number; html_url: string }>>(
      "GET",
      `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(
        `${owner}:${headBranch}`
      )}`
    )) ?? [];
  const first = rows[0];
  return first ? { number: first.number, htmlUrl: first.html_url } : null;
}

export async function createPullRequest(
  client: GithubClient,
  input: {
    owner: string;
    repo: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
  }
): Promise<{ number: number; htmlUrl: string }> {
  const payload = await client.request<{ number: number; html_url: string }>(
    "POST",
    `/repos/${input.owner}/${input.repo}/pulls`,
    {
      title: input.title,
      head: input.headBranch,
      base: input.baseBranch,
      body: input.body,
    }
  );
  if (!payload?.number) {
    throw new Error("GitHub did not return the created pull request.");
  }
  return { number: payload.number, htmlUrl: payload.html_url };
}

/* --------------------------------- utils --------------------------------- */

export function splitRepoFullName(fullName: string): {
  owner: string;
  repo: string;
} {
  const [owner, repo, ...rest] = fullName.split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`Invalid repository name: ${fullName}`);
  }
  return { owner, repo };
}

function decodeBase64(value: string): string {
  const normalized = value.replace(/\s/g, "");
  if (typeof Buffer !== "undefined") {
    return Buffer.from(normalized, "base64").toString("utf-8");
  }
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}
