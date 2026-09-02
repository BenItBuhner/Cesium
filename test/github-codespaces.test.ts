import assert from "node:assert/strict";
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
import {
  createGithubClient,
  GithubApiError,
  putUserCodespaceSecret,
  splitRepoFullName,
  type FetchLike,
} from "../convex/lib/githubApi.ts";
import {
  categorizeCodespaceState,
  codespaceBaseUrlKeys,
  codespaceStateLabel,
  deriveCodespaceDevices,
  generateEngineCredentials,
  pickExistingEngineAuth,
  wakeCodespaceDevice,
  type GithubCodespaceInfo,
} from "../src/lib/github-codespaces.ts";
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

  test("template file set covers both paths", () => {
    const files = buildCodespaceTemplateFiles();
    assert.deepEqual(
      files.map((file) => file.path),
      [CODESPACE_DEVCONTAINER_PATH, CODESPACE_BOOTSTRAP_PATH]
    );
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

