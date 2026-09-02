import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import {
  buildBootstrapScript,
  buildCodespaceTemplateFiles,
  buildDevcontainerJson,
  codespaceEngineBaseUrl,
  resolveCodespaceEngineBaseUrl,
  CODESPACE_BOOTSTRAP_PATH,
  CODESPACE_DEVCONTAINER_PATH,
  CODESPACE_ENGINE_PORT,
  CODESPACE_TEMPLATE_VERSION,
} from "../convex/lib/codespaceBootstrap.ts";
import {
  buildServerSavePatch,
  findCodespaceRowIndex,
  type CodespaceMeta,
} from "../convex/lib/serverRecords.ts";
import { ConvexError } from "convex/values";
import {
  createGithubClient,
  GithubApiError,
  listRepoCodespaces,
  pickAdoptableCodespace,
  putUserCodespaceSecret,
  splitRepoFullName,
  type FetchLike,
  type RepoCodespaceListing,
} from "../convex/lib/githubApi.ts";
import {
  categorizeCodespaceState,
  CODESPACE_ENGINE_AUTH_SECRET_KIND,
  codespaceBaseUrlKeys,
  codespacePairingMeta,
  codespaceStateLabel,
  deriveCodespaceDevices,
  generateEngineCredentials,
  parseCodespaceEngineAuthSecret,
  pickAccountEngineAuth,
  pickExistingEngineAuth,
  serializeCodespaceEngineAuthSecret,
  wakeCodespaceDevice,
  type CodespaceWakeDeps,
  type GithubCodespaceInfo,
} from "../src/lib/github-codespaces.ts";
import {
  convexActionErrorMessage,
  unwrapConvexActionErrors,
} from "../src/lib/cloud/convex-errors.ts";
import type { CloudServer } from "../src/contexts/CloudContext.tsx";

/* ------------------------- bootstrap template ---------------------------- */

