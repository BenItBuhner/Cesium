import { spawn } from "node:child_process";
import type {
  CesiumUpdateChannelId,
  CesiumUpdateGitStatus,
  CesiumUpdateRelease,
} from "@cesium/contracts";
import { parseSemver, compareSemver, isNewerVersion } from "./semver.js";

export const DEFAULT_GITHUB_REPO = "BenItBuhner/Cesium";

const USER_AGENT = "cesium-update-checker";
const FEED_TIMEOUT_MS = 15_000;
const GIT_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Release tag prefixes, longest-prefix first so `mobile-v1.2.3` never matches
 * the bare `v` prefix. `v*` tags are unified app releases covering the server
 * and web client together.
 */
const TAG_CHANNELS: Array<{ prefix: string; channel: CesiumUpdateChannelId }> = [
  { prefix: "mobile-v", channel: "mobile" },
  { prefix: "desktop-v", channel: "desktop" },
  { prefix: "server-v", channel: "server" },
  { prefix: "v", channel: "app" },
];

export function resolveGithubRepo(env: Record<string, string | undefined> = process.env): string {
  return env.CESIUM_UPDATE_GITHUB_REPO?.trim() || DEFAULT_GITHUB_REPO;
}

export function resolveGithubToken(
  env: Record<string, string | undefined> = process.env
): string | null {
  return (
    env.CESIUM_UPDATE_GITHUB_TOKEN?.trim() ||
    env.CESIUM_GITHUB_TOKEN?.trim() ||
    env.GITHUB_TOKEN?.trim() ||
    env.GH_TOKEN?.trim() ||
    null
  );
}

export function channelForTag(tag: string): {
  channel: CesiumUpdateChannelId;
  version: string;
} | null {
  for (const { prefix, channel } of TAG_CHANNELS) {
    if (!tag.startsWith(prefix)) continue;
    const version = tag.slice(prefix.length);
    if (parseSemver(version)) {
      return { channel, version };
    }
  }
  return null;
}

type GithubReleaseJson = {
  tag_name?: string;
  name?: string | null;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  html_url?: string | null;
  assets?: Array<{
    name?: string;
    size?: number;
    browser_download_url?: string;
    content_type?: string | null;
  }>;
};

/**
 * Bucket raw GitHub release JSON into the newest release per channel.
 * Drafts are always skipped; prereleases only count when requested.
 */
export function bucketGithubReleases(
  releases: GithubReleaseJson[],
  options: { includePrereleases: boolean }
): Partial<Record<CesiumUpdateChannelId, CesiumUpdateRelease>> {
  const buckets: Partial<Record<CesiumUpdateChannelId, CesiumUpdateRelease>> = {};
  for (const release of releases) {
    if (!release || release.draft) continue;
    if (release.prerelease && !options.includePrereleases) continue;
    const tag = release.tag_name ?? "";
    const match = channelForTag(tag);
    if (!match) continue;
    const candidate: CesiumUpdateRelease = {
      channel: match.channel,
      tag,
      version: match.version.replace(/^v/, ""),
      name: release.name ?? null,
      prerelease: Boolean(release.prerelease),
      publishedAt: release.published_at ?? null,
      htmlUrl: release.html_url ?? null,
      notes: release.body ?? null,
      assets: (release.assets ?? [])
        .filter((asset) => asset.name && asset.browser_download_url)
        .map((asset) => ({
          name: asset.name as string,
          size: typeof asset.size === "number" ? asset.size : 0,
          downloadUrl: asset.browser_download_url as string,
          contentType: asset.content_type ?? null,
        })),
    };
    const existing = buckets[match.channel];
    if (!existing) {
      buckets[match.channel] = candidate;
      continue;
    }
    const existingVersion = parseSemver(existing.version);
    const candidateVersion = parseSemver(candidate.version);
    if (
      existingVersion &&
      candidateVersion &&
      compareSemver(candidateVersion, existingVersion) > 0
    ) {
      buckets[match.channel] = candidate;
    }
  }
  return buckets;
}

