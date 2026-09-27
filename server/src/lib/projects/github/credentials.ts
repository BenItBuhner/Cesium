import { spawn } from "node:child_process";
import { getCloudAgentConnection } from "../../cloud-agents/settings.js";

export type GithubCredentialSource = "cloud-agents" | "env" | "gh-cli";

export type GithubCredential = { token: string; source: GithubCredentialSource };

const CACHE_MS = 60_000;
const GH_TIMEOUT_MS = 5_000;

let cached: { at: number; value: GithubCredential | null } | null = null;

/** GitHub's REST base URL; GitHub Enterprise Server is `https://<host>/api/v3`. */
export function githubApiBaseUrl(): string {
  return (process.env.CESIUM_GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/+$/, "");
}

/** The web host PR URLs and remotes use: github.com for the public API, else the API's host. */
export function githubWebHost(): string {
  const base = githubApiBaseUrl();
  try {
    const url = new URL(base);
    return url.hostname === "api.github.com" ? "github.com" : url.hostname;
  } catch {
    return "github.com";
  }
}

function readGhToken(): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const child = spawn("gh", ["auth", "token"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, GH_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0 && stdout.trim() ? stdout.trim() : null);
    });
  });
}

/**
 * The token Projects use for GitHub, in order: the GitHub connection saved in
 * Cloud Agents settings, `CESIUM_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN`,
 * then the host's `gh` login. Cached for a minute; null when none exists.
 */
export async function resolveGithubCredential(options?: { refresh?: boolean }): Promise<GithubCredential | null> {
  if (!options?.refresh && cached && Date.now() - cached.at < CACHE_MS) {
    return cached.value;
  }
  let value: GithubCredential | null = null;
  const connection = await getCloudAgentConnection("github").catch(() => null);
  if (connection?.accessToken) {
    value = { token: connection.accessToken, source: "cloud-agents" };
  } else {
    const envToken = [process.env.CESIUM_GITHUB_TOKEN, process.env.GITHUB_TOKEN, process.env.GH_TOKEN]
      .map((entry) => entry?.trim())
      .find((entry) => entry);
    if (envToken) {
      value = { token: envToken, source: "env" };
    } else {
      const ghToken = await readGhToken();
      value = ghToken ? { token: ghToken, source: "gh-cli" } : null;
    }
  }
  cached = { at: Date.now(), value };
  return value;
}

/** Test hook: forget the cached credential. */
export function resetGithubCredentialCache(): void {
  cached = null;
}
