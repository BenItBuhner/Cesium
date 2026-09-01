#!/usr/bin/env node
/**
 * Mock GitHub API for end-to-end Codespaces device testing.
 *
 * Stands in for api.github.com with enough fidelity to exercise Cesium's
 * REAL Convex actions and client flows unmodified (point the deployment at
 * it with CESIUM_GITHUB_API_URL):
 *
 * - repos, machines, contents + Git Data API (branch file store, so the
 *   devcontainer commit/PR flow works for real),
 * - Codespaces user secrets with a REAL libsodium keypair: sealed values
 *   uploaded by the Convex action are unsealed here and injected into the
 *   engine process - the engine sign-in only works if the entire secrets
 *   pipeline is correct,
 * - codespace lifecycle with timed state transitions (Queued -> Provisioning
 *   -> Available) that actually SPAWNS a real Cesium engine process on
 *   start and kills it on stop - so wake/stop flows run against a live
 *   engine, exactly like a real codespace's postStartCommand would.
 *
 * Usage:
 *   node test/mock-github-codespaces-server.mjs
 * Env:
 *   MOCK_GITHUB_PORT   (default 9310)
 *   MOCK_ENGINE_PORT   (default 9110)  - matches CESIUM_CODESPACES_ENGINE_URL_TEMPLATE
 *   MOCK_ENGINE_HOME   (default /tmp/cesium-mock-codespace)
 *   MOCK_BUN_BIN       (default ~/.bun/bin/bun)
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import sodium from "libsodium-wrappers";

const PORT = Number(process.env.MOCK_GITHUB_PORT ?? 9310);
const ENGINE_PORT = Number(process.env.MOCK_ENGINE_PORT ?? 9110);
const ENGINE_HOME = process.env.MOCK_ENGINE_HOME ?? "/tmp/cesium-mock-codespace";
const BUN_BIN =
  process.env.MOCK_BUN_BIN ?? path.join(homedir(), ".bun", "bin", "bun");
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

await sodium.ready;
const keypair = sodium.crypto_box_keypair();

const log = (...args) => console.log("[mock-github]", ...args);

/* --------------------------------- state --------------------------------- */

const OWNER = "octocat";
const repos = [
  {
    id: 8001,
    full_name: `${OWNER}/demo-app`,
    private: true,
    default_branch: "main",
    pushed_at: new Date().toISOString(),
    description: "Demo application repository",
  },
  {
    id: 8002,
    full_name: `${OWNER}/notes`,
    private: false,
    default_branch: "main",
    pushed_at: new Date(Date.now() - 86_400_000).toISOString(),
    description: "Personal notes",
  },
];

let shaCounter = 0;
const newSha = () => `sha${(shaCounter += 1).toString().padStart(6, "0")}`;

/** per-repo git store: branches -> { head, files: Map<path, content> } */
const gitStores = new Map(
  repos.map((repo) => {
    const files = new Map([["README.md", `# ${repo.full_name}\n`]]);
    return [
      repo.full_name,
      {
        branches: new Map([[repo.default_branch, { head: newSha(), files }]]),
        commits: new Map(),
        trees: new Map(),
        pulls: [],
      },
    ];
  })
);

/** user codespaces secrets: name -> { value, repositoryIds } (unsealed!) */
const secrets = new Map();

/** codespaces: name -> record */
const codespaces = new Map();
let engineProcess = null;

/* ----------------------------- engine control ---------------------------- */

