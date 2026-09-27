import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { git, tryGitOutput } from "../helpers/git-fixtures.js";

/**
 * A protocol-faithful GitHub REST double for Projects tests: the endpoints
 * Projects call, GitHub's JSON shapes, status codes (201, 304, 401, 404, 405,
 * 409, 422) and ETags. Branch heads come from a real bare repository, so a
 * worker's `git push` shows up exactly as it would on GitHub, and a merge
 * really squashes the branch into the base.
 */

type Json = Record<string, unknown>;

type FakeUser = { login: string; type: "User" | "Bot" };

type FakeComment = { id: number; body: string; created_at: string; user: FakeUser; html_url: string };
type FakeReview = { id: number; state: string; body: string; submitted_at: string; user: FakeUser; html_url: string };
type FakeReviewComment = FakeComment & { path: string; line: number | null };

type FakePull = {
  number: number;
  title: string;
  body: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  merged_at: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  user: FakeUser;
  created_at: string;
  updated_at: string;
  comments: FakeComment[];
  reviews: FakeReview[];
  reviewComments: FakeReviewComment[];
  mergeable: boolean | null;
};

type FakeRepo = { fullName: string; bareDir: string; defaultBranch: string; pulls: FakePull[] };

export type FakeCheckRun = { name: string; status: "queued" | "in_progress" | "completed"; conclusion: string | null };

export type FakeGithubRequest = { method: string; path: string; body: Json | null; status: number };

let nextId = 1000;

function now(): string {
  return new Date().toISOString();
}

