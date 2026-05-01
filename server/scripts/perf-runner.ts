import "../src/env-bootstrap.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";

type ScenarioResult = {
  name: string;
  samples: number[];
  bytes: number[];
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  avgBytes: number;
  rateLimited: number;
  failures: string[];
  baselineP95?: number;
  p95DeltaPct?: number;
};

type ApiTiming = {
  ms: number;
  status: number;
  bytes: number;
  serverMs: number | null;
  rateLimitRetries: number;
  body: unknown;
};

const baseUrl = process.env.OPENCURSOR_BASE?.trim() || "http://127.0.0.1:9100";
const wsUrl =
  process.env.OPENCURSOR_WS?.trim() ||
  baseUrl.replace(/^http/i, "ws").replace(/\/$/, "") + "/ws/agent";
let workspaceId = process.env.PERF_WORKSPACE_ID?.trim() || "";
let conversationId = process.env.PERF_CONVERSATION_ID?.trim() || "";
let authToken = process.env.OPENCURSOR_SESSION_TOKEN?.trim() || "";
const repetitions = Math.max(
  1,
  Number.parseInt(process.env.PERF_REPETITIONS ?? "20", 10) || 20
);
const requestTimeoutMs = Math.max(
  1_000,
  Number.parseInt(process.env.PERF_REQUEST_TIMEOUT_MS ?? "15000", 10) || 15_000
);
const mutationDelayMs = Math.max(
  0,
  Number.parseInt(process.env.PERF_MUTATION_DELAY_MS ?? "125", 10) || 0
);
const retryRateLimits = process.env.PERF_RETRY_429 !== "0";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function delayBeforeMutationIteration(index: number): Promise<void> {
  if (index > 0 && mutationDelayMs > 0) {
    await delay(mutationDelayMs);
  }
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1)
  );
  return sorted[index]!;
}

function summarize(name: string, samples: number[], failures: string[]): ScenarioResult {
  return {
    name,
    samples,
    bytes: [],
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    min: samples.length ? Math.min(...samples) : 0,
    max: samples.length ? Math.max(...samples) : 0,
    avgBytes: 0,
    rateLimited: failures.filter((failure) => failure.includes("429")).length,
    failures,
  };
}

function summarizeTimings(
  name: string,
  timings: Array<{ ms: number; bytes: number; rateLimitRetries?: number }>,
  failures: string[]
): ScenarioResult {
  const samples = timings.map((timing) => timing.ms);
  const bytes = timings.map((timing) => timing.bytes);
  return {
    ...summarize(name, samples, failures),
    bytes,
    avgBytes: bytes.length
      ? Math.round(bytes.reduce((sum, value) => sum + value, 0) / bytes.length)
      : 0,
    rateLimited:
      failures.filter((failure) => failure.includes("429")).length +
      timings.reduce((sum, timing) => sum + (timing.rateLimitRetries ?? 0), 0),
  };
}

function headers(
  extra?: HeadersInit,
  options?: { skipWorkspace?: boolean }
): Record<string, string> {
  const extraHeaders = new Headers(extra);
  return {
    "Content-Type": "application/json",
    ...(workspaceId && !options?.skipWorkspace
      ? { "x-opencursor-workspace-id": workspaceId }
      : {}),
    ...(authToken ? { "x-opencursor-session-token": authToken } : {}),
    ...Object.fromEntries(extraHeaders.entries()),
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
    throw new Error(`Perf login failed: ${response.status} ${await response.text()}`);
  }
  authToken = response.headers.get("x-opencursor-session-token") ?? "";
}

async function discoverTargetContext(): Promise<void> {
  await loginIfNeeded();
  if (!workspaceId) {
    const bootstrap = await api("/api/workspaces/bootstrap", undefined, {
      skipWorkspace: true,
    });
    if (bootstrap.status >= 400) {
      throw new Error(`Workspace bootstrap failed: ${bootstrap.status}`);
    }
    const body = bootstrap.body as {
      startupWorkspace?: { id?: string };
      workspaces?: Array<{ id: string }>;
    };
    workspaceId = body.startupWorkspace?.id ?? body.workspaces?.[0]?.id ?? "";
  }
  if (!workspaceId) {
    throw new Error("No workspace available for perf run.");
  }
  if (!conversationId) {
    const list = await api("/api/agents/conversations?limit=1");
    if (list.status >= 400) {
      throw new Error(`Conversation discovery failed: ${list.status}`);
    }
    const body = list.body as { conversations?: Array<{ id: string }> };
    conversationId = body.conversations?.[0]?.id ?? "";
  }
  if (!conversationId) {
    const created = await api("/api/agents/conversations", {
      method: "POST",
      body: JSON.stringify({ title: `Perf target ${Date.now()}` }),
    });
    if (created.status >= 400) {
      throw new Error(`Perf target conversation create failed: ${created.status}`);
    }
    const body = created.body as { conversation?: { id: string } };
    conversationId = body.conversation?.id ?? "";
  }
  if (!conversationId) {
    throw new Error("No conversation available for perf run.");
  }
}