function startEngine() {
  if (engineProcess) return;
  const username = secrets.get("CESIUM_AUTH_USERNAME")?.value;
  const password = secrets.get("CESIUM_AUTH_PASSWORD")?.value;
  if (!username || !password) {
    log("ERROR: engine credentials secrets are missing; refusing to start engine");
    return;
  }
  mkdirSync(path.join(ENGINE_HOME, "state"), { recursive: true });
  mkdirSync(path.join(ENGINE_HOME, "workspaces"), { recursive: true });
  const logFd = openSync(path.join(ENGINE_HOME, "engine.log"), "a");
  engineProcess = spawn(BUN_BIN, ["server/src/runtime/bun-server.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(ENGINE_PORT),
      HOST: "127.0.0.1",
      OPENCURSOR_AUTH_USERNAME: username,
      OPENCURSOR_AUTH_PASSWORD: password,
      OPENCURSOR_DATA_DIR: path.join(ENGINE_HOME, "state"),
      OPENCURSOR_STORAGE_DRIVER: "legacy-json",
      WORKSPACE_ROOT: path.join(ENGINE_HOME, "workspaces"),
      WORKSPACE_ALLOWED_ROOTS: path.join(ENGINE_HOME, "workspaces"),
      CESIUM_SERVER_LABEL: "Codespace octocat/demo-app",
    },
    stdio: ["ignore", logFd, logFd],
  });
  const pid = engineProcess.pid;
  log(`spawned codespace engine (pid ${pid}, port ${ENGINE_PORT}, user ${username})`);
  engineProcess.on("exit", (code) => {
    log(`codespace engine exited (pid ${pid}, code ${code})`);
    if (engineProcess?.pid === pid) engineProcess = null;
  });
}

function stopEngine() {
  if (!engineProcess) return;
  log(`stopping codespace engine (pid ${engineProcess.pid})`);
  engineProcess.kill("SIGTERM");
  engineProcess = null;
}

/* ------------------------------ state machine ---------------------------- */

function scheduleTransitions(record, phases) {
  for (const { afterMs, state, spawn: shouldSpawn } of phases) {
    setTimeout(() => {
      if (!codespaces.has(record.name)) return;
      record.state = state;
      log(`codespace ${record.name} -> ${state}`);
      if (shouldSpawn) startEngine();
    }, afterMs);
  }
}

function codespacePayload(record) {
  return {
    name: record.name,
    display_name: record.display_name,
    state: record.state,
    repository: { full_name: record.repo },
    machine: { name: record.machine },
    git_status: { ref: record.ref },
    last_used_at: new Date().toISOString(),
    web_url: `https://github.com/codespaces/${record.name}`,
    idle_timeout_minutes: record.idle_timeout_minutes,
    retention_expires_at: null,
  };
}

/* --------------------------------- router -------------------------------- */

