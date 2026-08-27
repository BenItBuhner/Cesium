import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CesiumInstallKind, CesiumUpdateApplyEvent } from "@cesium/contracts";
import { DATA_DIR, resolveRepoRootFromProcessCwd } from "../persistence.js";
import { resolveSelfUpdateSupport } from "./update-manager.js";

const STEP_TIMEOUT_MS = 15 * 60_000;

export type ApplyEmitter = (event: CesiumUpdateApplyEvent) => void;

function runStep(options: {
  command: string;
  args: string[];
  cwd: string;
  emit: ApplyEmitter;
  env?: NodeJS.ProcessEnv;
}): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const { command, args, cwd, emit } = options;
    emit({ type: "log", line: `$ ${command} ${args.join(" ")}` });
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
    });
    let stdout = "";
    const timeout = setTimeout(() => {
      emit({ type: "log", line: "Step timed out; terminating." });
      child.kill("SIGTERM");
    }, STEP_TIMEOUT_MS);
    const forward = (chunk: Buffer, isStdout: boolean) => {
      const text = chunk.toString();
      if (isStdout) stdout += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) emit({ type: "log", line });
      }
    };
    child.stdout.on("data", (chunk: Buffer) => forward(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => forward(chunk, false));
    child.on("error", (error) => {
      clearTimeout(timeout);
      emit({ type: "log", line: `Failed to start ${command}: ${error.message}` });
      resolve({ code: -1, stdout });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? -1, stdout });
    });
  });
}

async function runGitCapture(
  args: string[],
  cwd: string
): Promise<string | null> {
  const result = await new Promise<{ code: number; stdout: string }>((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve({ code: -1, stdout }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout }));
  });
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * Self-update for source checkouts: fast-forward the tracked branch, then
 * reinstall dependencies / rebuild shared packages only when the pulled
 * commits actually touched them. The Bun/Node process keeps running on the
 * old code until it is restarted, which is reported via `restartRequired`.
 */
async function applyGitPullUpdate(repoRoot: string, emit: ApplyEmitter): Promise<void> {
  emit({ type: "start", method: "git-pull" });
  const branch =
    process.env.CESIUM_REPO_BRANCH?.trim() ||
    (await runGitCapture(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot)) ||
    "main";
  const oldHead = await runGitCapture(["rev-parse", "HEAD"], repoRoot);

  const fetchResult = await runStep({
    command: "git",
    args: ["fetch", "origin", branch],
    cwd: repoRoot,
    emit,
  });
  if (fetchResult.code !== 0) {
    emit({ type: "done", ok: false, restartRequired: false, error: "git fetch failed" });
    return;
  }

  const mergeResult = await runStep({
    command: "git",
    args: ["merge", "--ff-only", "FETCH_HEAD"],
    cwd: repoRoot,
    emit,
  });
  if (mergeResult.code !== 0) {
    emit({
      type: "done",
      ok: false,
      restartRequired: false,
      error:
        "Fast-forward failed - the checkout has local commits or uncommitted changes. Resolve manually with git.",
    });
    return;
  }

  const newHead = await runGitCapture(["rev-parse", "HEAD"], repoRoot);
  if (!oldHead || !newHead || oldHead === newHead) {
    emit({ type: "log", line: "Already up to date." });
    emit({ type: "done", ok: true, restartRequired: false });
    return;
  }

  const changed =
    (await runGitCapture(["diff", "--name-only", `${oldHead}..${newHead}`], repoRoot)) ?? "";
  const changedFiles = changed.split("\n").filter(Boolean);
  const manifestsChanged = changedFiles.some(
    (file) => path.basename(file) === "package.json" || file.endsWith("package-lock.json")
  );
  const packagesChanged = changedFiles.some((file) => file.startsWith("packages/"));

  if (manifestsChanged) {
    const installResult = await runStep({
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["install"],
      cwd: repoRoot,
      emit,
    });
    if (installResult.code !== 0) {
      emit({
        type: "done",
        ok: false,
        restartRequired: true,
        error: "npm install failed after pulling - run it manually.",
      });
      return;
    }
    // The server's file:.. dependency re-creates a self-referential symlink
    // that breaks Next.js dev (see AGENTS.md); drop it after any install.
    const selfSymlink = path.join(repoRoot, "server", "node_modules", "cesium");
    try {
      const stats = fs.lstatSync(selfSymlink);
      if (stats.isSymbolicLink()) fs.rmSync(selfSymlink);
    } catch {
      // absent - nothing to clean
    }
  }

  if (manifestsChanged || packagesChanged) {
    const buildResult = await runStep({
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["run", "build:packages"],
      cwd: repoRoot,
      emit,
    });
    if (buildResult.code !== 0) {
      emit({
        type: "done",
        ok: false,
        restartRequired: true,
        error: "Shared package build failed after pulling - run npm run build:packages manually.",
      });
      return;
    }
  }

  emit({
    type: "log",
    line: `Updated ${oldHead.slice(0, 10)} → ${newHead.slice(0, 10)} (${changedFiles.length} files).`,
  });
  emit({ type: "done", ok: true, restartRequired: true });
}

function resolveManagerBin(): string | null {
  const override = process.env.CESIUM_MANAGER_BIN?.trim();
  if (override) return override;
  const home = process.env.CESIUM_HOME?.trim();
  if (!home) return null;
  return path.join(home, "bin", "cesium-server");
}

/**
 * Self-update for installer-provisioned servers: hand off to the
 * `cesium-server update` lifecycle command, which stops this very process,
 * re-runs the installer (git pull + dependency install) and restarts the
 * service. The child is detached so it survives our shutdown; progress after
 * the handoff lives in the installer log, and clients should poll `/health`
 * followed by `/api/meta` for the new version.
 */
async function applyManagerCliUpdate(emit: ApplyEmitter): Promise<void> {
  emit({ type: "start", method: "cesium-server-cli" });
  const managerBin = resolveManagerBin();
  if (!managerBin || !fs.existsSync(managerBin)) {
    emit({
      type: "done",
      ok: false,
      restartRequired: false,
      error: `The cesium-server manager CLI was not found${managerBin ? ` at ${managerBin}` : ""}.`,
    });
    return;
  }

  const logDir = path.join(DATA_DIR, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "self-update.log");
  const logFd = fs.openSync(logPath, "a");
  emit({ type: "log", line: `$ ${managerBin} update` });
  emit({ type: "log", line: `Installer output: ${logPath}` });

  try {
    const child = spawn(managerBin, ["update"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.on("error", () => {
      // Reported below only if spawn fails synchronously enough to observe;
      // once detached the installer owns the outcome.
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }

  emit({
    type: "restarting",
    message:
      "Installer handoff started - this server will stop, update, and restart itself. Reconnect in a minute.",
  });
  emit({ type: "done", ok: true, restartRequired: true });
}

export async function applySelfUpdate(options: {
  installKind: CesiumInstallKind;
  emit: ApplyEmitter;
  repoRoot?: string;
}): Promise<void> {
  const support = resolveSelfUpdateSupport(options.installKind);
  if (!support.supported || !support.method) {
    options.emit({
      type: "done",
      ok: false,
      restartRequired: false,
      error: support.reason ?? "Self-update is not supported for this installation.",
    });
    return;
  }
  const repoRoot = options.repoRoot ?? resolveRepoRootFromProcessCwd();
  if (support.method === "git-pull") {
    await applyGitPullUpdate(repoRoot, options.emit);
    return;
  }
  await applyManagerCliUpdate(options.emit);
}
