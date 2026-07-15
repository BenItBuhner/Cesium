import assert from "node:assert/strict";
import { describe, test } from "node:test";

const BASE_URL = process.env.BROWSER_E2E_BASE_URL;
const SERVER_URL = process.env.BROWSER_E2E_SERVER_URL;

const maybeTest = BASE_URL && SERVER_URL ? test : test.skip;

async function setNewBrowserEnabled(enabled: boolean): Promise<void> {
  const response = await fetch(`${SERVER_URL}/api/settings/global`);
  assert.equal(response.ok, true);
  const payload = (await response.json()) as {
    settings: { agents: Record<string, unknown> } & Record<string, unknown>;
  };
  const settings = {
    ...payload.settings,
    agents: {
      ...payload.settings.agents,
      newBrowser: enabled,
    },
  };
  const save = await fetch(`${SERVER_URL}/api/settings/global`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings }),
  });
  assert.equal(save.ok, true);
  // The production settings route intentionally coalesces writes; wait for the
  // debounce so a following page load observes the new Beta flag.
  await new Promise((resolve) => setTimeout(resolve, 800));
}

async function bootstrapPage(page: import("playwright").Page): Promise<void> {
  const baseUrl = SERVER_URL!;
  await page.addInitScript((serverBaseUrl) => {
    const now = Date.now();
    localStorage.setItem(
      "opencursor.server-connections",
      JSON.stringify({
        version: 1,
        activeServerId: "browser-e2e",
        defaultServerId: "browser-e2e",
        servers: [
          {
            id: "browser-e2e",
            label: "browser-e2e",
            baseUrl: serverBaseUrl,
            createdAt: now,
            updatedAt: now,
            lastUsedAt: now,
          },
        ],
      })
    );
  }, baseUrl);
}

async function openBrowserUrl(
  page: import("playwright").Page,
  url: string
): Promise<void> {
  await page.keyboard.press("F1");
  await page.getByRole("textbox", { name: "Command search" }).fill("Browser: Open URL", {
    timeout: 10_000,
  });
  await page.keyboard.press("Enter");
  await page.getByRole("textbox", { name: "URL" }).fill(url, { timeout: 10_000 });
  await page.keyboard.press("Enter");
}

describe("browser engine e2e", () => {
  maybeTest("loads the legacy browser by default and the new engine when Beta is enabled", async () => {
    const { chromium } = await import("playwright");
    await setNewBrowserEnabled(false);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const debugSessionPosts: number[] = [];
    page.on("response", (response) => {
      if (
        response.url().includes("/api/browser-debug/sessions") &&
        response.request().method() === "POST"
      ) {
        debugSessionPosts.push(response.status());
      }
    });
    try {
      await bootstrapPage(page);
      await page.goto(`${BASE_URL}/agent?serverUrl=${encodeURIComponent(SERVER_URL!)}`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

      const defaultProxyResponse = page.waitForResponse((response) =>
        response.url().includes("/browser/https/example.com") &&
        response.status() === 200
      );
      await openBrowserUrl(page, "https://example.com/");
      await defaultProxyResponse;
      await page.waitForTimeout(1_000);
      assert.deepEqual(debugSessionPosts, []);

      await setNewBrowserEnabled(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
      const debugSessionResponse = page.waitForResponse((response) =>
        response.url().includes("/api/browser-debug/sessions") &&
        response.request().method() === "POST" &&
        response.status() === 201
      );
      const viewportResponse = page.waitForResponse((response) =>
        response.url().includes("/viewport?") &&
        response.status() === 200
      );
      await openBrowserUrl(page, "https://example.com/");
      await debugSessionResponse;
      await viewportResponse;
    } finally {
      await browser.close();
    }
  });

  maybeTest("responds to hover, scroll, and input without high-frequency viewport polling", async () => {
    const { chromium } = await import("playwright");
    await setNewBrowserEnabled(true);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const viewportRequests: number[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/viewport?")) {
        viewportRequests.push(Date.now());
      }
    });
    try {
      await bootstrapPage(page);
      await page.goto(`${BASE_URL}/agent?serverUrl=${encodeURIComponent(SERVER_URL!)}`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

      const viewportResponse = page.waitForResponse((response) =>
        response.url().includes("/viewport?") &&
        response.status() === 200
      );
      await openBrowserUrl(page, "https://example.com/");
      await viewportResponse;

      const browserSurface = page.locator("[data-ide-browser-surface]");
      const box = await browserSurface.boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 240);
      await page.keyboard.press("Tab");
      await page.waitForTimeout(1_500);

      const rapidIntervals = viewportRequests
        .slice(1)
        .map((ts, index) => ts - viewportRequests[index])
        .filter((delta) => delta < 50);
      assert.equal(rapidIntervals.length, 0);
    } finally {
      await browser.close();
    }
  });
});

