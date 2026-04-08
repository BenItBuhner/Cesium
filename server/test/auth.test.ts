import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `opencursor-auth-tests-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
process.env.OPENCURSOR_AUTH_USERNAME = "demo";
process.env.OPENCURSOR_AUTH_PASSWORD = "super-secret";
process.env.OPENCURSOR_AUTH_ROTATION_INTERVAL_MS = "5";
process.env.WORKSPACE_ROOT = repoRoot;
process.env.WORKSPACE_ALLOWED_ROOTS = repoRoot;

const [
  { createApp },
  { authenticateUpgradeRequest, buildUpgradeHttpResponse, SESSION_TOKEN_HEADER, ACCESS_TOKEN_QUERY_PARAM },
  { handleAgentUpgrade },
] = await Promise.all([
  import("../src/app.js"),
  import("../src/lib/auth.js"),
  import("../src/ws/agent.js"),
]);

after(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
});

async function startTestServer(): Promise<{ server: Server; baseUrl: string; wsBaseUrl: string }> {
  const app = createApp({
    allowedOrigins: ["http://127.0.0.1:3000", "http://localhost:3000"],
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const request = new Request(url, {
      method: req.method,
      headers: req.headers as HeadersInit,
      body:
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : (req as unknown as BodyInit),
      duplex: "half",
    });

    void app.fetch(request).then(async (response) => {
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === "set-cookie") {
          const existing = res.getHeader("set-cookie");
          if (existing === undefined) {
            res.setHeader("set-cookie", [value]);
          } else {
            res.setHeader("set-cookie", [...(Array.isArray(existing) ? existing : [String(existing)]), value]);
          }
          return;
        }
        res.setHeader(key, value);
      });
      if (!response.body) {
        res.end();
        return;
      }
      const body = Buffer.from(await response.arrayBuffer());
      res.end(body);
    }, (error) => {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : "Internal error");
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/ws/agent") {
      void authenticateUpgradeRequest(request, "ws-agent").then((result) => {
        if (!result.ok) {
          socket.write(buildUpgradeHttpResponse(result));
          socket.destroy();
          return;
        }
        handleAgentUpgrade(request, socket, head);
      });
      return;
    }
    socket.destroy();
  });

  server.listen(0, "127.0.0.1");
  if (!server.listening) {
    await once(server, "listening");
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port for auth test server.");
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    wsBaseUrl: `ws://127.0.0.1:${address.port}`,
  };
}

async function stopTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function login(baseUrl: string, options?: {
  username?: string;
  password?: string;
  remember?: boolean;
  forwardedFor?: string;
}): Promise<Response> {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options?.forwardedFor ? { "x-forwarded-for": options.forwardedFor } : {}),
    },
    body: JSON.stringify({
      username: options?.username ?? "demo",
      password: options?.password ?? "super-secret",
      remember: options?.remember ?? true,
    }),
  });
}

test("protected routes require login and session tokens unlock them", async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(() => stopTestServer(server));

  const unauthenticated = await fetch(`${baseUrl}/api/workspaces/bootstrap`);
  assert.equal(unauthenticated.status, 401);

  const statusBefore = await fetch(`${baseUrl}/api/auth/status`);
  assert.equal(statusBefore.status, 200);
  const statusBeforePayload = (await statusBefore.json()) as {
    enabled: boolean;
    authenticated: boolean;
  };
  assert.equal(statusBeforePayload.enabled, true);
  assert.equal(statusBeforePayload.authenticated, false);

  const loginResponse = await login(baseUrl);
  assert.equal(loginResponse.status, 200);
  const token = loginResponse.headers.get(SESSION_TOKEN_HEADER);
  assert.ok(token, "expected login response to include a session token");

  const authenticated = await fetch(`${baseUrl}/api/workspaces/bootstrap`, {
    headers: {
      [SESSION_TOKEN_HEADER]: token!,
    },
  });
  assert.equal(authenticated.status, 200);
  const bootstrap = (await authenticated.json()) as {
    workspaces: Array<{ id: string; root: string }>;
  };
  assert.ok(bootstrap.workspaces.length > 0, "expected bootstrap workspace data");

  const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: {
      [SESSION_TOKEN_HEADER]: token!,
    },
  });
  assert.equal(logoutResponse.status, 200);

  const afterLogout = await fetch(`${baseUrl}/api/workspaces/bootstrap`, {
    headers: {
      [SESSION_TOKEN_HEADER]: token!,
    },
  });
  assert.equal(afterLogout.status, 401);
});

