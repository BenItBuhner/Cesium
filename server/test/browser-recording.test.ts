import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.OPENCURSOR_DATA_DIR = await mkdtemp(
  path.join(os.tmpdir(), "cesium-browser-recording-data-")
);

const { callBuiltInBrowserTool, callBuiltInBrowserToolRich } = await import(
  "../src/lib/mcp/builtin-browser-tools.js"
);
const { listBrowserControlTabs, closeBrowserControlTab, resetBrowserControlForTests } =
  await import("../src/lib/browser-control/service.js");
const {
  parseImageDataUrl,
  sanitizeBrowserArtifactBaseName,
  saveBrowserScreenshotArtifact,
} = await import("../src/lib/browser-control/artifacts.js");
const { resolveFfmpegPath } = await import("../src/lib/browser-control/recording.js");

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("browser artifact helpers sanitize names and parse data URLs", async () => {
  assert.equal(sanitizeBrowserArtifactBaseName("My Demo!.mp4", "fallback"), "my-demo");
  assert.equal(sanitizeBrowserArtifactBaseName("   ", "fallback"), "fallback");
  const parsed = parseImageDataUrl(`data:image/png;base64,${TINY_PNG_BASE64}`);
  assert.ok(parsed);
  assert.equal(parsed?.mimeType, "image/png");
  assert.ok((parsed?.data.length ?? 0) > 0);
  assert.equal(parseImageDataUrl("not-a-data-url"), null);
});

test("saveBrowserScreenshotArtifact writes files under artifacts/browser", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "cesium-artifact-ws-"));
  try {
    await writeFile(path.join(workspaceRoot, ".gitignore"), "node_modules/\n", "utf8");
    const record = await saveBrowserScreenshotArtifact({
      workspaceRoot,
      imageDataUrl: `data:image/png;base64,${TINY_PNG_BASE64}`,
      fileName: "Login Page",
    });
    assert.ok(record);
    assert.equal(record?.relativePath, "artifacts/browser/login-page.png");
    const written = await stat(record!.absolutePath);
    assert.ok(written.size > 0);
    const gitignore = await readFile(path.join(workspaceRoot, ".gitignore"), "utf8");
    assert.match(gitignore, /artifacts\/browser\//);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test(
  "server-chromium tab records a demo video and saves screenshot artifacts end-to-end",
  { timeout: 180_000 },
  async (t) => {
    const ffmpeg = await resolveFfmpegPath();
    if (!ffmpeg) {
      t.skip("ffmpeg is not available");
      return;
    }
    resetBrowserControlForTests();
    const workspaceId = "ws-recording";
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "cesium-recording-ws-"));
    const pageUrl =
      "data:text/html,<html><body style='background:%23222;color:%23eee'><h1 id='title'>Demo page</h1><button id='go'>Go</button></body></html>";
    let tabId: string | null = null;
    try {
      const opened = await callBuiltInBrowserTool({
        workspaceId,
        workspaceRoot,
        toolName: "browser_tabs",
        arguments: { action: "open", url: pageUrl, engine: "server-chromium" },
      });
      const tab = listBrowserControlTabs(workspaceId)[0];
      assert.ok(tab, `expected a tab from: ${opened.slice(0, 400)}`);
      if (tab.engine !== "server-chromium") {
        t.skip("Chromium is not available in this environment");
        return;
      }
      tabId = tab.tabId;

      const screenshot = await callBuiltInBrowserToolRich({
        workspaceId,
        workspaceRoot,
        toolName: "browser_screenshot",
        arguments: { tabId, fileName: "demo-page" },
      });
      assert.match(screenshot.text, /artifacts\/browser\/demo-page\.png/);
      assert.equal(screenshot.images?.[0]?.mimeType, "image/png");
      const screenshotStat = await stat(
        path.join(workspaceRoot, "artifacts", "browser", "demo-page.png")
      );
      assert.ok(screenshotStat.size > 500);

      const started = await callBuiltInBrowserTool({
        workspaceId,
        workspaceRoot,
        toolName: "browser_record",
        arguments: { tabId, action: "start" },
      });
      assert.match(started, /browser_record_started/);

      for (let step = 0; step < 4; step += 1) {
        await callBuiltInBrowserTool({
          workspaceId,
          workspaceRoot,
          toolName: "browser_evaluate",
          arguments: {
            tabId,
            script: `document.getElementById('title').textContent = 'Demo step ${step}'; document.body.style.background = 'hsl(${step * 60}, 60%, 25%)'; true;`,
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      const status = await callBuiltInBrowserTool({
        workspaceId,
        workspaceRoot,
        toolName: "browser_record",
        arguments: { tabId, action: "status" },
      });
      assert.match(status, /"recording": true/);

      const stopped = await callBuiltInBrowserTool({
        workspaceId,
        workspaceRoot,
        toolName: "browser_record",
        arguments: { tabId, action: "stop", fileName: "demo-video" },
      });
      assert.match(stopped, /browser_record_saved/);
      const parsed = JSON.parse(stopped) as {
        artifact: { filePath: string; bytes: number; mimeType: string };
        frameCount: number;
      };
      assert.ok(parsed.frameCount >= 1, `expected frames, got ${parsed.frameCount}`);
      assert.match(parsed.artifact.filePath, /^artifacts\/browser\/demo-video\.(mp4|webm)$/);
      const videoStat = await stat(path.join(workspaceRoot, parsed.artifact.filePath));
      assert.ok(videoStat.size > 1000, `video too small: ${videoStat.size} bytes`);
    } finally {
      if (tabId) {
        await closeBrowserControlTab(workspaceId, tabId).catch(() => undefined);
      }
      resetBrowserControlForTests();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }
);