describe("codespace bootstrap template", () => {
  test("devcontainer json is valid and wires the lifecycle hooks", () => {
    const parsed = JSON.parse(buildDevcontainerJson()) as {
      forwardPorts: number[];
      portsAttributes: Record<string, { onAutoForward: string }>;
      postCreateCommand: string;
      postStartCommand: string;
      customizations: { cesium: { templateVersion: number } };
    };
    assert.deepEqual(parsed.forwardPorts, [CODESPACE_ENGINE_PORT]);
    assert.equal(
      parsed.portsAttributes[String(CODESPACE_ENGINE_PORT)]?.onAutoForward,
      "silent"
    );
    assert.equal(
      parsed.postCreateCommand,
      "bash .devcontainer/cesium/bootstrap.sh install"
    );
    assert.equal(
      parsed.postStartCommand,
      "bash .devcontainer/cesium/bootstrap.sh start"
    );
    assert.equal(
      parsed.customizations.cesium.templateVersion,
      CODESPACE_TEMPLATE_VERSION
    );
  });

  test("bootstrap script keeps bash expansions literal (no TS interpolation)", () => {
    const script = buildBootstrapScript();
    // These MUST survive as literal bash expansions; if template-literal
    // escaping ever regresses they would interpolate to "undefined".
    assert.ok(script.includes('"${CESIUM_ROOT}"'));
    assert.ok(script.includes('${CODESPACE_NAME}'));
    assert.ok(script.includes("${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"));
    assert.ok(!script.includes("undefined"));
    assert.ok(script.includes(`# cesium-template-version: ${CODESPACE_TEMPLATE_VERSION}`));
    assert.ok(script.includes("gh codespace ports visibility"));
    assert.ok(script.includes("CESIUM_SKIP_TUNNEL=1"));
    assert.ok(script.includes("CESIUM_RENDEZVOUS_REQUIRED=0"));
    assert.ok(script.includes("CESIUM_AUTH_PASSWORD"));
    assert.ok(script.startsWith("#!/usr/bin/env bash"));
  });

  test("bootstrap persists the codespace identity for the engine keep-alive", () => {
    const script = buildBootstrapScript();
    // Supervised engine restarts do not inherit the postStart shell, so the
    // codespace name must land in server.env for the keep-alive to arm.
    assert.ok(script.includes("CESIUM_CODESPACE_NAME=%q"));
    assert.ok(script.includes("CESIUM_CODESPACE_KEEPALIVE=1"));
    assert.ok(script.includes("CESIUM_CODESPACES_PORT_FORWARDING_DOMAIN=%q"));
    // Rotated secrets still refresh the engine password on every start.
    assert.ok(script.includes("OPENCURSOR_AUTH_PASSWORD=%q"));
    assert.ok(script.includes("sync_env"));
    assert.ok(CODESPACE_TEMPLATE_VERSION >= 2, "template must be bumped so stale repos refresh");
  });

  test("bootstrap start path self-updates a stale engine", () => {
    const script = buildBootstrapScript();
    // Without this, codespaces run creation-time engine code forever: the
    // install marker skips the installer, GitHub cannot raise idle timeouts
    // post-create, and the checkout's bootstrap never refreshes itself.
    assert.ok(script.includes("update_engine"));
    assert.ok(script.includes("ls-remote origin"));
    // The canonical installer URL rides updates, not the (stale) checkout.
    assert.ok(script.includes("run_installer"));
    // A failed update must fall back to the existing engine, never block start.
    assert.ok(script.includes("Engine update FAILED; keeping the existing engine."));
    const startCase = script.slice(script.indexOf("  start)"));
    assert.ok(startCase.includes("install_engine"));
    assert.ok(startCase.indexOf("install_engine") < startCase.indexOf("update_engine"));
    assert.ok(startCase.indexOf("update_engine") < startCase.indexOf("start_engine"));
    assert.ok(
      CODESPACE_TEMPLATE_VERSION >= 3,
      "template must be bumped so stale repos refresh the self-updating bootstrap"
    );
  });

  test("bootstrap script is valid bash (bash -n)", (t) => {
    const probe = spawnSync("bash", ["-c", "true"]);
    if (probe.error) {
      t.skip("bash is not available on this platform");
      return;
    }
    const result = spawnSync("bash", ["-n"], {
      input: buildBootstrapScript(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  });

  test("template file set covers both paths", () => {
    const files = buildCodespaceTemplateFiles();
    assert.deepEqual(
      files.map((file) => file.path),
      [CODESPACE_DEVCONTAINER_PATH, CODESPACE_BOOTSTRAP_PATH]
    );
  });

  test("bootstrap provisions the in-app browser Chromium", () => {
    const script = buildBootstrapScript();
    // Codespaces forwarded ports hijack GET+text/html document loads with an
    // anti-phishing "Verifying session" interstitial, so the in-app browser
    // must render inside the codespace via the engine's headless Chromium.
    assert.ok(script.includes("CESIUM_INSTALL_BROWSER=1"));
    assert.ok(script.includes("ensure_browser"));
    assert.ok(script.includes("PLAYWRIGHT_BROWSERS_PATH"));
    assert.ok(script.includes("install --with-deps chromium"));
    assert.ok(
      CODESPACE_TEMPLATE_VERSION >= 3,
      "template must be bumped so stale repos pick up the browser install"
    );
  });

  test("committed .devcontainer reference copies match the builders", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const file of buildCodespaceTemplateFiles()) {
      const committed = await readFile(
        new URL(`../${file.path}`, import.meta.url),
        "utf8"
      );
      assert.equal(
        committed,
        file.content,
        `${file.path} is out of sync with convex/lib/codespaceBootstrap.ts - regenerate it from buildCodespaceTemplateFiles()`
      );
    }
  });

  test("engine base URL derivation", () => {
    assert.equal(
      codespaceEngineBaseUrl("octocat-fuzzy-space-1a2b3c"),
      `https://octocat-fuzzy-space-1a2b3c-${CODESPACE_ENGINE_PORT}.app.github.dev`
    );
    assert.throws(() => codespaceEngineBaseUrl("not a name!"));
  });

  test("engine base URL overrides: GHE domain and full template", () => {
    assert.equal(
      resolveCodespaceEngineBaseUrl("octo-abc", {
        portForwardingDomain: "app.ghe.example.com",
      }),
      `https://octo-abc-${CODESPACE_ENGINE_PORT}.app.ghe.example.com`
    );
    assert.equal(
      resolveCodespaceEngineBaseUrl("octo-abc", {
        urlTemplate: "http://127.0.0.1:9110",
      }),
      "http://127.0.0.1:9110"
    );
    assert.equal(
      resolveCodespaceEngineBaseUrl("octo-abc", {
        urlTemplate: "https://{name}-{port}.tunnel.example/",
      }),
      `https://octo-abc-${CODESPACE_ENGINE_PORT}.tunnel.example`
    );
    assert.throws(() =>
      resolveCodespaceEngineBaseUrl("octo-abc", { urlTemplate: "ftp://nope" })
    );
    // Empty template falls through to the default derivation.
    assert.equal(
      resolveCodespaceEngineBaseUrl("octo-abc", { urlTemplate: "  " }),
      codespaceEngineBaseUrl("octo-abc")
    );
  });
});

/* ---------------------------- server records ----------------------------- */

describe("server save merge (codespace stickiness)", () => {
  const meta: CodespaceMeta = {
    repoFullName: "octo/app",
    repositoryId: 42,
    codespaceName: "octo-app-xyz",
    devcontainerPath: ".devcontainer/cesium/devcontainer.json",
    engineUsername: "cesium",
    enginePassword: "secret",
  };

  test("plain remote push does not flatten a codespace row", () => {
    const patch = buildServerSavePatch(
      { kind: "codespace", codespace: meta },
      {
        name: "octo/app",
        baseUrl: "https://octo-app-xyz-9100.app.github.dev",
        kind: "remote",
        sessionToken: "tok",
      }
    );
    assert.equal(patch.kind, "codespace");
    assert.deepEqual(patch.codespace, meta);
    assert.equal(patch.sessionToken, "tok");
  });

  test("explicit codespace save replaces the metadata", () => {
    const next: CodespaceMeta = { ...meta, codespaceName: "octo-app-new" };
    const patch = buildServerSavePatch(
      { kind: "codespace", codespace: meta },
      {
        name: "octo/app",
        baseUrl: "https://octo-app-new-9100.app.github.dev",
        kind: "codespace",
        codespace: next,
      }
    );
    assert.equal(patch.kind, "codespace");
    assert.equal(patch.codespace?.codespaceName, "octo-app-new");
  });

  test("plain servers stay plain", () => {
    const patch = buildServerSavePatch(
      { kind: "remote" },
      { name: "box", baseUrl: "https://box.example", kind: "remote" }
    );
    assert.equal(patch.kind, "remote");
    assert.equal(patch.codespace, undefined);
  });

  test("codespace rows are found by repository", () => {
    const rows = [
      { codespace: undefined },
      { codespace: { repoFullName: "octo/app" } },
      { codespace: { repoFullName: "octo/other" } },
    ];
    assert.equal(findCodespaceRowIndex(rows, "octo/app"), 1);
    assert.equal(findCodespaceRowIndex(rows, "octo/missing"), -1);
  });
});

/* ------------------------------ github api ------------------------------- */

type MockCall = { url: string; method: string; body?: unknown };

function mockFetch(
  routes: Array<{
    match: (url: string, method: string) => boolean;
    status?: number;
    payload?: unknown;
  }>,
  calls: MockCall[]
): FetchLike {
  return async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    const route = routes.find((entry) => entry.match(url, method));
    if (!route) {
      return {
        ok: false,
        status: 404,
        json: async () => ({ message: "Not Found" }),
        text: async () => "Not Found",
      };
    }
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route.payload ?? {},
      text: async () => JSON.stringify(route.payload ?? {}),
    };
  };
}

