import "../src/env-bootstrap.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";

type BrowserPerfSample = {
  label: string;
  ms: number;
  at: number;
  fields?: Record<string, string | number | boolean | null | undefined>;
};

const frontendUrl = process.env.OPENCURSOR_FRONTEND?.trim() || "http://127.0.0.1:3000";
const serverBase = process.env.OPENCURSOR_BASE?.trim() || "http://127.0.0.1:9100";
let workspaceId = process.env.PERF_WORKSPACE_ID?.trim() || "";
let conversationId = process.env.PERF_CONVERSATION_ID?.trim() || "";
let authToken = process.env.OPENCURSOR_SESSION_TOKEN?.trim() || "";

function pushSample(
  samples: BrowserPerfSample[],
  label: string,
  startedAt: number,
  fields?: BrowserPerfSample["fields"]
): void {
  samples.push({
    label,
    ms: performance.now() - startedAt,
    at: Date.now(),
    ...(fields ? { fields } : {}),
  });
}

async function api<T>(
  pathName: string,
  init?: RequestInit,
  options?: { workspace?: boolean }
): Promise<T> {
  const response = await fetch(`${serverBase}${pathName}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { "x-opencursor-session-token": authToken } : {}),
      ...(options?.workspace !== false && workspaceId
        ? { "x-opencursor-workspace-id": workspaceId }
        : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${pathName} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

function agentUrl(): string {
  const url = new URL("/", frontendUrl);
  if (conversationId) {
    url.searchParams.set("conversationId", conversationId);
  }
  if (workspaceId) {
    url.searchParams.set("workspaceId", workspaceId);
  }
  url.searchParams.set("view", "agent");
  url.searchParams.set("opencursorPerf", "1");
  url.searchParams.set("serverUrl", serverBase);
  return String(url);
}

function agentNewChatUrl(): string {
  const url = new URL("/", frontendUrl);
  if (workspaceId) {
    url.searchParams.set("workspaceId", workspaceId);
  }
  url.searchParams.set("view", "agent");
  url.searchParams.set("conversationId", "new");
  url.searchParams.set("opencursorPerf", "1");
  url.searchParams.set("serverUrl", serverBase);
  return String(url);
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
  const response = await fetch(`${serverBase}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, remember: true }),
  });
  if (!response.ok) {
    throw new Error(`Perf browser login failed: ${response.status} ${await response.text()}`);
  }
  authToken = response.headers.get("x-opencursor-session-token") ?? "";
}