test("session tokens rotate through auth status checks", async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(() => stopTestServer(server));

  const loginResponse = await login(baseUrl);
  assert.equal(loginResponse.status, 200);
  const firstToken = loginResponse.headers.get(SESSION_TOKEN_HEADER);
  assert.ok(firstToken, "expected a token from login");

  await delay(15);

  const statusResponse = await fetch(`${baseUrl}/api/auth/status`, {
    headers: {
      [SESSION_TOKEN_HEADER]: firstToken!,
    },
  });
  assert.equal(statusResponse.status, 200);
  const rotatedToken = statusResponse.headers.get(SESSION_TOKEN_HEADER);
  assert.ok(rotatedToken, "expected auth status to rotate the session token");
  assert.notEqual(rotatedToken, firstToken);

  const statusPayload = (await statusResponse.json()) as {
    authenticated: boolean;
    session: { username: string } | null;
  };
  assert.equal(statusPayload.authenticated, true);
  assert.equal(statusPayload.session?.username, "demo");
});

test("login attempts are rate-limited per client", async (t) => {
  const previousLimit = process.env.OPENCURSOR_LOGIN_RATE_LIMIT;
  process.env.OPENCURSOR_LOGIN_RATE_LIMIT = "1";
  t.after(() => {
    process.env.OPENCURSOR_LOGIN_RATE_LIMIT = previousLimit;
  });

  const { server, baseUrl } = await startTestServer();
  t.after(() => stopTestServer(server));

  const firstAttempt = await login(baseUrl, {
    password: "wrong-password",
    forwardedFor: "198.51.100.10",
  });
  assert.equal(firstAttempt.status, 401);

  const secondAttempt = await login(baseUrl, {
    password: "wrong-password",
    forwardedFor: "198.51.100.10",
  });
  assert.equal(secondAttempt.status, 429);

  const thirdAttempt = await login(baseUrl, {
    password: "wrong-password",
    forwardedFor: "198.51.100.11",
  });
  assert.equal(thirdAttempt.status, 401);
});

test("agent websocket upgrades reject unauthenticated clients and accept valid tokens", async (t) => {
  const { server, baseUrl, wsBaseUrl } = await startTestServer();
  t.after(() => stopTestServer(server));

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${wsBaseUrl}/ws/agent?workspaceId=test-workspace`);
    ws.once("open", () => {
      ws.close();
      reject(new Error("Unauthenticated websocket unexpectedly opened."));
    });
    ws.once("unexpected-response", (_request, response) => {
      ws.terminate();
      if (response.statusCode === 401) {
        resolve();
        return;
      }
      reject(new Error(`Expected 401, received ${response.statusCode ?? 0}.`));
    });
    ws.once("error", (error) => {
      reject(error);
    });
  });

  const loginResponse = await login(baseUrl);
  const token = loginResponse.headers.get(SESSION_TOKEN_HEADER);
  assert.ok(token, "expected login response to include a websocket token");

  await new Promise<void>((resolve, reject) => {
    const url = new URL(`${wsBaseUrl}/ws/agent`);
    url.searchParams.set("workspaceId", "test-workspace");
    url.searchParams.set(ACCESS_TOKEN_QUERY_PARAM, token!);

    const ws = new WebSocket(url.toString());
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error("Timed out waiting for authenticated websocket connection."));
    }, 5000);

    ws.once("message", (data) => {
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(String(data)) as { type?: string };
        assert.equal(parsed.type, "connected");
        ws.close();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    ws.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
});