describe("github api client", () => {
  test("attaches auth and api-version headers", async () => {
    let seenHeaders: Record<string, string> | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      seenHeaders = init?.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({ login: "octocat" }),
        text: async () => "",
      };
    };
    const client = createGithubClient("gho_token", fetchImpl);
    await client.request("GET", "/user");
    assert.equal(seenHeaders?.Authorization, "Bearer gho_token");
    assert.equal(seenHeaders?.["X-GitHub-Api-Version"], "2022-11-28");
  });

  test("maps error payloads into GithubApiError", async () => {
    const client = createGithubClient(
      "t",
      mockFetch(
        [
          {
            match: () => true,
            status: 403,
            payload: { message: "API rate limit exceeded" },
          },
        ],
        []
      )
    );
    await assert.rejects(
      () => client.request("GET", "/user"),
      (error: unknown) =>
        error instanceof GithubApiError &&
        error.status === 403 &&
        error.message.includes("API rate limit exceeded")
    );
  });

  test("putUserCodespaceSecret unions existing repository access", async () => {
    const calls: MockCall[] = [];
    const client = createGithubClient(
      "t",
      mockFetch(
        [
          {
            match: (url, method) =>
              method === "GET" && url.includes("/secrets/CESIUM_AUTH_PASSWORD/repositories"),
            payload: { repositories: [{ id: 7 }, { id: 9 }] },
          },
          {
            match: (url, method) =>
              method === "PUT" && url.endsWith("/secrets/CESIUM_AUTH_PASSWORD"),
            status: 204,
          },
        ],
        calls
      )
    );
    await putUserCodespaceSecret(client, {
      name: "CESIUM_AUTH_PASSWORD",
      encryptedValue: "sealed",
      keyId: "key-1",
      repositoryId: 42,
    });
    const put = calls.find((call) => call.method === "PUT");
    assert.ok(put);
    const body = put.body as {
      encrypted_value: string;
      key_id: string;
      selected_repository_ids: number[];
    };
    assert.equal(body.encrypted_value, "sealed");
    assert.equal(body.key_id, "key-1");
    assert.deepEqual([...body.selected_repository_ids].sort((a, b) => a - b), [7, 9, 42]);
  });

  test("splitRepoFullName validates shape", () => {
    assert.deepEqual(splitRepoFullName("octo/app"), { owner: "octo", repo: "app" });
    assert.throws(() => splitRepoFullName("octo"));
    assert.throws(() => splitRepoFullName("a/b/c"));
  });

  test("listRepoCodespaces maps rows and keeps the devcontainer path", async () => {
    const client = createGithubClient(
      "t",
      mockFetch(
        [
          {
            match: (url, method) =>
              method === "GET" && url.includes("/repos/octo/app/codespaces"),
            payload: {
              total_count: 2,
              codespaces: [
                {
                  name: "octo-app-one",
                  state: "Available",
                  devcontainer_path: ".devcontainer/cesium/devcontainer.json",
                  repository: { full_name: "octo/app" },
                },
                { name: "octo-app-two", state: "Shutdown" },
              ],
            },
          },
        ],
        []
      )
    );
    const rows = await listRepoCodespaces(client, "octo", "app");
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.codespace.name, "octo-app-one");
    assert.equal(rows[0]?.devcontainerPath, ".devcontainer/cesium/devcontainer.json");
    assert.equal(rows[1]?.devcontainerPath, null);
  });
});

