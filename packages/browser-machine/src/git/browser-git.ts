/**
 * Client-side git built on isomorphic-git over the VFS.
 *
 * Network paths:
 *  - Real smart-HTTP clone/fetch/push goes through the same-origin
 *    `/api/git-proxy` Next.js route (GitHub's git endpoints do not send CORS
 *    headers, so the browser cannot talk to them directly).
 *  - Zero-proxy fallback: GitHub REST tarball import (api.github.com is
 *    CORS-enabled), which materializes the tree and creates a fresh local
 *    git history via `init` + initial commit.
 */
import git from "isomorphic-git";
import webHttp from "isomorphic-git/http/web";
import type { GitBranchInfo, GitWorkspaceStatus, WorkspaceRecord } from "@cesium/core";
import { basename, joinPath, normalizePath } from "../paths";
import { createPromisesFs, type Vfs } from "../vfs";
import { readDoc, writeDoc } from "../stores/kv-docs";

const GITHUB_TOKEN_KEY = "github:token";
const GIT_AUTHOR_KEY = "git:author";

export type GitAuthor = { name: string; email: string };

const DEFAULT_AUTHOR: GitAuthor = {
  name: "Cesium Browser",
  email: "browser@cesium.local",
};

/** Same-origin proxy that relays git smart-HTTP with CORS (see src/app/api/git-proxy). */
export function defaultCorsProxy(): string | undefined {
  if (typeof location === "undefined") return undefined;
  if (location.protocol === "http:" || location.protocol === "https:") {
    return `${location.origin}/api/git-proxy`;
  }
  return undefined;
}

export async function getStoredGithubToken(): Promise<string | null> {
  return (await readDoc<string>(GITHUB_TOKEN_KEY)) ?? null;
}

export async function setStoredGithubToken(token: string | null): Promise<void> {
  await writeDoc(GITHUB_TOKEN_KEY, token);
}