async function api(
  route: string,
  init?: RequestInit,
  options?: { skipWorkspace?: boolean }
): Promise<ApiTiming> {
  const startedAt = performance.now();
  let response: Response;
  let text = "";
  let rateLimitRetries = 0;
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      response = await fetch(`${baseUrl}${route}`, {
        ...init,
        headers: headers(init?.headers, options),
        signal: controller.signal,
      });
      text = await response.text();
    } finally {
      clearTimeout(timeout);
    }
    if (response.status !== 429 || !retryRateLimits || attempt >= 1) {
      break;
    }
    rateLimitRetries += 1;
    const retryAfterMs = Math.min(
      Math.max(
        250,
        Number.parseFloat(response.headers.get("retry-after") ?? "1") * 1000 || 1000
      ),
      10_000
    );
    await delay(retryAfterMs);
  }
  const ms = performance.now() - startedAt;
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return {
    ms,
    status: response.status,
    bytes: Buffer.byteLength(text),
    serverMs:
      Number.parseFloat(response.headers.get("x-opencursor-perf-ms") ?? "") || null,
    rateLimitRetries,
    body,
  };
}

async function runApiScenario(
  name: string,
  route: string,
  init?: RequestInit,
  options?: { skipWorkspace?: boolean }
): Promise<ScenarioResult> {
  const timings: Array<{ ms: number; bytes: number }> = [];
  const failures: string[] = [];
  for (let i = 0; i < repetitions; i += 1) {
    try {
      if (i === 0) {
        console.log(`[perf] ${name}`);
      }
      const result = await api(route, init, options);
      if (result.status >= 400) {
        failures.push(`${result.status}: ${JSON.stringify(result.body).slice(0, 300)}`);
      } else {
        timings.push({
          ms: result.ms,
          bytes: result.bytes,
          rateLimitRetries: result.rateLimitRetries,
        });
      }
      if (mutationDelayMs > 0) {
        await delay(mutationDelayMs);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return summarizeTimings(name, timings, failures);
}

async function runWsSnapshotScenario(): Promise<ScenarioResult> {
  if (!workspaceId || !conversationId) {
    return summarize("ws.snapshot_head", [], ["PERF_WORKSPACE_ID and PERF_CONVERSATION_ID are required"]);
  }
  const samples: number[] = [];
  const failures: string[] = [];
  for (let i = 0; i < repetitions; i += 1) {
    const startedAt = performance.now();
    await new Promise<void>((resolve) => {
      const url = new URL(wsUrl);
      url.searchParams.set("workspaceId", workspaceId);
      const socket = new WebSocket(url, {
        headers: authToken ? { "x-opencursor-session-token": authToken } : undefined,
      });
      const fail = (message: string) => {
        failures.push(message);
        socket.close();
        resolve();
      };
      const timer = setTimeout(() => fail("timeout"), 10_000);
      socket.on("open", () => {
        socket.send(
          JSON.stringify({
            type: "subscribe",
            conversationIds: [conversationId],
            sinceByConversationId: { [conversationId]: 0 },
          })
        );
      });
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type?: string };
        if (message.type === "snapshot_head") {
          clearTimeout(timer);
          samples.push(performance.now() - startedAt);
          socket.close();
          resolve();
        }
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        fail(error.message);
      });
    });
  }
  return summarize("ws.snapshot_head", samples, failures);
}