export async function fetchGithubReleases(options: {
  repo: string;
  token: string | null;
  includePrereleases: boolean;
}): Promise<{
  channels: Partial<Record<CesiumUpdateChannelId, CesiumUpdateRelease>>;
  error: string | null;
}> {
  const url = `https://api.github.com/repos/${options.repo}/releases?per_page=30`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT,
    "x-github-api-version": "2022-11-28",
  };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail =
        response.status === 404
          ? "repository not found or token lacks access"
          : response.status === 403 || response.status === 429
            ? "rate limited by GitHub - set CESIUM_GITHUB_TOKEN"
            : `HTTP ${response.status}`;
      return { channels: {}, error: `GitHub releases request failed: ${detail}` };
    }
    const payload = (await response.json()) as GithubReleaseJson[];
    if (!Array.isArray(payload)) {
      return { channels: {}, error: "GitHub releases response was not a list" };
    }
    return {
      channels: bucketGithubReleases(payload, {
        includePrereleases: options.includePrereleases,
      }),
      error: null,
    };
  } catch (error) {
    return { channels: {}, error: `GitHub releases request failed: ${(error as Error).message}` };
  }
}

export function resolveNpmPackage(
  env: Record<string, string | undefined> = process.env
): string | null {
  return env.CESIUM_UPDATE_NPM_PACKAGE?.trim() || null;
}

type NpmPackumentJson = {
  "dist-tags"?: Record<string, string>;
};

export async function fetchNpmLatestVersion(options: {
  packageName: string;
  distTag?: string;
  registryBaseUrl?: string;
}): Promise<{ latestVersion: string | null; error: string | null }> {
  const registry = (options.registryBaseUrl ?? "https://registry.npmjs.org").replace(/\/$/, "");
  const encoded = options.packageName.replace("/", "%2F");
  try {
    const response = await fetch(`${registry}/${encoded}`, {
      headers: {
        // Abbreviated packument keeps the response tiny (dist-tags + versions).
        accept: "application/vnd.npm.install-v1+json",
        "user-agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        latestVersion: null,
        error:
          response.status === 404
            ? `npm package ${options.packageName} was not found`
            : `npm registry request failed: HTTP ${response.status}`,
      };
    }
    const payload = (await response.json()) as NpmPackumentJson;
    const latest = payload["dist-tags"]?.[options.distTag ?? "latest"] ?? null;
    return { latestVersion: latest, error: null };
  } catch (error) {
    return {
      latestVersion: null,
      error: `npm registry request failed: ${(error as Error).message}`,
    };
  }
}

export function isNpmUpdateAvailable(
  latestVersion: string | null,
  currentVersion: string
): boolean {
  if (!latestVersion) return false;
  return isNewerVersion(latestVersion, currentVersion);
}

function runGit(
  args: string[],
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), GIT_COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ code: -1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * For git-backed installs (source checkouts and installer-provisioned
 * servers) the release feed alone cannot say whether the tree is current -
 * they track a branch, not tagged artifacts. Fetch the remote branch head and
 * count how many commits we are behind.
 */
export async function fetchGitUpdateStatus(repoRoot: string): Promise<CesiumUpdateGitStatus> {
  const status: CesiumUpdateGitStatus = {
    branch: null,
    commit: null,
    remoteCommit: null,
    behind: null,
    updateAvailable: false,
    error: null,
  };
  const branchResult = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  if (branchResult.code !== 0) {
    status.error = branchResult.stderr.trim() || "not a git repository";
    return status;
  }
  status.branch = branchResult.stdout.trim();
  const headResult = await runGit(["rev-parse", "HEAD"], repoRoot);
  if (headResult.code === 0) {
    status.commit = headResult.stdout.trim();
  }

  const trackedBranch =
    process.env.CESIUM_REPO_BRANCH?.trim() ||
    (status.branch !== "HEAD" ? status.branch : "main");
  const fetchResult = await runGit(
    ["fetch", "--quiet", "origin", trackedBranch],
    repoRoot
  );
  if (fetchResult.code !== 0) {
    status.error = fetchResult.stderr.trim() || "git fetch failed";
    return status;
  }
  const remoteResult = await runGit(["rev-parse", "FETCH_HEAD"], repoRoot);
  if (remoteResult.code === 0) {
    status.remoteCommit = remoteResult.stdout.trim();
  }
  const behindResult = await runGit(
    ["rev-list", "--count", "HEAD..FETCH_HEAD"],
    repoRoot
  );
  if (behindResult.code === 0) {
    const behind = Number.parseInt(behindResult.stdout.trim(), 10);
    status.behind = Number.isFinite(behind) ? behind : null;
    status.updateAvailable = (status.behind ?? 0) > 0;
  }
  return status;
}