/* --------------------------- orphan adoption ------------------------------ */

describe("codespace adoption", () => {
  const CESIUM_PATH = ".devcontainer/cesium/devcontainer.json";
  const listing = (
    name: string,
    state: string,
    devcontainerPath: string | null = CESIUM_PATH,
    lastUsedAt: string | null = null
  ): RepoCodespaceListing => ({
    codespace: {
      name,
      displayName: `Cesium - octo/app`,
      state,
      repositoryFullName: "octo/app",
      machine: "basicLinux32gb",
      gitRef: "main",
      lastUsedAt,
      webUrl: null,
      idleTimeoutMinutes: 240,
      retentionExpiresAt: null,
    },
    devcontainerPath,
  });

  test("adopts only live codespaces built from the Cesium devcontainer", () => {
    assert.equal(pickAdoptableCodespace([], CESIUM_PATH), null);
    // Different devcontainer: someone's unrelated codespace stays untouched.
    assert.equal(
      pickAdoptableCodespace([listing("other", "Available", ".devcontainer/devcontainer.json")], CESIUM_PATH),
      null
    );
    // Dead codespaces cannot be adopted.
    assert.equal(
      pickAdoptableCodespace(
        [listing("dead", "Deleted"), listing("broken", "Failed")],
        CESIUM_PATH
      ),
      null
    );
    assert.equal(
      pickAdoptableCodespace([listing("orphan", "Shutdown")], CESIUM_PATH)?.name,
      "orphan"
    );
  });

  test("prefers running over booting over stopped, then most recently used", () => {
    const picked = pickAdoptableCodespace(
      [
        listing("stopped", "Shutdown"),
        listing("booting", "Provisioning"),
        listing("running", "Available"),
      ],
      CESIUM_PATH
    );
    assert.equal(picked?.name, "running");

    const tieBreak = pickAdoptableCodespace(
      [
        listing("older", "Shutdown", CESIUM_PATH, "2026-01-01T00:00:00Z"),
        listing("newer", "Shutdown", CESIUM_PATH, "2026-02-01T00:00:00Z"),
      ],
      CESIUM_PATH
    );
    assert.equal(tieBreak?.name, "newer");
  });
});

/* ---------------------- Convex action error unwrap ------------------------ */

describe("convex action errors", () => {
  test("unwraps ConvexError data (string and object shapes)", () => {
    assert.equal(
      convexActionErrorMessage(
        new ConvexError(
          "GitHub API POST /repos/octo/app/codespaces failed (403): You have reached the maximum number of codespaces you can create."
        )
      ),
      "GitHub API POST /repos/octo/app/codespaces failed (403): You have reached the maximum number of codespaces you can create."
    );
    assert.equal(
      convexActionErrorMessage(new ConvexError({ message: "spending limit reached" })),
      "spending limit reached"
    );
  });

  test("keeps plain error messages (dev deployments, older functions)", () => {
    assert.equal(convexActionErrorMessage(new Error("boom")), "boom");
    assert.equal(convexActionErrorMessage("string failure"), "string failure");
  });

  test("unwrapConvexActionErrors rethrows a plain Error with the real message", async () => {
    await assert.rejects(
      () =>
        unwrapConvexActionErrors(() =>
          Promise.reject(new ConvexError("token expired; reconnect GitHub"))
        ),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof ConvexError) &&
        error.message === "token expired; reconnect GitHub"
    );
    const value = await unwrapConvexActionErrors(() => Promise.resolve(42));
    assert.equal(value, 42);
  });
});

