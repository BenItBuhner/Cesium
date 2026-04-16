import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { newDb } from "pg-mem";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `opencursor-auth-tests-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
process.env.OPENCURSOR_AUTH_USERNAME = "testadmin";
process.env.OPENCURSOR_AUTH_PASSWORD = "hunter2";
process.env.OPENCURSOR_AUTH_ROTATION_INTERVAL_MS = "500";
process.env.OPENCURSOR_AUTH_SESSION_TTL_MS = "60000";
process.env.OPENCURSOR_REDIS_URL = "redis://127.0.0.1:6380";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

const db = newDb();
const pgAdapter = db.adapters.createPg();
const redisPort = 6380;
const redisDataDir = path.join(TEST_DATA_DIR, "redis");

const { ensureDataDir } = await import("../src/lib/persistence.js");
await ensureDataDir();
const {
  configureStorageForTests,
  resetStorageForTests,
} = await import("../src/lib/storage.js");
const {
  configureRedisForTests,
  resetRedisForTests,
} = await import("../src/lib/redis-coordination.js");

await configureStorageForTests({
  driver: "postgres",
  postgresPool: new pgAdapter.Pool(),
});
await configureRedisForTests({
  mode: "redis",
  url: process.env.OPENCURSOR_REDIS_URL,
});

const { Hono } = await import("hono");
const {
  authMiddleware,
  authenticateRequest,
  checkRequestRateLimit,
  getAuthStorageMode,
  isAuthEnabled,
  loginWithCredentials,
  SESSION_TOKEN_HEADER,
  SESSION_COOKIE_NAME,
  authenticateUpgradeRequest,
  buildUpgradeHttpResponse,
} = await import("../src/lib/auth.js");
const { authRoutes } = await import("../src/routes/auth.js");

function makeApp() {
  const app = new Hono();
  app.use("*", authMiddleware);
  app.route("/", authRoutes);
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/api/test", (c) => c.json({ hello: "world" }));
  app.post("/api/test", (c) => c.json({ hello: "post" }));
  return app;
}

let loginIpCounter = 0;
function nextUniqueIp(): string {
  return `192.168.99.${++loginIpCounter}`;
}

async function loginAndGetToken(
  app: ReturnType<typeof makeApp>,
  options?: { remember?: boolean; ip?: string }
): Promise<{ token: string; cookie: string; ip: string }> {
  const ip = options?.ip ?? nextUniqueIp();
  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({
      username: "testadmin",
      password: "hunter2",
      remember: options?.remember ?? false,
    }),
  });
  assert.equal(response.status, 200);
  const token = response.headers.get(SESSION_TOKEN_HEADER);
  assert.ok(token, "Login response should include session token header");
  const setCookie = response.headers.get("set-cookie") ?? "";
  return { token, cookie: setCookie, ip };
}

before(async () => {
  const fs = await import("node:fs/promises");
  await fs.mkdir(redisDataDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    execFile(
      "redis-server",
      [
        "--save",
        "",
        "--appendonly",
        "no",
        "--port",
        String(redisPort),
        "--bind",
        "127.0.0.1",
        "--dir",
        redisDataDir,
      ],
      { cwd: repoRoot },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }
    );
    setTimeout(resolve, 400);
  });
});

after(async () => {
  const fs = await import("node:fs/promises");
  await resetStorageForTests();
  await resetRedisForTests();
  await new Promise<void>((resolve) => {
    execFile(
      "redis-cli",
      ["-p", String(redisPort), "shutdown", "nosave"],
      { cwd: repoRoot },
      () => resolve()
    );
  });
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
  delete process.env.OPENCURSOR_AUTH_USERNAME;
  delete process.env.OPENCURSOR_AUTH_PASSWORD;
  delete process.env.OPENCURSOR_AUTH_ROTATION_INTERVAL_MS;
  delete process.env.OPENCURSOR_AUTH_SESSION_TTL_MS;
  delete process.env.OPENCURSOR_REDIS_URL;
});

describe("auth enabled detection", () => {
  test("isAuthEnabled returns true when both env vars are set", () => {
    assert.ok(isAuthEnabled());
  });

  test("auth rate limits run through redis coordination", () => {
    assert.equal(getAuthStorageMode(), "redis");
  });
});

describe("login flow", () => {
  test("successful login returns a session token", async () => {
    const app = makeApp();
    const { token } = await loginAndGetToken(app);
    assert.ok(token.startsWith("v1."), "Token should start with v1. prefix");
  });

  test("login with wrong password returns 401", async () => {
    const app = makeApp();
    const response = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "testadmin",
        password: "wrongpassword",
        remember: false,
      }),
    });
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error: string };
    assert.ok(body.error);
  });

  test("login with wrong username returns 401", async () => {
    const app = makeApp();
    const response = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "wronguser",
        password: "hunter2",
        remember: false,
      }),
    });
    assert.equal(response.status, 401);
  });

  test("login without body returns 400", async () => {
    const app = makeApp();
    const response = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 400);
  });
});

describe("session validation", () => {
  test("authenticated request to protected route succeeds", async () => {
    const app = makeApp();
    const { token, ip } = await loginAndGetToken(app);
    const response = await app.request("/api/test", {
      headers: { [SESSION_TOKEN_HEADER]: token, "x-forwarded-for": ip },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { hello: string };
    assert.equal(body.hello, "world");
  });

  test("unauthenticated request to protected route returns 401", async () => {
    const app = makeApp();
    const response = await app.request("/api/test", {
      headers: { "x-forwarded-for": nextUniqueIp() },
    });
    assert.equal(response.status, 401);
  });

  test("request with invalid token returns 401", async () => {
    const app = makeApp();
    const response = await app.request("/api/test", {
      headers: { [SESSION_TOKEN_HEADER]: "v1.bogus.token.data", "x-forwarded-for": nextUniqueIp() },
    });
    assert.equal(response.status, 401);
  });
});

describe("auth status endpoint", () => {
  test("GET /api/auth/status returns enabled and authenticated state", async () => {
    const app = makeApp();
    const { token, ip } = await loginAndGetToken(app);
    const response = await app.request("/api/auth/status", {
      headers: { [SESSION_TOKEN_HEADER]: token, "x-forwarded-for": ip },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      enabled: boolean;
      authenticated: boolean;
      session: unknown;
      rotationIntervalMs: number;
    };
    assert.equal(body.enabled, true);
    assert.equal(body.authenticated, true);
    assert.ok(body.session);
    assert.ok(typeof body.rotationIntervalMs === "number");
  });

  test("GET /api/auth/status without token returns unauthenticated", async () => {
    const app = makeApp();
    const response = await app.request("/api/auth/status", {
      headers: { "x-forwarded-for": nextUniqueIp() },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      enabled: boolean;
      authenticated: boolean;
    };
    assert.equal(body.enabled, true);
    assert.equal(body.authenticated, false);
  });
});

describe("logout", () => {
  test("POST /api/auth/logout invalidates the session", async () => {
    const app = makeApp();
    const { token, ip } = await loginAndGetToken(app);

    const logoutResponse = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { [SESSION_TOKEN_HEADER]: token, "x-forwarded-for": ip },
    });
    assert.equal(logoutResponse.status, 200);

    const protectedResponse = await app.request("/api/test", {
      headers: { [SESSION_TOKEN_HEADER]: token, "x-forwarded-for": ip },
    });
    assert.equal(protectedResponse.status, 401);
  });
});

describe("token rotation", () => {
  test("auth status returns rotated token after rotation interval", async () => {
    const app = makeApp();
    const { token, ip } = await loginAndGetToken(app);

    await new Promise((resolve) => setTimeout(resolve, 600));

    const response = await app.request("/api/auth/status", {
      headers: { [SESSION_TOKEN_HEADER]: token, "x-forwarded-for": ip },
    });
    assert.equal(response.status, 200);
    const rotatedToken = response.headers.get(SESSION_TOKEN_HEADER);
    assert.ok(rotatedToken, "Should have a rotated token header");
    assert.notEqual(rotatedToken, token, "Rotated token should differ from original");

    const protectedResponse = await app.request("/api/test", {
      headers: { [SESSION_TOKEN_HEADER]: rotatedToken, "x-forwarded-for": ip },
    });
    assert.equal(protectedResponse.status, 200);
  });
});

describe("rate limiting", () => {
  test("login rate limit enforced after threshold", async () => {
    const app = makeApp();
    const ip = "10.99.99.250";
    const responses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const response = await app.request("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({
          username: "wronguser",
          password: "wrongpass",
          remember: false,
        }),
      });
      responses.push(response.status);
    }
    assert.ok(
      responses.includes(429),
      `Expected at least one 429 response, got: ${responses.join(", ")}`
    );
  });
});

describe("exempt paths", () => {
  test("/health is accessible without auth", async () => {
    const app = makeApp();
    const response = await app.request("/health");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  });

  test("/api/auth/login is accessible without auth", async () => {
    const app = makeApp();
    const response = await app.request("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": nextUniqueIp(),
      },
      body: JSON.stringify({
        username: "testadmin",
        password: "hunter2",
        remember: false,
      }),
    });
    assert.equal(response.status, 200);
  });

  test("/api/auth/status is accessible without auth", async () => {
    const app = makeApp();
    const response = await app.request("/api/auth/status", {
      headers: { "x-forwarded-for": nextUniqueIp() },
    });
    assert.equal(response.status, 200);
  });
});

describe("WebSocket upgrade auth", () => {
  test("authenticateUpgradeRequest rejects without token", async () => {
    const http = await import("node:http");
    const mockRequest = new http.IncomingMessage(undefined as unknown as import("node:stream").Readable);
    mockRequest.headers = {
      host: "localhost:9100",
      "x-forwarded-for": nextUniqueIp(),
    };
    mockRequest.url = "/ws/agent?workspaceId=test";

    const result = await authenticateUpgradeRequest(mockRequest, "ws-agent");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 401);
    }
  });

  test("buildUpgradeHttpResponse generates valid HTTP/1.1 response", () => {
    const response = buildUpgradeHttpResponse({
      ok: false,
      status: 401,
      message: "Authentication required.",
    });
    assert.ok(response.startsWith("HTTP/1.1 401 Unauthorized"));
    assert.ok(response.includes("Authentication required."));
  });

  test("buildUpgradeHttpResponse includes Retry-After for 429", () => {
    const response = buildUpgradeHttpResponse({
      ok: false,
      status: 429,
      message: "Too many upgrade attempts.",
      retryAfterSec: 30,
    });
    assert.ok(response.startsWith("HTTP/1.1 429 Too Many Requests"));
    assert.ok(response.includes("Retry-After: 30"));
  });
});

describe("auth disabled passthrough", () => {
  test("requests pass through when auth env vars are unset", async () => {
    const savedUsername = process.env.OPENCURSOR_AUTH_USERNAME;
    const savedPassword = process.env.OPENCURSOR_AUTH_PASSWORD;
    delete process.env.OPENCURSOR_AUTH_USERNAME;
    delete process.env.OPENCURSOR_AUTH_PASSWORD;

    try {
      const app = makeApp();
      const response = await app.request("/api/test");
      assert.equal(response.status, 200);
      const body = (await response.json()) as { hello: string };
      assert.equal(body.hello, "world");
    } finally {
      process.env.OPENCURSOR_AUTH_USERNAME = savedUsername;
      process.env.OPENCURSOR_AUTH_PASSWORD = savedPassword;
    }
  });

  test("/api/auth/status reports disabled when env vars unset", async () => {
    const savedUsername = process.env.OPENCURSOR_AUTH_USERNAME;
    const savedPassword = process.env.OPENCURSOR_AUTH_PASSWORD;
    delete process.env.OPENCURSOR_AUTH_USERNAME;
    delete process.env.OPENCURSOR_AUTH_PASSWORD;

    try {
      const app = makeApp();
      const response = await app.request("/api/auth/status");
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        enabled: boolean;
        authenticated: boolean;
      };
      assert.equal(body.enabled, false);
      assert.equal(body.authenticated, true);
    } finally {
      process.env.OPENCURSOR_AUTH_USERNAME = savedUsername;
      process.env.OPENCURSOR_AUTH_PASSWORD = savedPassword;
    }
  });
});
