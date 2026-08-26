import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { PublicAccessConfig } from "../src/lib/public-access-manager.js";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-public-access-tests-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
delete process.env.OPENCURSOR_AUTH_USERNAME;
delete process.env.OPENCURSOR_AUTH_PASSWORD;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
process.env.OPENCURSOR_ALLOW_PRIVATE_LAN_ORIGINS = "0";
process.env.ALLOWED_ORIGINS = "http://localhost:3000";

const fs = await import("node:fs/promises");
const {
  createPublicAccessManagerForTests,
  publicAccessManager,
} = await import("../src/lib/public-access-manager.js");
const { createCesiumApp } = await import("../src/app.js");
const { assertBrowserProxyHostAllowed } = await import("../src/lib/browser-proxy-allowlist.js");

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  pid = 12345;
  killCalls: string[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.killCalls.push(signal ?? "SIGTERM");
    queueMicrotask(() => this.emit("exit", 0, signal ?? null));
    return true;
  }
}

type FetchRequest = { url: string; authorization: string | null; body: unknown };

function makeFetch(requests: FetchRequest[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const href = url instanceof Request ? url.url : String(url);
    if (href.endsWith("/health")) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (href.includes("/api/rendezvous/")) {
      requests.push({
        url: href,
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "unexpected fetch" }), { status: 500 });
  }) as typeof fetch;
}