async function discoverTargetContext(): Promise<void> {
  await loginIfNeeded();
  if (!workspaceId) {
    const body = await api<{
      startupWorkspace?: { id?: string };
      workspaces?: Array<{ id: string }>;
    }>("/api/workspaces/bootstrap", undefined, { workspace: false });
    for (const workspace of body.workspaces ?? []) {
      const status = await api<{ status?: { isGitRepo?: boolean } }>(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/git/status`,
        undefined,
        { workspace: false }
      ).catch(() => null);
      if (status?.status?.isGitRepo) {
        workspaceId = workspace.id;
        break;
      }
    }
    workspaceId = workspaceId || body.startupWorkspace?.id || body.workspaces?.[0]?.id || "";
  }
  if (!conversationId && workspaceId) {
    const body = await api<{ conversations?: Array<{ id: string }> }>(
      "/api/agents/conversations?limit=1"
    );
    conversationId = body.conversations?.[0]?.id ?? "";
  }
}

async function waitForRailRowAtTopOfSection(
  page: Page,
  conversationIdToFind: string
): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const row = document.querySelector(
        `[data-perf="agent-rail-row"][data-conversation-id="${id}"]`
      );
      return row?.getAttribute("data-rail-row-index") === "0";
    },
    conversationIdToFind,
    { timeout: 5_000 }
  );
}

async function runRailBenchmarks(page: Page): Promise<BrowserPerfSample[]> {
  const samples: BrowserPerfSample[] = [];
  const newChatButton = page.locator('[data-perf="agent-rail-new-chat"]').first();
  if (await newChatButton.isVisible().catch(() => false)) {
    const ms = await page.evaluate(`(async () => {
      const button = document.querySelector('[data-perf="agent-rail-new-chat"]');
      if (!button) return 0;
      const startedAt = performance.now();
      button.click();
      await new Promise((resolve, reject) => {
        const deadline = performance.now() + 5000;
        const tick = () => {
          if (new URL(window.location.href).searchParams.get("conversationId") === "new") {
            resolve();
            return;
          }
          if (performance.now() > deadline) {
            reject(new Error("new chat draft did not become visible"));
            return;
          }
          requestAnimationFrame(tick);
        };
        tick();
      });
      return performance.now() - startedAt;
    })()`);
    samples.push({
      label: "rail.new_chat_draft_visible",
      ms,
      at: Date.now(),
    });
  } else {
    samples.push({
      label: "rail.new_chat_draft_visible",
      ms: 0,
      at: Date.now(),
      fields: { skipped: true, reason: "rail new chat button not visible" },
    });
  }

  const createTitle = `Rail perf ${Date.now()}`;
  const createStartedAt = performance.now();
  const created = await api<{ conversation: { id: string } }>("/api/agents/conversations", {
    method: "POST",
    body: JSON.stringify({ title: createTitle }),
  });
  await page
    .locator(`[data-perf="agent-rail-row"][data-conversation-id="${created.conversation.id}"]`)
    .waitFor({ state: "visible", timeout: 5_000 });
  await waitForRailRowAtTopOfSection(page, created.conversation.id);
  pushSample(samples, "rail.create_row_position_visible", createStartedAt, {
    conversationId: created.conversation.id,
  });

  const row = page.locator(
    `[data-perf="agent-rail-row"][data-conversation-id="${created.conversation.id}"]`
  );
  const title = row.locator('[data-perf="agent-rail-row-title"]').first();
  const renameTitle = `Rail renamed ${Date.now()}`;
  await title.dblclick();
  const input = page.locator('[data-perf="agent-rail-rename-input"]').first();
  await input.fill(renameTitle);
  const renameStartedAt = performance.now();
  await input.press("Enter");
  await page
    .locator(
      `[data-perf="agent-rail-row"][data-conversation-id="${created.conversation.id}"] [data-perf="agent-rail-row-title"]`,
      { hasText: renameTitle }
    )
    .waitFor({ state: "visible", timeout: 5_000 });
  pushSample(samples, "rail.rename_visible", renameStartedAt, {
    conversationId: created.conversation.id,
  });

  const positionStartedAt = performance.now();
  await api(`/api/agents/conversations/${encodeURIComponent(created.conversation.id)}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text: `rail position ${Date.now()}` }),
  });
  await waitForRailRowAtTopOfSection(page, created.conversation.id);
  pushSample(samples, "rail.position_after_prompt_visible", positionStartedAt, {
    conversationId: created.conversation.id,
  });

  return samples;
}

async function runSettingsBenchmarks(page: Page): Promise<BrowserPerfSample[]> {
  const samples: BrowserPerfSample[] = [];
  const settingsButton = page.getByRole("button", { name: /open settings/i }).first();
  if (!(await settingsButton.isVisible().catch(() => false))) {
    samples.push({
      label: "settings.models.open_visible",
      ms: 0,
      at: Date.now(),
      fields: { skipped: true, reason: "settings button not visible" },
    });
    return samples;
  }
  const openStartedAt = performance.now();
  await settingsButton.click();
  await page.getByText("Settings", { exact: false }).first().waitFor({ timeout: 5_000 }).catch(() => undefined);
  const modelsNav = page.getByRole("button", { name: /^Models$/i }).first();
  if (await modelsNav.isVisible().catch(() => false)) {
    await modelsNav.click();
  } else {
    await page.getByText("Models", { exact: true }).first().click().catch(() => undefined);
  }
  await page.getByPlaceholder("Search models").first().waitFor({ timeout: 5_000 });
  pushSample(samples, "settings.models.open_visible", openStartedAt);

  const search = page.getByPlaceholder("Search models").first();
  const searchStartedAt = performance.now();
  await search.fill("composer");
  await page.waitForTimeout(50);
  pushSample(samples, "settings.models.search_visible", searchStartedAt);

  const toggle = page.locator('[role="switch"], button[aria-pressed]').first();
  if (await toggle.isVisible().catch(() => false)) {
    const toggleStartedAt = performance.now();
    await toggle.click();
    await page.waitForTimeout(50);
    pushSample(samples, "settings.models.toggle_visible", toggleStartedAt);
  }
  return samples;
}

