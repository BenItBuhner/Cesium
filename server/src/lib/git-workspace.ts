import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { normalizeWorkspaceRoot } from "./persistence.js";

const CLONE_TIMEOUT_MS = 900_000;

export function inferCloneDirectoryName(repoUrl: string): string {
  const noGit = repoUrl.trim().replace(/\.git$/i, "");
  const slash = noGit.lastIndexOf("/");
  const colon = noGit.lastIndexOf(":");
  const pick =
    slash >= colon ? noGit.slice(slash + 1) : colon >= 0 ? noGit.slice(colon + 1) : noGit;
  const cleaned = pick.trim();
  return cleaned || "repo";
}

export function assertGitRemoteUrlAllowed(url: string): void {
  const t = url.trim();
  if (!t) {
    throw new Error("Repository URL is required.");
  }
  if (t.length > 2048) {
    throw new Error("Repository URL is too long.");
  }
  if (/[\n\r\0]/.test(t)) {
    throw new Error("Invalid repository URL.");
  }
  if (t.startsWith("git@")) {
    if (!/^git@[^\s]+:.+/.test(t)) {
      throw new Error("SSH remote URL format looks invalid (expected git@host:path).");
    }
    return;
  }
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw new Error("Could not parse repository URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http(s) and git@ SSH remotes are supported.");
  }
}

/**
 * Clones `repoUrl` into `parentPath/directoryName`. Returns the normalized workspace root.
 */
export async function cloneGitRepository(options: {
  repoUrl: string;
  parentPath: string;
  directoryName: string;
}): Promise<string> {
  assertGitRemoteUrlAllowed(options.repoUrl);
  const parent = await normalizeWorkspaceRoot(options.parentPath);
  let dirName = options.directoryName.trim();
  if (!dirName) {
    dirName = inferCloneDirectoryName(options.repoUrl);
  }
  if (!dirName || dirName.includes("/") || dirName.includes(path.sep) || dirName === "." || dirName === "..") {
    throw new Error("Folder name must be a single path segment (no slashes).");
  }

  const target = path.join(parent, dirName);
  try {
    await fs.access(target);
    throw new Error(`Folder already exists: ${target}`);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      // expected — target must not exist
    } else {
      throw error;
    }
  }

  await runGitClone(options.repoUrl.trim(), target);
  return normalizeWorkspaceRoot(target);
}

async function runGitClone(repoUrl: string, targetDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["clone", "--depth", "1", "--", repoUrl, targetDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.stdout?.on("data", () => {
      /* discard */
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Git clone timed out."));
    }, CLONE_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timeout);
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ENOENT")) {
        reject(new Error("`git` was not found. Install Git on the Cesium host."));
        return;
      }
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim();
      reject(new Error(detail || `git clone failed (exit ${code ?? "unknown"})`));
    });
  });
}