/* --------------------------- client device model -------------------------- */

function cloudCodespaceServer(overrides?: Partial<CloudServer>): CloudServer {
  return {
    name: "octo/app",
    baseUrl: "https://octo-app-xyz-9100.app.github.dev",
    kind: "codespace",
    sessionToken: null,
    rendezvous: null,
    codespace: {
      repoFullName: "octo/app",
      repositoryId: 42,
      codespaceName: "octo-app-xyz",
      devcontainerPath: ".devcontainer/cesium/devcontainer.json",
      lastKnownState: "Shutdown",
      engineUsername: "cesium",
      enginePassword: "pw",
    },
    notes: null,
    lastConnectedAt: null,
    ...overrides,
  };
}

describe("codespace device model", () => {
  test("derives devices from cloud servers and matches local connections", () => {
    const devices = deriveCodespaceDevices(
      [
        cloudCodespaceServer(),
        {
          ...cloudCodespaceServer(),
          name: "plain",
          baseUrl: "https://box.example",
          kind: "remote",
          codespace: null,
        },
      ],
      [
        { id: "local-1", baseUrl: "https://octo-app-xyz-9100.app.github.dev" },
        { id: "local-2", baseUrl: "https://box.example" },
      ]
    );
    assert.equal(devices.length, 1);
    const device = devices[0]!;
    assert.equal(device.key, "codespace:octo/app");
    assert.equal(device.localServerId, "local-1");
    assert.equal(device.lastKnownState, "Shutdown");
    assert.deepEqual(device.engineAuth, { username: "cesium", password: "pw" });
    assert.ok(
      codespaceBaseUrlKeys(devices).has("https://octo-app-xyz-9100.app.github.dev:443")
    );
  });

  test("repo workspace root follows the Codespaces checkout convention", async () => {
    const { codespaceRepoWorkspaceName, codespaceRepoWorkspaceRoot } = await import(
      "../src/lib/github-codespaces.ts"
    );
    assert.equal(
      codespaceRepoWorkspaceRoot("BenItBuhner/Model-Proxy"),
      "/workspaces/Model-Proxy"
    );
    assert.equal(codespaceRepoWorkspaceName("BenItBuhner/Model-Proxy"), "Model-Proxy");
    assert.equal(codespaceRepoWorkspaceRoot("bare-name"), "/workspaces/bare-name");
  });

  test("state categorization and labels", () => {
    assert.equal(categorizeCodespaceState("Available"), "running");
    assert.equal(categorizeCodespaceState("Shutdown"), "stopped");
    assert.equal(categorizeCodespaceState("Provisioning"), "transitional");
    assert.equal(categorizeCodespaceState("Deleted"), "gone");
    assert.equal(categorizeCodespaceState("Failed"), "failed");
    assert.equal(categorizeCodespaceState(null), "unknown");
    assert.equal(codespaceStateLabel("Shutdown"), "Stopped");
  });

  test("pairing meta keeps identity, credentials, and state overrides", () => {
    const devices = deriveCodespaceDevices(
      [cloudCodespaceServer()],
      [{ id: "local-1", baseUrl: "https://octo-app-xyz-9100.app.github.dev" }]
    );
    const meta = codespacePairingMeta(devices[0]!, { lastKnownState: "Available" });
    assert.equal(meta.repoFullName, "octo/app");
    assert.equal(meta.repositoryId, 42);
    assert.equal(meta.codespaceName, "octo-app-xyz");
    assert.equal(meta.lastKnownState, "Available");
    assert.equal(meta.engineUsername, "cesium");
    assert.equal(meta.enginePassword, "pw");
    assert.ok(typeof meta.lastSyncedAt === "number");
    // Without an override the device's own last known state is kept.
    assert.equal(codespacePairingMeta(devices[0]!).lastKnownState, "Shutdown");
  });

  test("engine credential generation and reuse", () => {
    const generated = generateEngineCredentials();
    assert.equal(generated.username, "cesium");
    assert.ok(/^[A-Za-z0-9_-]{24,}$/.test(generated.password));
    assert.equal(pickExistingEngineAuth([{ engineAuth: null }]), null);
    assert.deepEqual(
      pickExistingEngineAuth([
        { engineAuth: null },
        { engineAuth: { username: "cesium", password: "pw" } },
      ]),
      { username: "cesium", password: "pw" }
    );
  });

  test("account engine-auth secret round-trips and tolerates junk", () => {
    const auth = { username: "cesium", password: "s3cret" };
    const payload = serializeCodespaceEngineAuthSecret(auth);
    assert.deepEqual(parseCodespaceEngineAuthSecret(payload), auth);
    assert.equal(parseCodespaceEngineAuthSecret("not json"), null);
    assert.equal(parseCodespaceEngineAuthSecret('{"username":""}'), null);
    assert.deepEqual(
      pickAccountEngineAuth([
        { kind: "voice.settings", payload: "{}" },
        { kind: CODESPACE_ENGINE_AUTH_SECRET_KIND, payload },
      ]),
      auth
    );
    assert.equal(pickAccountEngineAuth([{ kind: "other", payload }]), null);
  });
});