async function runAgentTargetDropdownBenchmarks(page: Page): Promise<BrowserPerfSample[]> {
  const samples: BrowserPerfSample[] = [];
  await page.goto(agentNewChatUrl(), { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
  const newChatButton = page.locator('[data-perf="agent-rail-new-chat"]').first();
  if (await newChatButton.isVisible().catch(() => false)) {
    await newChatButton.click().catch(() => undefined);
  }
  const codebaseButton = page.locator('[data-perf="agent-codebase-picker-button"]').first();
  if (!(await codebaseButton.isVisible({ timeout: 5_000 }).catch(() => false))) {
    const skipped = {
      at: Date.now(),
      ms: 0,
      fields: { skipped: true, reason: "new chat target controls not visible" },
    };
    return [
      { ...skipped, label: "target.codebase_picker.open_visible" },
      { ...skipped, label: "target.branch_picker.open_visible" },
      { ...skipped, label: "target.worktree_picker.open_visible" },
    ];
  }

  const codebaseOpenStartedAt = performance.now();
  await codebaseButton.click();
  await page.getByRole("menu", { name: "Context menu" }).waitFor({ state: "visible", timeout: 5_000 });
  pushSample(samples, "target.codebase_picker.open_visible", codebaseOpenStartedAt);
  const codebaseCloseStartedAt = performance.now();
  await page.keyboard.press("Escape");
  await page.getByRole("menu", { name: "Context menu" }).waitFor({ state: "hidden", timeout: 5_000 });
  pushSample(samples, "target.codebase_picker.close_visible", codebaseCloseStartedAt);

  const branchButton = page.locator('[data-perf="agent-branch-picker-button"]').first();
  if (await branchButton.isEnabled().catch(() => false)) {
    const branchOpenStartedAt = performance.now();
    await branchButton.click();
    await page
      .locator('[data-perf="agent-branch-picker-popover"]')
      .first()
      .waitFor({ state: "visible", timeout: 5_000 });
    pushSample(samples, "target.branch_picker.open_visible", branchOpenStartedAt);
    const branchCloseStartedAt = performance.now();
    await page.mouse.click(4, 4);
    await page
      .locator('[data-perf="agent-branch-picker-popover"]')
      .first()
      .waitFor({ state: "hidden", timeout: 5_000 });
    pushSample(samples, "target.branch_picker.clickaway_close_visible", branchCloseStartedAt);
  } else {
    samples.push({
      label: "target.branch_picker.open_visible",
      ms: 0,
      at: Date.now(),
      fields: { skipped: true, reason: "branch picker disabled for non-git workspace" },
    });
  }

  const targetButton = page.locator('[data-perf="agent-worktree-target-picker-button"]').first();
  const targetOpenStartedAt = performance.now();
  await targetButton.click();
  await page
    .locator('[data-perf="agent-worktree-target-picker-popover"]')
    .first()
    .waitFor({ state: "visible", timeout: 5_000 });
  pushSample(samples, "target.worktree_picker.open_visible", targetOpenStartedAt);
  const targetCloseStartedAt = performance.now();
  await page.mouse.click(4, 4);
  await page
    .locator('[data-perf="agent-worktree-target-picker-popover"]')
    .first()
    .waitFor({ state: "hidden", timeout: 5_000 });
  pushSample(samples, "target.worktree_picker.clickaway_close_visible", targetCloseStartedAt);

  return samples;
}

async function runHarnessDropdownBenchmarks(page: Page): Promise<BrowserPerfSample[]> {
  const samples: BrowserPerfSample[] = [];
  await page.goto(agentNewChatUrl(), { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);

  const trigger = page.locator('[data-perf="chat-model-dropdown-trigger"]').first();
  if (!(await trigger.isVisible({ timeout: 5_000 }).catch(() => false))) {
    return [
      {
        label: "chat.model_dropdown.harness_open_visible",
        ms: 0,
        at: Date.now(),
        fields: { skipped: true, reason: "model dropdown trigger not visible" },
      },
    ];
  }

  const dropdownStartedAt = performance.now();
  await trigger.click();
  await page.getByLabel("Search models").first().waitFor({ state: "visible", timeout: 5_000 });
  pushSample(samples, "chat.model_dropdown.open_visible", dropdownStartedAt);

  const harnessStartedAt = performance.now();
  await page.locator('[data-perf="chat-model-dropdown-harness-trigger"]').first().click();
  const harnessMenu = page.getByRole("menu", { name: "Harnesses" });
  await harnessMenu.waitFor({ state: "visible", timeout: 5_000 });
  await harnessMenu.getByRole("menuitem", { name: /Codex App Server/i }).waitFor({
    state: "visible",
    timeout: 5_000,
  });
  await harnessMenu.getByRole("menuitem", { name: /OpenCode Server/i }).waitFor({
    state: "visible",
    timeout: 5_000,
  });
  pushSample(samples, "chat.model_dropdown.harness_open_visible", harnessStartedAt);

  const selectStartedAt = performance.now();
  const openCodeServer = harnessMenu.getByRole("menuitem", { name: /OpenCode Server/i }).first();
  if (await openCodeServer.isEnabled().catch(() => false)) {
    await openCodeServer.click();
    await page.waitForTimeout(50);
    pushSample(samples, "chat.model_dropdown.backend_select_visible", selectStartedAt, {
      backendId: "opencode-server",
    });
  } else {
    samples.push({
      label: "chat.model_dropdown.backend_select_visible",
      ms: 0,
      at: Date.now(),
      fields: { skipped: true, reason: "opencode-server unavailable" },
    });
  }
  return samples;
}

async function runBrowserBenchmarkGroup(
  label: string,
  fn: () => Promise<BrowserPerfSample[]>
): Promise<BrowserPerfSample[]> {
  try {
    return await fn();
  } catch (error) {
    return [
      {
        label: `${label}.failed`,
        ms: 0,
        at: Date.now(),
        fields: {
          skipped: true,
          reason: error instanceof Error ? error.message : String(error),
        },
      },
    ];
  }
}

async function main(): Promise<void> {
  await discoverTargetContext();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  if (authToken) {
    await context.setExtraHTTPHeaders({
      "x-opencursor-session-token": authToken,
    });
  }
  const page = await context.newPage();
  await page.addInitScript((token) => {
    window.localStorage.setItem("opencursor:perf", "1");
    if (token) {
      const authState = {
        "http://localhost:9100": { token, session: null, expiresAt: null },
        "http://127.0.0.1:9100": { token, session: null, expiresAt: null },
      };
      window.localStorage.setItem("opencursor.auth.sessions", JSON.stringify(authState));
    }
  }, authToken);

  const consolePerf: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (text.includes("[perf]")) {
      consolePerf.push(text);
    }
  });

  const startedAt = Date.now();
  await page.goto(agentUrl(), { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  const railSamples = await runBrowserBenchmarkGroup("rail", () => runRailBenchmarks(page));
  const targetDropdownSamples = await runBrowserBenchmarkGroup("target", () =>
    runAgentTargetDropdownBenchmarks(page)
  );
  const harnessDropdownSamples = await runBrowserBenchmarkGroup("harness", () =>
    runHarnessDropdownBenchmarks(page)
  );
  const settingsSamples = await runBrowserBenchmarkGroup("settings", () =>
    runSettingsBenchmarks(page)
  );
  const samples = await page.evaluate(
    () =>
      (window as Window & { __opencursorPerfSamples?: BrowserPerfSample[] })
        .__opencursorPerfSamples ?? []
  );
  await browser.close();

  const report = {
    at: new Date(startedAt).toISOString(),
    frontendUrl,
    workspaceId,
    conversationId,
    samples: [
      ...(samples as BrowserPerfSample[]),
      ...railSamples,
      ...settingsSamples,
      ...targetDropdownSamples,
      ...harnessDropdownSamples,
    ],
    settingsSamples,
    railSamples,
    targetDropdownSamples,
    harnessDropdownSamples,
    consolePerf,
  };

  const outDir = path.join(process.cwd(), "tmp", "perf-runs");
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `browser-perf-${Date.now()}.json`);
  await writeFile(outFile, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`browser perf report written to ${outFile}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
