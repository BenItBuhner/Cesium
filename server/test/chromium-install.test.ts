import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { afterEach, test } from "node:test";
import {
  ensurePlaywrightChromium,
  playwrightCliPath,
  setChromiumInstallForTests,
} from "../src/browser-debug/chromium-install.js";

const MISSING = "browserType.launch: Executable doesn't exist at /tmp/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell";

afterEach(() => {
  setChromiumInstallForTests(null);
  delete process.env.CESIUM_CHROMIUM_INSTALL;
});

/** A machine without Chromium until `install` has run `installsNeeded` times. */
function machine(options: { installsNeeded?: number; failWith?: string; slowMs?: number } = {}) {
  const calls = { probes: 0, installs: 0 };
  let installed = false;
  return {
    calls,
    hooks: {
      probe: async () => {
        calls.probes += 1;
        return installed ? null : MISSING;
      },
      install: async () => {
        calls.installs += 1;
        if (options.slowMs) {
          await new Promise((resolve) => setTimeout(resolve, options.slowMs));
        }
        if (options.failWith && calls.installs <= (options.installsNeeded ?? 1)) {
          throw new Error(options.failWith);
        }
        installed = true;
      },
    },
  };
}

test("the installer is the playwright package's own CLI", async () => {
  const cli = playwrightCliPath();
  assert.match(cli, /[\\/]playwright[\\/]cli\.js$/);
  await fs.access(cli);
});

test("an engine with Chromium installs nothing and checks only once", async () => {
  let probes = 0;
  setChromiumInstallForTests({
    probe: async () => {
      probes += 1;
      return null;
    },
    install: async () => assert.fail("nothing to install"),
  });
  assert.deepEqual(await ensurePlaywrightChromium("Build box"), { ok: true, installed: false });
  assert.deepEqual(await ensurePlaywrightChromium("Build box"), { ok: true, installed: false });
  assert.equal(probes, 1, "a launch that worked is remembered");
});

test("a missing Chromium is installed on first use, once for every check waiting on it", async () => {
  const box = machine({ slowMs: 30 });
  setChromiumInstallForTests(box.hooks);
  const results = await Promise.all([
    ensurePlaywrightChromium("Build box"),
    ensurePlaywrightChromium("Build box"),
    ensurePlaywrightChromium("Build box"),
  ]);
  assert.deepEqual(results, Array(3).fill({ ok: true, installed: true }));
  assert.equal(box.calls.installs, 1, "concurrent checks share one install");
  assert.deepEqual(await ensurePlaywrightChromium("Build box"), { ok: true, installed: false });
});

test("a failed install says why and how to install it by hand, and the next check tries again", async () => {
  const box = machine({ failWith: "getaddrinfo ENOTFOUND cdn.playwright.dev" });
  setChromiumInstallForTests(box.hooks);
  const failed = await ensurePlaywrightChromium("Build box");
  assert.equal(failed.ok, false);
  assert.match(
    !failed.ok ? failed.message : "",
    /^The browser check needs Playwright's Chromium, which Build box doesn't have \(installing it failed: getaddrinfo ENOTFOUND cdn\.playwright\.dev\)\. Install it on that machine with `npx playwright install chromium` in Cesium's server folder \(.+\), then start the check again\.$/
  );
  assert.deepEqual(await ensurePlaywrightChromium("Build box"), { ok: true, installed: true }, "the network came back");
  assert.equal(box.calls.installs, 2);
});

test("with automatic installs off it only says how to install it, and skip doesn't check", async () => {
  const box = machine();
  setChromiumInstallForTests(box.hooks);
  process.env.CESIUM_CHROMIUM_INSTALL = "manual";
  const manual = await ensurePlaywrightChromium("Home");
  assert.equal(manual.ok, false);
  assert.match(!manual.ok ? manual.message : "", /which Home doesn't have \(browserType\.launch: Executable doesn't exist at .+; automatic installs are off\)\. Install it on that machine with `npx playwright install chromium`/);
  assert.equal(box.calls.installs, 0, "nothing is downloaded");

  process.env.CESIUM_CHROMIUM_INSTALL = "skip";
  assert.deepEqual(await ensurePlaywrightChromium("Home"), { ok: true, installed: false });
  assert.equal(box.calls.probes, 1, "skip doesn't even look");
});

test("a slow download answers that it is still installing, and a later check finds it done", async () => {
  const box = machine({ slowMs: 200 });
  setChromiumInstallForTests({ ...box.hooks, waitMs: 20 });
  const waiting = await ensurePlaywrightChromium("Build box");
  assert.deepEqual(waiting, {
    ok: false,
    message:
      "Playwright's Chromium is still downloading on Build box (the first browser check there installs it). Start the check again in a few minutes.",
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(await ensurePlaywrightChromium("Build box"), { ok: true, installed: false });
  assert.equal(box.calls.installs, 1, "the check waiting for it doesn't start another download");
});