/* -------------------------------- wake flow ------------------------------- */

function codespaceInfo(state: string): GithubCodespaceInfo {
  return {
    name: "octo-app-xyz",
    displayName: "Cesium - octo/app",
    state,
    repositoryFullName: "octo/app",
    machine: "basicLinux32gb",
    gitRef: "main",
    lastUsedAt: null,
    webUrl: null,
    idleTimeoutMinutes: 30,
    retentionExpiresAt: null,
  };
}

const wakeDevice = {
  codespaceName: "octo-app-xyz",
  baseUrl: "https://octo-app-xyz-9100.app.github.dev",
  engineAuth: { username: "cesium", password: "pw" },
};

describe("codespace wake flow", () => {
  test("healthy engine short-circuits to a session", async () => {
    const phases: string[] = [];
    let sessions = 0;
    const result = await wakeCodespaceDevice({
      device: wakeDevice,
      deps: {
        checkEngineHealthy: async () => true,
        getCodespace: async () => {
          throw new Error("should not be called");
        },
        startCodespace: async () => {
          throw new Error("should not be called");
        },
        ensureEngineSession: async () => {
          sessions += 1;
        },
        sleep: async () => {},
        now: () => 0,
      },
      onPhase: (phase) => phases.push(phase),
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(sessions, 1);
    assert.deepEqual(phases, ["checking-engine", "signing-in", "ready"]);
  });

  test("stopped codespace: start, wait for Available, wait for engine", async () => {
    const phases: string[] = [];
    let clock = 0;
    let started = 0;
    let engineProbes = 0;
    const states = ["Shutdown", "Starting", "Available"];
    const result = await wakeCodespaceDevice({
      device: wakeDevice,
      deps: {
        checkEngineHealthy: async () => {
          engineProbes += 1;
          // Unhealthy at first (triggers the codespace path), healthy after
          // the codespace reports Available and one engine poll elapsed.
          return engineProbes > 2;
        },
        getCodespace: async () => codespaceInfo(states.shift() ?? "Available"),
        startCodespace: async () => {
          started += 1;
          return codespaceInfo("Starting");
        },
        ensureEngineSession: async () => {},
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
      onPhase: (phase) => phases.push(phase),
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(started, 1);
    assert.deepEqual(phases, [
      "checking-engine",
      "checking-codespace",
      "starting-codespace",
      "waiting-engine",
      "signing-in",
      "ready",
    ]);
  });

  test("deleted codespace surfaces the recreate signal", async () => {
    const result = await wakeCodespaceDevice({
      device: wakeDevice,
      deps: {
        checkEngineHealthy: async () => false,
        getCodespace: async () => null,
        startCodespace: async () => {
          throw new Error("should not be called");
        },
        ensureEngineSession: async () => {},
        sleep: async () => {},
        now: () => 0,
      },
    });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "deleted");
  });

  test("codespace start timeout is reported", async () => {
    let clock = 0;
    const result = await wakeCodespaceDevice({
      device: wakeDevice,
      timeouts: { codespaceAvailableMs: 10_000, pollIntervalMs: 4_000 },
      deps: {
        checkEngineHealthy: async () => false,
        getCodespace: async () => codespaceInfo("Starting"),
        startCodespace: async () => codespaceInfo("Starting"),
        ensureEngineSession: async () => {},
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
    });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "timeout");
  });

  test("engine that never becomes healthy times out with bootstrap hint", async () => {
    let clock = 0;
    const result = await wakeCodespaceDevice({
      device: wakeDevice,
      timeouts: { engineHealthyMs: 20_000, pollIntervalMs: 5_000 },
      deps: {
        checkEngineHealthy: async () => false,
        getCodespace: async () => codespaceInfo("Available"),
        startCodespace: async () => codespaceInfo("Available"),
        ensureEngineSession: async () => {},
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "timeout");
      assert.ok(result.message.includes("/workspaces/.cesium/logs"));
    }
  });

  test("failed codespace state is surfaced", async () => {
    const result = await wakeCodespaceDevice({
      device: wakeDevice,
      deps: {
        checkEngineHealthy: async () => false,
        getCodespace: async () => codespaceInfo("Failed"),
        startCodespace: async () => codespaceInfo("Failed"),
        ensureEngineSession: async () => {},
        sleep: async () => {},
        now: () => 0,
      },
    });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "failed");
  });
});

/* -------------------- stale-engine remediation on wake -------------------- */

function keepaliveWakeDeps(overrides: Partial<CodespaceWakeDeps>): CodespaceWakeDeps {
  return {
    checkEngineHealthy: async () => true,
    getCodespace: async () => {
      throw new Error("should not be called");
    },
    startCodespace: async () => {
      throw new Error("should not be called");
    },
    ensureEngineSession: async () => {},
    sleep: async () => {},
    now: () => 0,
    ...overrides,
  };
}

describe("codespace wake flow: stale-engine keep-alive remediation", () => {
  test("engine without keep-alive support is updated in place", async () => {
    const phases: string[] = [];
    let clock = 0;
    let sessions = 0;
    let updates = 0;
    let probes = 0;
    const result = await wakeCodespaceDevice({
      device: wakeDevice,
      deps: keepaliveWakeDeps({
        ensureEngineSession: async () => {
          sessions += 1;
        },
        probeEngineKeepalive: async () => {
          probes += 1;
          // Pre-update engine, then unreachable while it reinstalls/restarts,
          // then the rebuilt engine reporting its keep-alive.
          if (probes === 1) return { status: "unsupported" };
          if (probes === 2) return { status: "unknown" };
          return {
            status: "reported",
            enabled: true,
            lastError: null,
            consecutiveFailures: 0,
          };
        },
        applyEngineUpdate: async () => {
          updates += 1;
          return { ok: true };
        },
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      }),
      onPhase: (phase) => phases.push(phase),
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(updates, 1);
    // Signed in again after the update restarted the engine.
    assert.equal(sessions, 2);
    assert.deepEqual(phases, [
      "checking-engine",
      "signing-in",
      "updating-engine",
      "signing-in",
      "ready",
    ]);
  });

  test("failed engine update degrades to a warning, not a failed wake", async () => {
    const result = await wakeCodespaceDevice({
      device: wakeDevice,
      deps: keepaliveWakeDeps({
        probeEngineKeepalive: async () => ({ status: "unsupported" }),
        applyEngineUpdate: async () => ({ ok: false, error: "update stream died" }),
      }),
    });
    assert.equal(result.ok, true);
    assert.ok(result.ok && result.warning?.includes("update stream died"));
  });

  test("update that never comes back times out into a warning", async () => {
    let clock = 0;
    let probes = 0;
    const result = await wakeCodespaceDevice({
      device: wakeDevice,
      timeouts: { engineUpdateMs: 20_000, pollIntervalMs: 5_000 },
      deps: keepaliveWakeDeps({
        probeEngineKeepalive: async () => {
          probes += 1;
          return probes === 1 ? { status: "unsupported" } : { status: "unknown" };
        },
        applyEngineUpdate: async () => ({ ok: true }),
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      }),
    });
    assert.equal(result.ok, true);
    assert.ok(result.ok && result.warning?.includes("did not come back"));
  });

  test("disabled keep-alive surfaces a warning without updating", async () => {
    let updates = 0;
    const result = await wakeCodespaceDevice({
      device: wakeDevice,
      deps: keepaliveWakeDeps({
        probeEngineKeepalive: async () => ({
          status: "reported",
          enabled: false,
          lastError: null,
          consecutiveFailures: 0,
        }),
        applyEngineUpdate: async () => {
          updates += 1;
          return { ok: true };
        },
      }),
    });
    assert.equal(updates, 0);
    assert.equal(result.ok, true);
    assert.ok(result.ok && result.warning?.includes("keep-alive is not active"));
  });

  test("failing heartbeats surface the last error as a warning", async () => {
    const result = await wakeCodespaceDevice({
      device: wakeDevice,
      deps: keepaliveWakeDeps({
        probeEngineKeepalive: async () => ({
          status: "reported",
          enabled: true,
          lastError: "codespace host RPC timed out after 10000ms",
          consecutiveFailures: 5,
        }),
        applyEngineUpdate: async () => ({ ok: true }),
      }),
    });
    assert.equal(result.ok, true);
    assert.ok(result.ok && result.warning?.includes("codespace host RPC timed out"));
  });

  test("healthy keep-alive leaves the wake result clean", async () => {
    const phases: string[] = [];
    const result = await wakeCodespaceDevice({
      device: wakeDevice,
      deps: keepaliveWakeDeps({
        probeEngineKeepalive: async () => ({
          status: "reported",
          enabled: true,
          lastError: null,
          consecutiveFailures: 0,
        }),
        applyEngineUpdate: async () => {
          throw new Error("should not be called");
        },
      }),
      onPhase: (phase) => phases.push(phase),
    });
    assert.deepEqual(result, { ok: true });
    assert.ok(!phases.includes("updating-engine"));
  });

  test("unreachable probe skips remediation quietly", async () => {
    const result = await wakeCodespaceDevice({
      device: wakeDevice,
      deps: keepaliveWakeDeps({
        probeEngineKeepalive: async () => ({ status: "unknown" }),
        applyEngineUpdate: async () => {
          throw new Error("should not be called");
        },
      }),
    });
    assert.deepEqual(result, { ok: true });
  });
});

/* -------------------- Clerk GitHub connect errors ------------------------ */

describe("Clerk GitHub connect errors", () => {
  test("maps additional-verification copy to Clerk SSO setup guidance", async () => {
    const { formatGithubConnectError } = await import(
      "../src/lib/github-clerk-errors.ts"
    );
    const message = formatGithubConnectError(
      new Error(
        "You need to provide additional verification to perform this operation"
      )
    );
    assert.ok(message.includes("Enable connection"));
    assert.ok(message.includes("repo and codespace"));
    assert.ok(!message.toLowerCase().includes("additional verification"));
  });

  test("reads Clerk error arrays and Convex connectionStatus dumps", async () => {
    const { formatGithubConnectError } = await import(
      "../src/lib/github-clerk-errors.ts"
    );
    const fromClerk = formatGithubConnectError({
      errors: [
        {
          longMessage:
            "You need to provide additional verification to perform this operation",
        },
      ],
    });
    assert.ok(fromClerk.includes("Enable connection"));

    const fromConvex = formatGithubConnectError(
      new Error(
        "[CONVEX A(github:connectionStatus)] [Request ID: abc] Server Error Called by client"
      )
    );
    assert.ok(fromConvex.includes("npx convex deploy"));
    assert.ok(!fromConvex.includes("CLERK_SECRET_KEY"));
  });

  test("classifies the Clerk-side GitHub link and explains Convex mismatches", async () => {
    const { describeGithubLink, explainGithubLinkMismatch } = await import(
      "../src/hooks/useClerkGithubLink.ts"
    );
    assert.deepEqual(describeGithubLink(undefined), { kind: "none" });
    assert.equal(explainGithubLinkMismatch({ kind: "none" }), null);

    const unverified = describeGithubLink({
      username: "octo",
      approvedScopes: "read:user user:email",
      verification: { status: "unverified" },
    });
    assert.equal(unverified.kind === "linked" && unverified.verified, false);
    assert.ok(explainGithubLinkMismatch(unverified)?.includes("never completed"));

    const missingScopes = describeGithubLink({
      username: "octo",
      approvedScopes: "read:user user:email",
      verification: { status: "verified" },
    });
    assert.deepEqual(
      missingScopes.kind === "linked" && missingScopes.missingScopes,
      ["repo", "codespace"]
    );
    assert.ok(explainGithubLinkMismatch(missingScopes)?.includes("repo and codespace"));

    const healthy = describeGithubLink({
      username: "octo",
      approvedScopes: "read:user user:email repo codespace",
      verification: { status: "verified" },
    });
    assert.equal(healthy.kind === "linked" && healthy.missingScopes.length, 0);
    assert.ok(explainGithubLinkMismatch(healthy)?.includes("CLERK_SECRET_KEY"));
  });

  test("parses Clerk oauth token payloads and error bodies", async () => {
    const {
      extractClerkApiErrorMessage,
      readClerkGithubOauthToken,
    } = await import("../convex/lib/clerkGithub.ts");
    assert.equal(readClerkGithubOauthToken([{ token: "gho_test" }]), "gho_test");
    assert.equal(readClerkGithubOauthToken({ data: [] }), null);
    assert.equal(
      extractClerkApiErrorMessage({
        errors: [{ long_message: "Missing Clerk secret", message: "short" }],
      }),
      "Missing Clerk secret"
    );
  });
});

