import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Playwright's Chromium (and the headless shell it launches) is a separate
 * download from the playwright package, so a fresh machine can't run the
 * headless browser a browser check needs. `CESIUM_CHROMIUM_INSTALL` decides
 * what happens then: `auto` (default) installs it on first use, `manual` only
 * says how to install it, `skip` doesn't check (engines whose browser helpers
 * never drive a real browser).
 */

const INSTALL_WAIT_MS = 5 * 60_000;
const OUTPUT_KEPT_CHARS = 4_000;

export type ChromiumReadiness = { ok: true; installed: boolean } | { ok: false; message: string };

type InstallHooks = {
  /** Null when a headless Chromium launches, else why it doesn't. */
  probe: () => Promise<string | null>;
  install: () => Promise<void>;
  waitMs: number;
};

const defaultHooks: InstallHooks = { probe: probeChromium, install: installChromium, waitMs: INSTALL_WAIT_MS };
let hooks = defaultHooks;
let launchable = false;
let installing: Promise<void> | null = null;

/** Test hook: replace the probe, the installer or how long a caller waits for it; `null` restores them. */
export function setChromiumInstallForTests(overrides: Partial<InstallHooks> | null): void {
  hooks = { ...defaultHooks, ...overrides };
  launchable = false;
  installing = null;
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "unknown error";
}

async function probeChromium(): Promise<string | null> {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    await browser.close();
    return null;
  } catch (error) {
    return firstLine(error);
  }
}

function runInstaller(runtime: string, cli: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime, [cli, "install", "chromium"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    const keep = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-OUTPUT_KEPT_CHARS);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
      reject(new Error(lines.at(-1) ?? `the installer exited with code ${code}`));
    });
  });
}

/** The playwright package's CLI (its `bin`, which its exports map doesn't expose to require). */
export function playwrightCliPath(): string {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("playwright/package.json");
  const manifest = require(manifestPath) as { bin?: string | Record<string, string> };
  const bin = typeof manifest.bin === "string" ? manifest.bin : (manifest.bin?.playwright ?? "cli.js");
  return path.join(path.dirname(manifestPath), bin);
}

/** Playwright's own installer for Chromium and its headless shell, run with Node when the engine runs on Bun. */
async function installChromium(): Promise<void> {
  const cli = playwrightCliPath();
  const runtimes = process.versions.bun ? ["node", process.execPath] : [process.execPath];
  for (const [index, runtime] of runtimes.entries()) {
    try {
      await runInstaller(runtime, cli);
      return;
    } catch (error) {
      const missingRuntime = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!missingRuntime || index === runtimes.length - 1) {
        throw error;
      }
    }
  }
}

/** Starts the one install callers share; a failed one can be retried by the next caller. */
function startInstall(): Promise<void> {
  const started = hooks.install();
  installing = started;
  const settle = () => {
    if (installing === started) {
      installing = null;
    }
  };
  started.then(settle, settle);
  return started;
}

function howToInstall(engine: string, why: string): string {
  return `The browser check needs Playwright's Chromium, which ${engine} doesn't have (${why}). Install it on that machine with \`npx playwright install chromium\` in Cesium's server folder (${process.cwd()}), then start the check again.`;
}

/**
 * Makes sure a headless Chromium launches on this engine, installing it on
 * first use (one install at a time, shared by concurrent callers). Never
 * throws: a failure comes back with what to do about it.
 */
export async function ensurePlaywrightChromium(engine: string): Promise<ChromiumReadiness> {
  const mode = process.env.CESIUM_CHROMIUM_INSTALL?.trim().toLowerCase() || "auto";
  if (launchable || mode === "skip") {
    return { ok: true, installed: false };
  }
  const missing = await hooks.probe();
  if (!missing) {
    launchable = true;
    return { ok: true, installed: false };
  }
  if (mode === "manual") {
    return { ok: false, message: howToInstall(engine, `${missing}; automatic installs are off`) };
  }
  const install = installing ?? startInstall();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    install.then(
      () => null,
      (error: unknown) => firstLine(error)
    ),
    new Promise<"waiting">((resolve) => {
      timer = setTimeout(() => resolve("waiting"), hooks.waitMs);
    }),
  ]).finally(() => clearTimeout(timer));
  if (outcome === "waiting") {
    return {
      ok: false,
      message: `Playwright's Chromium is still downloading on ${engine} (the first browser check there installs it). Start the check again in a few minutes.`,
    };
  }
  if (outcome) {
    return { ok: false, message: howToInstall(engine, `installing it failed: ${outcome}`) };
  }
  const still = await hooks.probe();
  if (still) {
    return { ok: false, message: howToInstall(engine, `it still doesn't launch after installing: ${still}`) };
  }
  launchable = true;
  return { ok: true, installed: true };
}