async function runPromptAckScenario(): Promise<ScenarioResult> {
  const samples: number[] = [];
  const failures: string[] = [];
  for (let i = 0; i < repetitions; i += 1) {
    if (i === 0) {
      console.log("[perf] conversation.prompt_ack");
    }
    await delayBeforeMutationIteration(i);
    try {
      const created = await api("/api/agents/conversations", {
        method: "POST",
        body: JSON.stringify({ title: `Perf prompt target ${Date.now()}-${i}` }),
      });
      if (created.status >= 400) {
        failures.push(`create ${created.status}: ${JSON.stringify(created.body).slice(0, 300)}`);
        continue;
      }
      const body = created.body as { conversation?: { id: string } };
      const targetId = body.conversation?.id;
      if (!targetId) {
        failures.push("create did not return conversation id");
        continue;
      }
      const result = await api(
        `/api/agents/conversations/${encodeURIComponent(targetId)}/prompt`,
        {
          method: "POST",
          body: JSON.stringify({ text: `perf ping ${Date.now()}` }),
        }
      );
      if (result.status >= 400) {
        failures.push(`${result.status}: ${JSON.stringify(result.body).slice(0, 300)}`);
      } else {
        samples.push(result.ms);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return summarize("conversation.prompt_ack", samples, failures);
}

async function listFirstConversation(): Promise<{ id: string; title: string } | null> {
  const result = await api("/api/agents/conversations?limit=1");
  if (result.status >= 400) {
    throw new Error(`list first failed: ${result.status}`);
  }
  const body = result.body as { conversations?: Array<{ id: string; title: string }> };
  return body.conversations?.[0] ?? null;
}

async function listConversationPage(
  limit = 50
): Promise<Array<{ id: string; title: string }>> {
  const result = await api(`/api/agents/conversations?limit=${limit}`);
  if (result.status >= 400) {
    throw new Error(`list page failed: ${result.status}`);
  }
  const body = result.body as { conversations?: Array<{ id: string; title: string }> };
  return body.conversations ?? [];
}

async function runRailCreatePositionScenario(): Promise<ScenarioResult> {
  const samples: number[] = [];
  const failures: string[] = [];
  for (let i = 0; i < repetitions; i += 1) {
    if (i === 0) {
      console.log("[perf] rail.create_position");
    }
    await delayBeforeMutationIteration(i);
    try {
      const title = `Rail create ${Date.now()}-${i}`;
      const startedAt = performance.now();
      const created = await api("/api/agents/conversations", {
        method: "POST",
        body: JSON.stringify({ title }),
      });
      if (created.status >= 400) {
        failures.push(`create ${created.status}: ${JSON.stringify(created.body).slice(0, 300)}`);
        continue;
      }
      const body = created.body as { conversation?: { id: string } };
      const first = await listFirstConversation();
      if (first?.id !== body.conversation?.id) {
        failures.push(`created row was not first: ${first?.id ?? "none"}`);
        continue;
      }
      samples.push(performance.now() - startedAt);
      if (mutationDelayMs > 0) {
        await delay(mutationDelayMs);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return summarize("rail.create_position", samples, failures);
}

async function runRailRenameScenario(): Promise<ScenarioResult> {
  const samples: number[] = [];
  const failures: string[] = [];
  for (let i = 0; i < repetitions; i += 1) {
    if (i === 0) {
      console.log("[perf] rail.rename");
    }
    await delayBeforeMutationIteration(i);
    try {
      const created = await api("/api/agents/conversations", {
        method: "POST",
        body: JSON.stringify({ title: `Rail rename target ${Date.now()}-${i}` }),
      });
      const body = created.body as { conversation?: { id: string } };
      const id = body.conversation?.id;
      if (created.status >= 400 || !id) {
        failures.push(`create ${created.status}: ${JSON.stringify(created.body).slice(0, 300)}`);
        continue;
      }
      const title = `Rail renamed ${Date.now()}-${i}`;
      const startedAt = performance.now();
      const renamed = await api(`/api/agents/conversations/${encodeURIComponent(id)}/config`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      if (renamed.status >= 400) {
        failures.push(`rename ${renamed.status}: ${JSON.stringify(renamed.body).slice(0, 300)}`);
        continue;
      }
      const row = (await listConversationPage()).find((conversation) => conversation.id === id);
      if (row?.title !== title) {
        failures.push(`renamed row mismatch: ${row?.id ?? "none"} ${row?.title ?? ""}`);
        continue;
      }
      samples.push(performance.now() - startedAt);
      if (mutationDelayMs > 0) {
        await delay(mutationDelayMs);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return summarize("rail.rename", samples, failures);
}

async function runRailPositionAfterPromptScenario(): Promise<ScenarioResult> {
  const samples: number[] = [];
  const failures: string[] = [];
  for (let i = 0; i < repetitions; i += 1) {
    if (i === 0) {
      console.log("[perf] rail.position_after_prompt");
    }
    await delayBeforeMutationIteration(i);
    try {
      const target = await api("/api/agents/conversations", {
        method: "POST",
        body: JSON.stringify({ title: `Rail position target ${Date.now()}-${i}` }),
      });
      if (target.status >= 400) {
        failures.push(`target create ${target.status}: ${JSON.stringify(target.body).slice(0, 300)}`);
        continue;
      }
      const targetId = (target.body as { conversation?: { id: string } }).conversation?.id;
      const newer = await api("/api/agents/conversations", {
        method: "POST",
        body: JSON.stringify({ title: `Rail position newer ${Date.now()}-${i}` }),
      });
      if (newer.status >= 400) {
        failures.push(`newer create ${newer.status}: ${JSON.stringify(newer.body).slice(0, 300)}`);
        continue;
      }
      if (!targetId) {
        failures.push("target create did not return id");
        continue;
      }
      const startedAt = performance.now();
      const prompted = await api(
        `/api/agents/conversations/${encodeURIComponent(targetId)}/prompt`,
        {
          method: "POST",
          body: JSON.stringify({ text: `rail position ${Date.now()}` }),
        }
      );
      if (prompted.status >= 400) {
        failures.push(`prompt ${prompted.status}: ${JSON.stringify(prompted.body).slice(0, 300)}`);
        continue;
      }
      const first = await listFirstConversation();
      if (first?.id !== targetId) {
        failures.push(`prompted row was not first: ${first?.id ?? "none"}`);
        continue;
      }
      samples.push(performance.now() - startedAt);
      if (mutationDelayMs > 0) {
        await delay(mutationDelayMs);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return summarize("rail.position_after_prompt", samples, failures);
}

async function main(): Promise<void> {
  await discoverTargetContext();
  const scenarios: ScenarioResult[] = [];
  scenarios.push(
    await runApiScenario("settings.models", "/api/settings/models")
  );
  scenarios.push(
    await runApiScenario("settings.models_by_backend", "/api/settings/models-by-backend")
  );
  scenarios.push(
    await runApiScenario("auth.status", "/api/auth/status", undefined, {
      skipWorkspace: true,
    })
  );
  scenarios.push(
    await runApiScenario("workspace.windows", `/api/workspaces/${workspaceId}/windows`)
  );
  scenarios.push(
    await runApiScenario("fs.tree", "/api/fs/tree?depth=2")
  );
  scenarios.push(
    await runApiScenario("terminals.list", "/api/terminals")
  );
  scenarios.push(
    await runApiScenario("storage.status", "/api/storage/status", undefined, {
      skipWorkspace: true,
    })
  );
  scenarios.push(
    await runApiScenario("conversations.list", "/api/agents/conversations?limit=50")
  );
  scenarios.push(
    await runApiScenario("conversations.all", "/api/agents/conversations/all?limit=50", undefined, {
      skipWorkspace: true,
    })
  );
  if (conversationId) {
    scenarios.push(
      await runApiScenario(
        "conversation.head",
        `/api/agents/conversations/${encodeURIComponent(conversationId)}`
      )
    );
    scenarios.push(await runWsSnapshotScenario());
  }
  scenarios.push(await runPromptAckScenario());
  scenarios.push(await runRailCreatePositionScenario());
  scenarios.push(await runRailRenameScenario());
  scenarios.push(await runRailPositionAfterPromptScenario());
  scenarios.push(
    await runApiScenario("conversation.create", "/api/agents/conversations", {
      method: "POST",
      body: JSON.stringify({ title: `Perf create ${Date.now()}` }),
    })
  );

  const baselinePath = process.env.PERF_BASELINE_FILE?.trim();
  if (baselinePath) {
    try {
      const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as {
        scenarios?: ScenarioResult[];
      };
      const baselineByName = new Map(
        (baseline.scenarios ?? []).map((scenario) => [scenario.name, scenario])
      );
      for (const scenario of scenarios) {
        const previous = baselineByName.get(scenario.name);
        if (!previous || previous.p95 <= 0) {
          continue;
        }
        scenario.baselineP95 = previous.p95;
        scenario.p95DeltaPct = ((scenario.p95 - previous.p95) / previous.p95) * 100;
      }
    } catch (error) {
      console.warn("[perf] failed to compare baseline:", error);
    }
  }

  const report = {
    at: new Date().toISOString(),
    baseUrl,
    wsUrl,
    workspaceId,
    conversationId,
    repetitions,
    requestTimeoutMs,
    mutationDelayMs,
    scenarios,
  };
  const outDir = path.join(process.cwd(), "tmp", "perf-runs");
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `perf-${Date.now()}.json`);
  await writeFile(outFile, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`perf report written to ${outFile}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