export type FakeGithub = {
  baseUrl: string;
  token: string;
  requests: FakeGithubRequest[];
  pulls(repo: string): FakePull[];
  pull(repo: string, number: number): FakePull;
  createPullDirect(repo: string, input: { head: string; base?: string; title: string; body?: string; login?: string }): Promise<FakePull>;
  addComment(repo: string, number: number, login: string, body: string): void;
  addReview(repo: string, number: number, login: string, state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED", body: string): void;
  addReviewComment(repo: string, number: number, login: string, filePath: string, line: number, body: string): void;
  setChecks(repo: string, sha: string, runs: FakeCheckRun[]): void;
  mergeExternally(repo: string, number: number): Promise<string>;
  closeExternally(repo: string, number: number): void;
  branchHead(repo: string, branch: string): Promise<string | null>;
  close(): Promise<void>;
};

export async function startFakeGithub(input: {
  token: string;
  repos: Record<string, { bareDir: string; defaultBranch?: string }>;
}): Promise<FakeGithub> {
  const repos = new Map<string, FakeRepo>();
  for (const [fullName, config] of Object.entries(input.repos)) {
    repos.set(fullName.toLowerCase(), {
      fullName,
      bareDir: config.bareDir,
      defaultBranch: config.defaultBranch ?? "main",
      pulls: [],
    });
  }
  const checks = new Map<string, FakeCheckRun[]>();
  const requests: FakeGithubRequest[] = [];

  function repoOf(fullName: string): FakeRepo {
    const repo = repos.get(fullName.toLowerCase());
    if (!repo) {
      throw new Error(`fake github: unknown repo ${fullName}`);
    }
    return repo;
  }

  async function branchHead(repo: FakeRepo, branch: string): Promise<string | null> {
    return tryGitOutput(repo.bareDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  }

  async function refreshPull(repo: FakeRepo, pull: FakePull): Promise<void> {
    if (pull.state !== "open") {
      return;
    }
    const head = await branchHead(repo, pull.headRef);
    if (head && head !== pull.headSha) {
      pull.headSha = head;
      pull.updated_at = now();
    }
  }

  function pullJson(repo: FakeRepo, pull: FakePull): Json {
    return {
      url: `https://api.github.com/repos/${repo.fullName}/pulls/${pull.number}`,
      html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
      number: pull.number,
      state: pull.state,
      title: pull.title,
      body: pull.body,
      draft: pull.draft,
      merged: pull.merged,
      merged_at: pull.merged_at,
      mergeable: pull.state === "open" ? pull.mergeable : null,
      user: pull.user,
      created_at: pull.created_at,
      updated_at: pull.updated_at,
      head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.fullName.split("/")[0]}:${pull.headRef}`, repo: { full_name: repo.fullName } },
      base: { ref: pull.baseRef, repo: { full_name: repo.fullName } },
    };
  }

  async function squashMerge(repo: FakeRepo, pull: FakePull, title: string): Promise<string> {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "fake-github-merge-"));
    try {
      await git(scratch, ["clone", "--quiet", "--branch", pull.baseRef, repo.bareDir, "work"]);
      const work = path.join(scratch, "work");
      await git(work, ["fetch", "--quiet", "origin", pull.headRef]);
      await git(work, ["merge", "--squash", "FETCH_HEAD"]);
      await git(work, ["commit", "-m", title]);
      await git(work, ["push", "--quiet", "origin", pull.baseRef]);
      return await git(work, ["rev-parse", "HEAD"]);
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }

  function send(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, record: FakeGithubRequest): void {
    record.status = status;
    if (status === 204) {
      res.writeHead(204);
      res.end();
      return;
    }
    const text = JSON.stringify(body);
    const etag = `"${createHash("sha1").update(text).digest("hex")}"`;
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
    };
    if (req.method === "GET" && status === 200) {
      headers.etag = etag;
      if (req.headers["if-none-match"] === etag) {
        record.status = 304;
        res.writeHead(304, headers);
        res.end();
        return;
      }
    }
    res.writeHead(status, headers);
    res.end(text);
  }

  async function handle(req: IncomingMessage, res: ServerResponse, body: Json | null): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const record: FakeGithubRequest = { method: req.method ?? "GET", path: `${url.pathname}${url.search}`, body, status: 0 };
    requests.push(record);
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${input.token}` && auth !== `token ${input.token}`) {
      send(req, res, 401, { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" }, record);
      return;
    }
    const match = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    const repo = match ? repos.get(`${match[1]}/${match[2]}`.toLowerCase()) : undefined;
    if (!match || !repo) {
      send(req, res, 404, { message: "Not Found" }, record);
      return;
    }
    const rest = match[3] ?? "";
    const method = req.method ?? "GET";
    if (method === "GET" && rest === "") {
      send(req, res, 200, { full_name: repo.fullName, default_branch: repo.defaultBranch }, record);
      return;
    }
    const branch = rest.match(/^\/branches\/(.+)$/);
    if (method === "GET" && branch) {
      const name = decodeURIComponent(branch[1]!);
      const sha = await branchHead(repo, name);
      if (!sha) {
        send(req, res, 404, { message: "Branch not found" }, record);
        return;
      }
      send(req, res, 200, { name, commit: { sha } }, record);
      return;
    }
    const compare = rest.match(/^\/compare\/(.+)$/);
    if (method === "GET" && compare) {
      const [base, head] = decodeURIComponent(compare[1]!).split("...");
      const ahead = await tryGitOutput(repo.bareDir, ["rev-list", "--count", `refs/heads/${base}..refs/heads/${head}`]);
      if (ahead == null) {
        send(req, res, 404, { message: "Not Found" }, record);
        return;
      }
      send(req, res, 200, { ahead_by: Number(ahead), status: Number(ahead) > 0 ? "ahead" : "identical" }, record);
      return;
    }
    if (rest === "/pulls" && method === "GET") {
      const head = url.searchParams.get("head");
      const state = url.searchParams.get("state") ?? "open";
      for (const pull of repo.pulls) {
        await refreshPull(repo, pull);
      }
      const owner = repo.fullName.split("/")[0]!;
      const list = repo.pulls.filter(
        (pull) =>
          (state === "all" || pull.state === state) && (!head || head === `${owner}:${pull.headRef}`)
      );
      send(req, res, 200, list.map((pull) => pullJson(repo, pull)), record);
      return;
    }
    if (rest === "/pulls" && method === "POST") {
      const headRef = String(body?.head ?? "");
      const baseRef = String(body?.base ?? repo.defaultBranch);
      const headSha = await branchHead(repo, headRef);
      if (!headSha || !(await branchHead(repo, baseRef))) {
        send(req, res, 422, { message: "Validation Failed", errors: [{ field: "head", code: "invalid" }] }, record);
        return;
      }
      if (repo.pulls.some((pull) => pull.state === "open" && pull.headRef === headRef)) {
        send(req, res, 422, { message: "Validation Failed", errors: [{ message: `A pull request already exists for ${headRef}.` }] }, record);
        return;
      }
      const pull = newPull(repo, { headRef, headSha, baseRef, title: String(body?.title ?? headRef), body: String(body?.body ?? ""), draft: body?.draft === true, login: "cesium-bot" });
      send(req, res, 201, pullJson(repo, pull), record);
      return;
    }
    const pullMatch = rest.match(/^\/pulls\/(\d+)(\/.*)?$/);
    const issueComments = rest.match(/^\/issues\/(\d+)\/comments$/);
    const commitMatch = rest.match(/^\/commits\/([0-9a-f]{7,40})\/(check-runs|status)$/);
    if (issueComments && method === "GET") {
      const pull = repo.pulls.find((entry) => entry.number === Number(issueComments[1]));
      send(req, res, pull ? 200 : 404, pull ? pull.comments : { message: "Not Found" }, record);
      return;
    }
    if (commitMatch && method === "GET") {
      const runs = checks.get(`${repo.fullName.toLowerCase()}@${commitMatch[1]}`) ?? [];
      if (commitMatch[2] === "check-runs") {
        send(req, res, 200, { total_count: runs.length, check_runs: runs.map((run, index) => ({ id: index + 1, ...run })) }, record);
      } else {
        send(req, res, 200, { state: runs.length === 0 ? "pending" : "success", statuses: [], sha: commitMatch[1], total_count: 0 }, record);
      }
      return;
    }
    if (pullMatch) {
      const pull = repo.pulls.find((entry) => entry.number === Number(pullMatch[1]));
      if (!pull) {
        send(req, res, 404, { message: "Not Found" }, record);
        return;
      }
      await refreshPull(repo, pull);
      const sub = pullMatch[2] ?? "";
      if (method === "GET" && sub === "") {
        send(req, res, 200, pullJson(repo, pull), record);
        return;
      }
      if (method === "GET" && sub === "/reviews") {
        send(req, res, 200, pull.reviews, record);
        return;
      }
      if (method === "GET" && sub === "/comments") {
        send(req, res, 200, pull.reviewComments, record);
        return;
      }
      if (method === "PUT" && sub === "/merge") {
        if (pull.state !== "open" || pull.merged) {
          send(req, res, 405, { message: "Pull Request is not mergeable" }, record);
          return;
        }
        if (body?.sha && body.sha !== pull.headSha) {
          send(req, res, 409, { message: "Head branch was modified. Review and try the merge again." }, record);
          return;
        }
        const title = String(body?.commit_title ?? `${pull.title} (#${pull.number})`);
        const sha = await squashMerge(repo, pull, title);
        pull.state = "closed";
        pull.merged = true;
        pull.merged_at = now();
        pull.updated_at = now();
        send(req, res, 200, { sha, merged: true, message: "Pull Request successfully merged" }, record);
        return;
      }
    }
    send(req, res, 404, { message: "Not Found" }, record);
  }

  function newPull(
    repo: FakeRepo,
    input: { headRef: string; headSha: string; baseRef: string; title: string; body: string; draft: boolean; login: string }
  ): FakePull {
    const pull: FakePull = {
      number: repo.pulls.length + 1,
      title: input.title,
      body: input.body,
      draft: input.draft,
      state: "open",
      merged: false,
      merged_at: null,
      headRef: input.headRef,
      headSha: input.headSha,
      baseRef: input.baseRef,
      user: { login: input.login, type: "User" },
      created_at: now(),
      updated_at: now(),
      comments: [],
      reviews: [],
      reviewComments: [],
      mergeable: true,
    };
    repo.pulls.push(pull);
    return pull;
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Json | null = null;
      try {
        body = raw ? (JSON.parse(raw) as Json) : null;
      } catch {
        body = null;
      }
      handle(req, res, body).catch((error) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const user = (login: string): FakeUser => ({ login, type: login.endsWith("[bot]") ? "Bot" : "User" });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token: input.token,
    requests,
    pulls: (fullName) => repoOf(fullName).pulls,
    pull: (fullName, number) => {
      const pull = repoOf(fullName).pulls.find((entry) => entry.number === number);
      if (!pull) throw new Error(`fake github: no pull #${number}`);
      return pull;
    },
    async createPullDirect(fullName, spec) {
      const repo = repoOf(fullName);
      const headSha = await branchHead(repo, spec.head);
      if (!headSha) throw new Error(`fake github: branch ${spec.head} is not pushed`);
      return newPull(repo, {
        headRef: spec.head,
        headSha,
        baseRef: spec.base ?? repo.defaultBranch,
        title: spec.title,
        body: spec.body ?? "",
        draft: false,
        login: spec.login ?? "worker",
      });
    },
    addComment(fullName, number, login, body) {
      const pull = this.pull(fullName, number);
      const id = nextId++;
      pull.comments.push({ id, body, created_at: now(), user: user(login), html_url: `https://github.com/${fullName}/pull/${number}#issuecomment-${id}` });
      pull.updated_at = now();
    },
    addReview(fullName, number, login, state, body) {
      const pull = this.pull(fullName, number);
      const id = nextId++;
      pull.reviews.push({ id, state, body, submitted_at: now(), user: user(login), html_url: `https://github.com/${fullName}/pull/${number}#pullrequestreview-${id}` });
      pull.updated_at = now();
    },
    addReviewComment(fullName, number, login, filePath, line, body) {
      const pull = this.pull(fullName, number);
      const id = nextId++;
      pull.reviewComments.push({ id, body, created_at: now(), user: user(login), html_url: `https://github.com/${fullName}/pull/${number}#discussion_r${id}`, path: filePath, line });
      pull.updated_at = now();
    },
    setChecks(fullName, sha, runs) {
      checks.set(`${fullName.toLowerCase()}@${sha}`, runs);
    },
    async mergeExternally(fullName, number) {
      const repo = repoOf(fullName);
      const pull = this.pull(fullName, number);
      await refreshPull(repo, pull);
      const sha = await squashMerge(repo, pull, `${pull.title} (#${number})`);
      pull.state = "closed";
      pull.merged = true;
      pull.merged_at = now();
      pull.updated_at = now();
      return sha;
    },
    closeExternally(fullName, number) {
      const pull = this.pull(fullName, number);
      pull.state = "closed";
      pull.updated_at = now();
    },
    branchHead: (fullName, branch) => branchHead(repoOf(fullName), branch),
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