function parseGithubRepo(repoUrl: string): { owner: string; repo: string } | null {
  const match = repoUrl.match(
    /^(?:https?:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i
  );
  if (!match) return null;
  return { owner: match[1] as string, repo: match[2] as string };
}

function normalizeRepositoryId(repoUrl: string): string {
  return repoUrl
    .replace(/^git@github\.com:/i, "github.com/")
    .replace(/^https?:\/\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

import { extractTarball } from "../tar";

export class BrowserGit {
  readonly fs: ReturnType<typeof createPromisesFs>;

  constructor(private readonly vfs: Vfs) {
    this.fs = createPromisesFs(vfs);
  }

  private async onAuth(): Promise<{ username: string; password?: string } | undefined> {
    const token = await getStoredGithubToken();
    if (!token) return undefined;
    return { username: "x-access-token", password: token };
  }

  async getAuthor(): Promise<GitAuthor> {
    return (await readDoc<GitAuthor>(GIT_AUTHOR_KEY)) ?? DEFAULT_AUTHOR;
  }

  async setAuthor(author: GitAuthor): Promise<void> {
    await writeDoc(GIT_AUTHOR_KEY, author);
  }

  isGitRepo(root: string): boolean {
    return this.vfs.exists(joinPath(root, ".git"));
  }

  /** Real smart-HTTP clone through the CORS proxy. */
  async clone(input: {
    repoUrl: string;
    parentPath: string;
    directoryName: string;
    ref?: string;
    depth?: number;
  }): Promise<string> {
    const repoUrl = input.repoUrl.trim();
    const parent = normalizePath(input.parentPath || "/workspaces");
    const directoryName =
      input.directoryName?.trim() ||
      basename(repoUrl.replace(/\.git$/i, "")) ||
      `repo-${Date.now().toString(36)}`;
    const dir = joinPath(parent, directoryName);
    if (this.vfs.exists(dir) && this.vfs.listChildren(dir).length > 0) {
      throw new Error(`Target directory is not empty: ${dir}`);
    }
    this.vfs.mkdir(dir, { recursive: true });

    const corsProxy = defaultCorsProxy();
    const token = await getStoredGithubToken();
    try {
      await git.clone({
        fs: this.fs,
        http: webHttp,
        dir,
        url: repoUrl,
        ...(corsProxy ? { corsProxy } : {}),
        singleBranch: true,
        depth: input.depth ?? 50,
        ...(input.ref ? { ref: input.ref } : {}),
        onAuth: token
          ? () => ({ username: "x-access-token", password: token })
          : undefined,
      });
      return dir;
    } catch (error) {
      // Zero-proxy fallback: GitHub REST tarball import.
      const imported = await this.importGithubTarball({ repoUrl, dir }).catch(() => false);
      if (imported) {
        return dir;
      }
      this.vfs.rm(dir);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Clone failed: ${message}. For private repos, save a GitHub token in the browser machine settings.`
      );
    }
  }

  /** CORS-friendly fallback: import the repo tarball via api.github.com. */
  private async importGithubTarball(input: { repoUrl: string; dir: string }): Promise<boolean> {
    const parsed = parseGithubRepo(input.repoUrl);
    if (!parsed) return false;
    const token = await getStoredGithubToken();
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
    const response = await fetch(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/tarball`,
      { headers }
    );
    if (!response.ok) return false;
    const bytes = new Uint8Array(await response.arrayBuffer());
    let sawEntry = false;
    await extractTarball(bytes, (rawPath, data, isDir) => {
      // GitHub tarballs prefix every entry with `${owner}-${repo}-${sha}/`.
      const parts = rawPath.split("/").slice(1);
      if (parts.length === 0) return;
      const relative = parts.join("/");
      if (!relative) return;
      sawEntry = true;
      const target = joinPath(input.dir, relative);
      if (isDir) {
        if (!this.vfs.exists(target)) this.vfs.mkdir(target, { recursive: true });
        return;
      }
      const parentDir = target.slice(0, target.lastIndexOf("/")) || "/";
      if (!this.vfs.exists(parentDir)) this.vfs.mkdir(parentDir, { recursive: true });
      this.vfs.writeFile(target, data.slice());
    });
    if (!sawEntry) return false;
    // Materialize a local history so git status/commit work offline.
    await git.init({ fs: this.fs, dir: input.dir, defaultBranch: "main" });
    await git.add({ fs: this.fs, dir: input.dir, filepath: "." });
    const author = await this.getAuthor();
    await git.commit({
      fs: this.fs,
      dir: input.dir,
      message: `Import ${parsed.owner}/${parsed.repo} tarball snapshot`,
      author,
    });
    await git.addRemote({
      fs: this.fs,
      dir: input.dir,
      remote: "origin",
      url: `https://github.com/${parsed.owner}/${parsed.repo}.git`,
      force: true,
    });
    return true;
  }

  async init(workspace: WorkspaceRecord): Promise<GitWorkspaceStatus> {
    await git.init({ fs: this.fs, dir: workspace.root, defaultBranch: "main" });
    return this.status(workspace);
  }

  async switchBranch(workspace: WorkspaceRecord, branch: string): Promise<GitWorkspaceStatus> {
    const localBranches = await git.listBranches({ fs: this.fs, dir: workspace.root });
    if (!localBranches.includes(branch)) {
      await git.branch({ fs: this.fs, dir: workspace.root, ref: branch, checkout: false });
    }
    await git.checkout({ fs: this.fs, dir: workspace.root, ref: branch });
    return this.status(workspace);
  }

  /** Cheap dirty check: bounded status matrix (skipped for very large repos). */
  private async isDirty(dir: string): Promise<boolean> {
    try {
      const matrix = await git.statusMatrix({ fs: this.fs, dir });
      return matrix.some(
        ([, head, workdir, stage]) => head !== 1 || workdir !== 1 || stage !== 1
      );
    } catch {
      return false;
    }
  }

  async status(workspace: WorkspaceRecord): Promise<GitWorkspaceStatus> {
    if (!this.isGitRepo(workspace.root)) {
      return {
        isGitRepo: false,
        root: workspace.root,
        branches: [],
        worktrees: [],
      };
    }
    try {
      const dir = workspace.root;
      const [currentBranch, localBranches, remoteBranches, remotes] = await Promise.all([
        git.currentBranch({ fs: this.fs, dir, fullname: false }).catch(() => null),
        git.listBranches({ fs: this.fs, dir }).catch(() => [] as string[]),
        git.listBranches({ fs: this.fs, dir, remote: "origin" }).catch(() => [] as string[]),
        git.listRemotes({ fs: this.fs, dir }).catch(() => [] as Array<{ remote: string; url: string }>),
      ]);
      const fileCount = this.vfs.du(dir);
      const dirty = fileCount < 30_000_000 ? await this.isDirty(dir) : false;
      const branches: GitBranchInfo[] = [
        ...localBranches.map((name) => ({
          name,
          type: "local" as const,
          current: name === currentBranch,
        })),
        ...remoteBranches
          .filter((name) => name !== "HEAD")
          .map((name) => ({
            name: `origin/${name}`,
            type: "remote" as const,
            current: false,
          })),
      ];
      const origin = remotes.find((remote) => remote.remote === "origin");
      const repositoryId = origin ? normalizeRepositoryId(origin.url) : undefined;
      return {
        isGitRepo: true,
        root: dir,
        repoRoot: dir,
        repoKey: repositoryId ?? dir,
        repositoryId,
        currentBranch: currentBranch ?? null,
        detached: currentBranch === null,
        dirty,
        aheadBehind: null,
        branches,
        worktrees: [
          {
            path: dir,
            branch: currentBranch ?? null,
            head: null,
            detached: currentBranch === null,
            bare: false,
            current: true,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
          },
        ],
      };
    } catch (error) {
      return {
        isGitRepo: true,
        root: workspace.root,
        branches: [],
        worktrees: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async railRepositoryInfo(workspace: WorkspaceRecord): Promise<Record<string, unknown>> {
    if (!this.isGitRepo(workspace.root)) {
      return { isGitRepo: false };
    }
    const [currentBranch, remotes] = await Promise.all([
      git.currentBranch({ fs: this.fs, dir: workspace.root, fullname: false }).catch(() => null),
      git
        .listRemotes({ fs: this.fs, dir: workspace.root })
        .catch(() => [] as Array<{ remote: string; url: string }>),
    ]);
    const origin = remotes.find((remote) => remote.remote === "origin");
    const repositoryId = origin ? normalizeRepositoryId(origin.url) : undefined;
    return {
      isGitRepo: true,
      repoRoot: workspace.root,
      repoKey: repositoryId ?? workspace.root,
      repositoryId,
      currentBranch: currentBranch ?? null,
    };
  }

  // ---- Plumbing used by the shell `git` command and agent tools ----

  async add(dir: string, filepath: string): Promise<void> {
    if (filepath === "." || filepath === "-A" || filepath === "--all") {
      await git.add({ fs: this.fs, dir, filepath: "." });
      return;
    }
    await git.add({ fs: this.fs, dir, filepath });
  }

  async commit(dir: string, message: string): Promise<string> {
    const author = await this.getAuthor();
    return git.commit({ fs: this.fs, dir, message, author });
  }

  async currentBranch(dir: string): Promise<string | null> {
    return (await git.currentBranch({ fs: this.fs, dir, fullname: false })) ?? null;
  }

  async listBranches(dir: string): Promise<string[]> {
    return git.listBranches({ fs: this.fs, dir });
  }

  async createBranch(dir: string, ref: string, checkout = true): Promise<void> {
    await git.branch({ fs: this.fs, dir, ref, checkout });
  }

  async checkout(dir: string, ref: string): Promise<void> {
    await git.checkout({ fs: this.fs, dir, ref });
  }

  async statusMatrix(dir: string): Promise<Array<[string, number, number, number]>> {
    return git.statusMatrix({ fs: this.fs, dir }) as Promise<
      Array<[string, number, number, number]>
    >;
  }

  async log(
    dir: string,
    depth = 20
  ): Promise<Array<{ oid: string; message: string; author: string; when: number }>> {
    const entries = await git.log({ fs: this.fs, dir, depth });
    return entries.map((entry) => ({
      oid: entry.oid,
      message: entry.commit.message,
      author: entry.commit.author.name,
      when: entry.commit.author.timestamp * 1000,
    }));
  }

  async push(dir: string, options?: { remote?: string; ref?: string; force?: boolean }): Promise<void> {
    const corsProxy = defaultCorsProxy();
    const result = await git.push({
      fs: this.fs,
      http: webHttp,
      dir,
      remote: options?.remote ?? "origin",
      ...(options?.ref ? { ref: options.ref } : {}),
      ...(corsProxy ? { corsProxy } : {}),
      force: options?.force ?? false,
      onAuth: () => this.onAuth(),
    });
    if (result && result.ok === false) {
      throw new Error(`Push failed: ${result.error ?? "unknown error"}`);
    }
  }

  async pull(dir: string): Promise<void> {
    const corsProxy = defaultCorsProxy();
    const author = await this.getAuthor();
    await git.pull({
      fs: this.fs,
      http: webHttp,
      dir,
      ...(corsProxy ? { corsProxy } : {}),
      singleBranch: true,
      author,
      onAuth: () => this.onAuth(),
    });
  }

  async fetch(dir: string): Promise<void> {
    const corsProxy = defaultCorsProxy();
    await git.fetch({
      fs: this.fs,
      http: webHttp,
      dir,
      ...(corsProxy ? { corsProxy } : {}),
      onAuth: () => this.onAuth(),
    });
  }
}
