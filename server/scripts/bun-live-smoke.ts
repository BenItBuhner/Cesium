import "../src/env-bootstrap.js";

const baseUrl = process.env.OPENCURSOR_BASE?.trim() || "http://127.0.0.1:9100";
const wsUrl = baseUrl.replace(/^http/i, "ws").replace(/\/$/, "") + "/ws/agent";
let authToken = process.env.OPENCURSOR_SESSION_TOKEN?.trim() || "";
let workspaceId = process.env.PERF_WORKSPACE_ID?.trim() || "";
let conversationId = process.env.PERF_CONVERSATION_ID?.trim() || "";

function headers(workspace = true): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(authToken ? { "x-opencursor-session-token": authToken } : {}),
    ...(workspace && workspaceId ? { "x-opencursor-workspace-id": workspaceId } : {}),
  };
}

async function loginIfNeeded(): Promise<void> {
  if (authToken) {
    return;
  }
  const username = process.env.OPENCURSOR_AUTH_USERNAME?.trim();
  const password = process.env.OPENCURSOR_AUTH_PASSWORD?.trim();
  if (!username || !password) {
    return;
  }
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, remember: true }),
  });
  if (!response.ok) {
    throw new Error(`Login failed: ${response.status} ${await response.text()}`);
  }
  authToken = response.headers.get("x-opencursor-session-token") ?? "";
}

async function api<T>(route: string, init?: RequestInit, workspace = true): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: { ...headers(workspace), ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(`${route} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function discoverContext(): Promise<void> {
  await loginIfNeeded();
  if (!workspaceId) {
    const bootstrap = await api<{
      startupWorkspace?: { id?: string };
      workspaces?: Array<{ id: string }>;
    }>("/api/workspaces/bootstrap", undefined, false);
    workspaceId = bootstrap.startupWorkspace?.id ?? bootstrap.workspaces?.[0]?.id ?? "";
  }
  if (!workspaceId) {
    throw new Error("No workspace available.");
  }
  if (!conversationId) {
    const list = await api<{ conversations?: Array<{ id: string }> }>(
      "/api/agents/conversations?limit=1"
    );
    conversationId = list.conversations?.[0]?.id ?? "";
  }
  if (!conversationId) {
    const created = await api<{ conversation: { id: string } }>("/api/agents/conversations", {
      method: "POST",
      body: JSON.stringify({ title: `Bun smoke ${Date.now()}` }),
    });
    conversationId = created.conversation.id;
  }
}

async function wsSnapshotSmoke(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    const url = wsUrlWithAuth(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(String(url));
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Timed out waiting for snapshot_head."));
      }, 10_000);
      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            type: "subscribe",
            conversationIds: [conversationId],
            sinceByConversationId: {},
          })
        );
      });
      ws.addEventListener("message", (event) => {
        const data = JSON.parse(String(event.data)) as { type?: string };
        if (data.type === "snapshot_head") {
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
        if (data.type === "error") {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(`WS error: ${String(event.data)}`));
        }
      });
      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket connection failed."));
      });
    });
  }
}

function wsUrlWithAuth(base: string): URL {
  const url = new URL(base);
  url.searchParams.set("workspaceId", workspaceId);
  if (authToken) {
    url.searchParams.set("access_token", authToken);
  }
  return url;
}

async function fsSocketSmoke(): Promise<void> {
  const url = wsUrlWithAuth(baseUrl.replace(/^http/i, "ws").replace(/\/$/, "") + "/ws/fs");
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(String(url));
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out waiting for fs ready."));
    }, 10_000);
    ws.addEventListener("message", (event) => {
      const data = JSON.parse(String(event.data)) as { type?: string };
      if (data.type === "ready") {
        clearTimeout(timeout);
        ws.close();
        resolve();
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("FS WebSocket connection failed."));
    });
  });
}

async function terminalSocketSmoke(): Promise<void> {
  const created = await api<{ id: string }>("/api/terminals", {
    method: "POST",
    body: JSON.stringify({}),
  });
  const url = wsUrlWithAuth(
    baseUrl.replace(/^http/i, "ws").replace(/\/$/, "") + `/ws/terminal/${created.id}`
  );
  const marker = `__LIVE_TERM_${Date.now()}__`;
  const expected = `OUT:${marker}`;
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(String(url));
    let sawMetadata = false;
    let output = "";
    const timeout = setTimeout(() => {
      ws.close();
      reject(
        new Error(
          sawMetadata
            ? `Timed out waiting for terminal PTY output containing ${expected}. Got: ${JSON.stringify(output)}`
            : "Timed out waiting for terminal metadata."
        )
      );
    }, 10_000);
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        try {
          const data = JSON.parse(event.data) as { type?: string };
          if (data.type === "metadata") {
            sawMetadata = true;
            // Prefix avoids matching local echo of the typed command alone.
            ws.send(new TextEncoder().encode(`printf 'OUT:%s\\n' '${marker}'\n`));
          }
        } catch {
          // ignore non-json text
        }
        return;
      }
      const chunk = new TextDecoder().decode(event.data as ArrayBuffer);
      output += chunk;
      if (output.includes(expected)) {
        clearTimeout(timeout);
        ws.close();
        resolve();
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Terminal WebSocket connection failed."));
    });
  });
  await api(`/api/terminals/${created.id}`, { method: "DELETE" });
}

async function browserDebugSmoke(): Promise<void> {
  const created = await api<{ sessionId: string }>("/api/browser-debug/sessions", {
    method: "POST",
    body: JSON.stringify({ targetUrl: "about:blank" }),
  });
  await api(`/api/browser-debug/sessions/${created.sessionId}`);
  await api(`/api/browser-debug/sessions/${created.sessionId}`, { method: "DELETE" });
}

await discoverContext();
await api("/health", undefined, false);
await api("/api/agents/conversations?limit=1");
await api(`/api/agents/conversations/${conversationId}`);
await wsSnapshotSmoke();
await fsSocketSmoke();
await terminalSocketSmoke();
const checks = [
  "health",
  "bootstrap",
  "conversation.list",
  "conversation.head",
  "ws.snapshot_head",
  "ws.fs.ready",
  "ws.terminal.pty-output",
];
if (process.env.BUN_SMOKE_BROWSER_DEBUG === "1") {
  await browserDebugSmoke();
  checks.push("browser-debug.session");
}

console.log(
  JSON.stringify(
    {
      ok: true,
      runtime: "bun",
      baseUrl,
      workspaceId,
      conversationId,
      checks,
    },
    null,
    2
  )
);