function json(res, status, payload) {
  const body = JSON.stringify(payload ?? {});
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function repoByName(owner, repo) {
  return repos.find((entry) => entry.full_name === `${owner}/${repo}`) ?? null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const p = url.pathname;
  const method = req.method ?? "GET";
  log(method, p);
  let match;

  if (method === "GET" && p === "/user") {
    return json(res, 200, { login: OWNER });
  }
  if (method === "GET" && p === "/user/repos") {
    return json(res, 200, repos);
  }

  if ((match = p.match(/^\/repos\/([^/]+)\/([^/]+)$/)) && method === "GET") {
    const repo = repoByName(match[1], match[2]);
    return repo ? json(res, 200, repo) : json(res, 404, { message: "Not Found" });
  }

  if (
    (match = p.match(/^\/repos\/([^/]+)\/([^/]+)\/codespaces\/machines$/)) &&
    method === "GET"
  ) {
    return json(res, 200, {
      machines: [
        {
          name: "basicLinux32gb",
          display_name: "2 core",
          cpus: 2,
          memory_in_bytes: 8 * 1024 ** 3,
          storage_in_bytes: 32 * 1024 ** 3,
          prebuild_availability: null,
        },
        {
          name: "standardLinux32gb",
          display_name: "4 core",
          cpus: 4,
          memory_in_bytes: 16 * 1024 ** 3,
          storage_in_bytes: 32 * 1024 ** 3,
          prebuild_availability: null,
        },
      ],
    });
  }

  /* ------------------------------ contents ------------------------------- */

  if (
    (match = p.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/)) &&
    method === "GET"
  ) {
    const repo = repoByName(match[1], match[2]);
    const store = repo ? gitStores.get(repo.full_name) : null;
    if (!repo || !store) return json(res, 404, { message: "Not Found" });
    const branchName = url.searchParams.get("ref") ?? repo.default_branch;
    const branch = store.branches.get(branchName);
    const filePath = decodeURIComponent(match[3]);
    const content = branch?.files.get(filePath);
    if (content === undefined) return json(res, 404, { message: "Not Found" });
    return json(res, 200, {
      sha: newSha(),
      encoding: "base64",
      content: Buffer.from(content, "utf-8").toString("base64"),
    });
  }

  /* ------------------------------ git data ------------------------------- */

  if ((match = p.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/(.+)$/))) {
    const repo = repoByName(match[1], match[2]);
    const store = repo ? gitStores.get(repo.full_name) : null;
    if (!repo || !store) return json(res, 404, { message: "Not Found" });
    const rest = match[3];
    let sub;

    if ((sub = rest.match(/^ref\/heads\/(.+)$/)) && method === "GET") {
      const branch = store.branches.get(decodeURIComponent(sub[1]));
      return branch
        ? json(res, 200, { object: { sha: branch.head } })
        : json(res, 404, { message: "Not Found" });
    }
    if ((sub = rest.match(/^commits\/(.+)$/)) && method === "GET") {
      const commit = store.commits.get(sub[1]);
      // Head commits created at boot have no tree yet; synthesize one.
      return json(res, 200, { tree: { sha: commit?.tree ?? newSha() } });
    }
    if (rest === "trees" && method === "POST") {
      const body = await readBody(req);
      const sha = newSha();
      store.trees.set(sha, body.tree ?? []);
      return json(res, 201, { sha });
    }
    if (rest === "commits" && method === "POST") {
      const body = await readBody(req);
      const sha = newSha();
      store.commits.set(sha, { tree: body.tree, message: body.message });
      return json(res, 201, { sha });
    }
    if (rest === "refs" && method === "POST") {
      const body = await readBody(req);
      const branchName = String(body.ref ?? "").replace(/^refs\/heads\//, "");
      const source = [...store.branches.values()].find(
        (branch) => branch.head === body.sha
      );
      store.branches.set(branchName, {
        head: body.sha,
        files: new Map(source ? source.files : []),
      });
      return json(res, 201, { ref: body.ref, object: { sha: body.sha } });
    }
    if ((sub = rest.match(/^refs\/heads\/(.+)$/)) && method === "PATCH") {
      const body = await readBody(req);
      const branch = store.branches.get(decodeURIComponent(sub[1]));
      if (!branch) return json(res, 404, { message: "Not Found" });
      const commit = store.commits.get(body.sha);
      const tree = commit ? store.trees.get(commit.tree) ?? [] : [];
      for (const entry of tree) {
        if (entry.path && typeof entry.content === "string") {
          branch.files.set(entry.path, entry.content);
        }
      }
      branch.head = body.sha;
      log(`applied commit ${body.sha} (${tree.length} files) to ${sub[1]}`);
      return json(res, 200, { object: { sha: body.sha } });
    }
  }

  /* -------------------------------- pulls -------------------------------- */

  if ((match = p.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/))) {
    const repo = repoByName(match[1], match[2]);
    const store = repo ? gitStores.get(repo.full_name) : null;
    if (!repo || !store) return json(res, 404, { message: "Not Found" });
    if (method === "GET") {
      return json(res, 200, store.pulls.filter((pull) => pull.state === "open"));
    }
    if (method === "POST") {
      const body = await readBody(req);
      const pull = {
        number: store.pulls.length + 1,
        html_url: `https://github.com/${repo.full_name}/pull/${store.pulls.length + 1}`,
        state: "open",
        head: body.head,
      };
      store.pulls.push(pull);
      return json(res, 201, pull);
    }
  }

  /* ------------------------------- secrets ------------------------------- */

  if (p === "/user/codespaces/secrets/public-key" && method === "GET") {
    return json(res, 200, {
      key_id: "mock-key-1",
      key: sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL),
    });
  }
  if (
    (match = p.match(/^\/user\/codespaces\/secrets\/([^/]+)\/repositories$/)) &&
    method === "GET"
  ) {
    const secret = secrets.get(match[1]);
    if (!secret) return json(res, 404, { message: "Not Found" });
    return json(res, 200, {
      repositories: [...secret.repositoryIds].map((id) => ({ id })),
    });
  }
  if ((match = p.match(/^\/user\/codespaces\/secrets\/([^/]+)$/)) && method === "PUT") {
    const body = await readBody(req);
    let value;
    try {
      value = sodium.to_string(
        sodium.crypto_box_seal_open(
          sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL),
          keypair.publicKey,
          keypair.privateKey
        )
      );
    } catch {
      return json(res, 422, { message: "encrypted_value could not be unsealed" });
    }
    secrets.set(match[1], {
      value,
      repositoryIds: new Set((body.selected_repository_ids ?? []).map(Number)),
    });
    log(`stored secret ${match[1]} (unsealed OK, ${value.length} chars)`);
    return json(res, 204, undefined);
  }

  /* ------------------------------ codespaces ----------------------------- */

  if (
    (match = p.match(/^\/repos\/([^/]+)\/([^/]+)\/codespaces$/)) &&
    method === "POST"
  ) {
    const repo = repoByName(match[1], match[2]);
    const store = repo ? gitStores.get(repo.full_name) : null;
    if (!repo || !store) return json(res, 404, { message: "Not Found" });
    const body = await readBody(req);
    const branch = store.branches.get(body.ref ?? repo.default_branch);
    if (body.devcontainer_path && !branch?.files.has(body.devcontainer_path)) {
      return json(res, 400, {
        message: `devcontainer_path ${body.devcontainer_path} does not exist on ${repo.default_branch}`,
      });
    }
    const name = `mock-${match[2]}-${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      name,
      display_name: body.display_name ?? name,
      state: "Queued",
      repo: repo.full_name,
      machine: body.machine ?? "basicLinux32gb",
      ref: body.ref ?? repo.default_branch,
      idle_timeout_minutes: body.idle_timeout_minutes ?? 30,
    };
    codespaces.set(name, record);
    log(`created codespace ${name} (machine ${record.machine})`);
    scheduleTransitions(record, [
      { afterMs: 2_000, state: "Provisioning" },
      { afterMs: 8_000, state: "Available", spawn: true },
    ]);
    return json(res, 201, codespacePayload(record));
  }

  if ((match = p.match(/^\/user\/codespaces\/([^/]+)$/))) {
    const record = codespaces.get(match[1]);
    if (method === "GET") {
      return record
        ? json(res, 200, codespacePayload(record))
        : json(res, 404, { message: "Not Found" });
    }
    if (method === "DELETE") {
      if (record) {
        stopEngine();
        codespaces.delete(record.name);
        log(`deleted codespace ${record.name}`);
      }
      return json(res, 204, undefined);
    }
  }

  if ((match = p.match(/^\/user\/codespaces\/([^/]+)\/start$/)) && method === "POST") {
    const record = codespaces.get(match[1]);
    if (!record) return json(res, 404, { message: "Not Found" });
    if (record.state !== "Available") {
      record.state = "Starting";
      log(`starting codespace ${record.name}`);
      scheduleTransitions(record, [{ afterMs: 4_000, state: "Available", spawn: true }]);
    }
    return json(res, 200, codespacePayload(record));
  }

  if ((match = p.match(/^\/user\/codespaces\/([^/]+)\/stop$/)) && method === "POST") {
    const record = codespaces.get(match[1]);
    if (!record) return json(res, 404, { message: "Not Found" });
    stopEngine();
    record.state = "Shutdown";
    log(`stopped codespace ${record.name} (simulated idle timeout)`);
    return json(res, 200, codespacePayload(record));
  }

  return json(res, 404, { message: `Not Found: ${method} ${p}` });
});

server.listen(PORT, "127.0.0.1", () => {
  log(`mock GitHub API listening on http://127.0.0.1:${PORT}`);
  log(`codespace engines will run on port ${ENGINE_PORT} under ${ENGINE_HOME}`);
});

process.on("SIGINT", () => {
  stopEngine();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopEngine();
  process.exit(0);
});