function makeManager(options: {
  fetch?: typeof fetch;
  child?: FakeChild;
  findExecutable?: (name: string, envOverride?: string) => Promise<string | null>;
  runCommand?: (
    command: string,
    args: string[],
    timeoutMs?: number
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
} = {}) {
  return createPublicAccessManagerForTests({
    configFilePath: path.join(
      TEST_DATA_DIR,
      `${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    ),
    runDir: path.join(TEST_DATA_DIR, "run"),
    fetch: options.fetch ?? makeFetch(),
    spawn: () => {
      const child = options.child ?? new FakeChild();
      queueMicrotask(() => {
        child.stderr.write("Connect to https://fresh-public.lhr.life with this tunnel\n");
      });
      return child;
    },
    findExecutable:
      options.findExecutable ??
      (async (name) => (name === "ssh" ? "/usr/bin/ssh" : null)),
    runCommand: options.runCommand,
    tunnelStartupTimeoutMs: 1000,
    heartbeatIntervalMs: 60_000,
    healthIntervalMs: 60_000,
  });
}

after(async () => {
  await publicAccessManager.stopRuntimeOnlyForTests();
  publicAccessManager.resetForTests();
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => undefined);
  delete process.env.OPENCURSOR_AUTH_USERNAME;
  delete process.env.OPENCURSOR_AUTH_PASSWORD;
  delete process.env.OPENCURSOR_ALLOW_PRIVATE_LAN_ORIGINS;
  delete process.env.ALLOWED_ORIGINS;
});

test("public access rejects invalid web and custom URLs", async () => {
  const manager = makeManager();
  await assert.rejects(
    () => manager.updateConfig({ webAppUrl: "http://evil.example" }),
    /webAppUrl must use HTTPS/
  );
  await assert.rejects(
    () =>
      manager.updateConfig({
        webAppUrl: "https://web.example",
        customPublicUrl: "http://public.example",
      }),
    /customPublicUrl must use HTTPS/
  );
});

test("enable generates auth credentials when env auth is absent", async () => {
  delete process.env.OPENCURSOR_AUTH_USERNAME;
  delete process.env.OPENCURSOR_AUTH_PASSWORD;
  const manager = makeManager();
  const result = await manager.enable({ webAppUrl: "https://web.example" });
  assert.equal(result.status.enabled, true);
  assert.ok(result.generatedCredentials);
  assert.equal(process.env.OPENCURSOR_AUTH_USERNAME, result.generatedCredentials.username);
  assert.equal(process.env.OPENCURSOR_AUTH_PASSWORD, result.generatedCredentials.password);
  assert.equal(result.status.auth.credentialsManagerGenerated, true);
  await manager.disable();
  assert.equal(process.env.OPENCURSOR_AUTH_USERNAME, undefined);
  assert.equal(process.env.OPENCURSOR_AUTH_PASSWORD, undefined);
});

test("enable preserves existing env auth credentials", async () => {
  process.env.OPENCURSOR_AUTH_USERNAME = "external-user";
  process.env.OPENCURSOR_AUTH_PASSWORD = "external-password";
  const manager = makeManager();
  const result = await manager.enable({ webAppUrl: "https://web.example" });
  assert.equal(result.generatedCredentials, undefined);
  assert.equal(process.env.OPENCURSOR_AUTH_USERNAME, "external-user");
  assert.equal(process.env.OPENCURSOR_AUTH_PASSWORD, "external-password");
  assert.equal(result.status.auth.externallyConfigured, true);
  await manager.disable();
  assert.equal(process.env.OPENCURSOR_AUTH_USERNAME, "external-user");
  assert.equal(process.env.OPENCURSOR_AUTH_PASSWORD, "external-password");
  delete process.env.OPENCURSOR_AUTH_USERNAME;
  delete process.env.OPENCURSOR_AUTH_PASSWORD;
});

test("failed exposure rolls back generated runtime auth and enabled state", async () => {
  delete process.env.OPENCURSOR_AUTH_USERNAME;
  delete process.env.OPENCURSOR_AUTH_PASSWORD;
  const manager = makeManager({
    findExecutable: async () => null,
    fetch: makeFetch(),
  });
  await assert.rejects(
    () => manager.enable({ webAppUrl: "https://web.example" }),
    /download cloudflared|ssh is unavailable|cloudflared/i
  );
  const status = await manager.getStatus();
  assert.equal(status.enabled, false);
  assert.equal(process.env.OPENCURSOR_AUTH_USERNAME, undefined);
  assert.equal(process.env.OPENCURSOR_AUTH_PASSWORD, undefined);
});

test("retrying a rolled-back enable returns the undisclosed generated credentials", async () => {
  delete process.env.OPENCURSOR_AUTH_USERNAME;
  delete process.env.OPENCURSOR_AUTH_PASSWORD;
  const manager = makeManager();
  const now = Date.now();
  manager.replaceConfigForTests({
    schemaVersion: 1,
    enabled: false,
    webAppUrl: "https://web.example",
    provider: "auto",
    customPublicUrl: "https://existing-proxy.example",
    serverId: "server_1234567890abcdefghijklmnop",
    rendezvousReadSecret: "read_secret_1234567890abcdefghijklmnopqrstuv",
    rendezvousWriteSecret: "write_secret_1234567890abcdefghijklmnopqrstu",
    managedAuthUsername: "cesium",
    managedAuthPassword: "undisclosed_generated_password_123456",
    credentialsManagerGenerated: true,
    createdAt: now,
    updatedAt: now,
  });
  const result = await manager.enable();
  assert.deepEqual(result.generatedCredentials, {
    username: "cesium",
    password: "undisclosed_generated_password_123456",
  });
  await manager.disable();
});

test("stable connect link contains read secret but excludes write secret", async () => {
  const requests: FetchRequest[] = [];
  const manager = makeManager({ fetch: makeFetch(requests) });
  const result = await manager.enable({ webAppUrl: "https://web.example", label: "Home server" });
  const connectUrl = result.status.connectUrl;
  assert.ok(connectUrl);
  assert.match(connectUrl, /^https:\/\/web\.example\/agent#cesiumConnect=/);
  const writeSecret = requests[0]?.authorization?.replace(/^Bearer /, "");
  assert.ok(writeSecret);
  const fragment = connectUrl.split("cesiumConnect=")[1];
  const decoded = JSON.parse(Buffer.from(fragment, "base64url").toString("utf8")) as {
    secret: string;
    registryBaseUrl: string;
  };
  assert.notEqual(decoded.secret, writeSecret);
  assert.equal(decoded.registryBaseUrl, "https://web.example");
  assert.equal(connectUrl.includes(writeSecret), false);
  await manager.disable();
});

test("dynamic CORS origin is allowed only while public access is enabled", async () => {
  publicAccessManager.resetForTests();
  const config: PublicAccessConfig = {
    schemaVersion: 1,
    enabled: false,
    webAppUrl: "https://remote-web.example",
    provider: "auto",
    serverId: "server_1234567890abcdefghijklmnop",
    rendezvousReadSecret: "read_secret_1234567890abcdefghijklmnopqrstuv",
    rendezvousWriteSecret: "write_secret_1234567890abcdefghijklmnopqrstu",
    managedAuthUsername: null,
    managedAuthPassword: null,
    credentialsManagerGenerated: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  publicAccessManager.replaceConfigForTests(config);
  const app = createCesiumApp();
  const disabled = await app.request("/health", {
    method: "OPTIONS",
    headers: { Origin: "https://remote-web.example" },
  });
  assert.notEqual(disabled.headers.get("access-control-allow-origin"), "https://remote-web.example");
  publicAccessManager.replaceConfigForTests({ ...config, enabled: true });
  const enabled = await app.request("/health", {
    method: "OPTIONS",
    headers: { Origin: "https://remote-web.example" },
  });
  assert.equal(enabled.headers.get("access-control-allow-origin"), "https://remote-web.example");
});

test("public proxy targets are dynamically disabled while public access is enabled", async () => {
  publicAccessManager.replaceConfigForTests(null);
  publicAccessManager.resetForTests();
  await assert.doesNotReject(() => assertBrowserProxyHostAllowed("example.com"));
  publicAccessManager.replaceConfigForTests({
    schemaVersion: 1,
    enabled: true,
    webAppUrl: "https://remote-web.example",
    provider: "auto",
    serverId: "server_1234567890abcdefghijklmnop",
    rendezvousReadSecret: "read_secret_1234567890abcdefghijklmnopqrstuv",
    rendezvousWriteSecret: "write_secret_1234567890abcdefghijklmnopqrstu",
    managedAuthUsername: null,
    managedAuthPassword: null,
    credentialsManagerGenerated: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await assert.rejects(
    () => assertBrowserProxyHostAllowed("example.com"),
    /disallowed|not allowed|Could not resolve/i
  );
});

test("disable stops only the owned child and status redacts password and write secret", async () => {
  const child = new FakeChild();
  const manager = makeManager({ child });
  const result = await manager.enable({ webAppUrl: "https://web.example" });
  assert.equal(result.status.tunnel.running, true);
  assert.ok(result.generatedCredentials);
  assert.equal(JSON.stringify(result.status).includes(result.generatedCredentials.password), false);
  assert.equal(JSON.stringify(result.status).includes("write_secret"), false);
  const disabled = await manager.disable();
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
  const statusJson = JSON.stringify(disabled);
  assert.equal(statusJson.includes("rendezvousWriteSecret"), false);
  assert.equal(statusJson.includes("managedAuthPassword"), false);
  assert.equal(disabled.publicUrl, null);
});

test("status reports Tailscale as optional when the CLI is missing", async () => {
  const manager = makeManager({
    findExecutable: async (name) => (name === "ssh" ? "/usr/bin/ssh" : null),
  });
  const status = await manager.getStatus();
  assert.equal(status.tailscale.installed, false);
  assert.match(status.tailscale.doctor, /not installed/);
});

test("auto still prefers localhost.run when ssh exists even if Tailscale is present", async () => {
  const manager = makeManager({
    findExecutable: async (name) =>
      name === "ssh" ? "/usr/bin/ssh" : name === "tailscale" ? "/usr/bin/tailscale" : null,
    runCommand: async () => {
      throw new Error("auto must not invoke Tailscale");
    },
  });
  const result = await manager.enable({ webAppUrl: "https://web.example" });
  assert.equal(result.status.tunnel.provider, "localhost-run");
  await manager.disable();
});

test("explicit Tailscale provider fails closed without a logged-in CLI", async () => {
  const manager = makeManager({
    findExecutable: async (name) => (name === "ssh" ? "/usr/bin/ssh" : null),
  });
  await assert.rejects(
    () => manager.enable({ webAppUrl: "https://web.example", provider: "tailscale" }),
    /Tailscale CLI is not installed/
  );
  const status = await manager.getStatus();
  assert.equal(status.enabled, false);
});

test("explicit Tailscale provider publishes the MagicDNS URL and a cesium connect fragment", async () => {
  const requests: FetchRequest[] = [];
  const serveConfig = JSON.stringify({
    Web: {
      "home.tail123.ts.net:443": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:9100" } },
      },
    },
  });
  const manager = makeManager({
    fetch: makeFetch(requests),
    findExecutable: async (name) => (name === "tailscale" ? "/usr/bin/tailscale" : null),
    runCommand: async (_command, args) => {
      const key = args.join(" ");
      if (key === "status --json") {
        return {
          code: 0,
          stdout: JSON.stringify({
            BackendState: "Running",
            Self: { DNSName: "home.tail123.ts.net." },
          }),
          stderr: "",
        };
      }
      if (key === "serve status --json") {
        return { code: 0, stdout: serveConfig, stderr: "" };
      }
      throw new Error(`unexpected tailscale ${key}`);
    },
  });
  const result = await manager.enable({
    webAppUrl: "https://web.example",
    provider: "tailscale",
  });
  assert.equal(result.status.enabled, true);
  assert.equal(result.status.publicUrl, "https://home.tail123.ts.net");
  assert.equal(result.status.tunnel.provider, "tailscale");
  assert.equal(result.status.tunnel.running, true);
  assert.match(result.status.connectUrl ?? "", /^https:\/\/web\.example\/agent#cesiumConnect=/);
  assert.equal(result.status.tailscale.loggedIn, true);
  await manager.disable();
  assert.equal((await manager.getStatus()).enabled, false);
});
