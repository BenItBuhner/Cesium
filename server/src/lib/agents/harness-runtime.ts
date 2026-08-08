import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { harnessLog } from "./harness-diagnostics.js";
import { getCesiumToolsDir } from "./install/cli-install-registry.js";
import { spawnSafeEnv } from "./spawn-env.js";
import type { CliRuntimeSpec } from "./cli-adapter.js";

/**
 * Central discovery layer for external agent harness CLIs (OpenCode, Codex,
 * Grok Build, Devin, Claude Code, Google Antigravity, ...).
 *
 * Every harness is described once by a `HarnessCliDescriptor` and resolved
 * through a single pipeline:
 *
 *   1. explicit env override (`OPENCURSOR_*_BIN`) — absolute path or PATH name
 *   2. `PATH` scan (real executable check, not just `existsSync`)
 *   3. harness-specific well-known install dirs (`~/.grok/bin`, `~/.opencode/bin`, ...)
 *   4. common user-level tool dirs (`~/.local/bin`, `~/.bun/bin`, npm/volta/cargo
 *      global bins, Homebrew, Windows npm/WinGet shims)
 *
 * Detections are cached with a short TTL and fingerprinted against the env
 * vars that influence them, so CLIs installed *after* server boot are picked
 * up automatically — no restart, no module-reload hacks.
 */

export type HarnessCliId =
  | "opencode"
  | "opencode-v2"
  | "codex"
  | "devin"
  | "grok"
  | "google-antigravity"
  | "claude";

export type HarnessRuntimeSource = "env" | "path" | "well-known";

export type HarnessCliDetection = {
  id: HarnessCliId;
  /** Absolute (or as-configured) path to the executable. */
  executablePath: string;
  source: HarnessRuntimeSource;
  /** The env var that supplied the override when `source === "env"`. */
  envVar: string | null;
};

type HarnessCliDescriptor = {
  id: HarnessCliId;
  /** Base binary names without Windows extensions. Ordered by preference. */
  binaryNames: string[];
  /** Env vars that override the binary location. Ordered by preference. */
  envBinVars: string[];
  /** Env vars carrying a JSON string[] that overrides the default args. */
  envArgsVars?: string[];
  /** Default invocation args (e.g. ACP transport flags). */
  defaultArgs?: string[];
  /** Home-relative segments of harness-specific install dirs. */
  wellKnownHomeSubdirs?: string[][];
  /** Args used to probe the CLI version. Defaults to `["--version"]`. */
  versionArgs?: string[];
};

export const HARNESS_CLI_DESCRIPTORS: Record<HarnessCliId, HarnessCliDescriptor> = {
  opencode: {
    id: "opencode",
    binaryNames: ["opencode"],
    envBinVars: ["OPENCURSOR_OPENCODE_SERVER_BIN", "OPENCURSOR_OPENCODE_ACP_BIN"],
    wellKnownHomeSubdirs: [[".opencode", "bin"]],
  },
  "opencode-v2": {
    id: "opencode-v2",
    binaryNames: ["opencode2"],
    envBinVars: ["OPENCURSOR_OPENCODE_V2_SERVER_BIN", "OPENCURSOR_OPENCODE_V2_BIN"],
    wellKnownHomeSubdirs: [[".opencode", "bin"]],
  },
  codex: {
    id: "codex",
    binaryNames: ["codex"],
    envBinVars: ["OPENCURSOR_CODEX_BIN"],
    wellKnownHomeSubdirs: [[".codex", "bin"]],
  },
  devin: {
    id: "devin",
    binaryNames: ["devin"],
    envBinVars: ["OPENCURSOR_DEVIN_CLI_BIN"],
    envArgsVars: ["OPENCURSOR_DEVIN_CLI_ARGS"],
    // Default `devin acp` transport (https://docs.devin.ai/cli/acp/jetbrains).
    defaultArgs: ["acp"],
  },
  grok: {
    id: "grok",
    binaryNames: ["grok"],
    envBinVars: ["OPENCURSOR_GROK_BUILD_BIN", "OPENCURSOR_GROK_BIN"],
    envArgsVars: ["OPENCURSOR_GROK_BUILD_ARGS", "OPENCURSOR_GROK_ARGS"],
    // Official ACP stdio transport; auto-update disabled so a server-managed
    // process never mutates the installed CLI or stalls a chat turn.
    defaultArgs: ["--no-auto-update", "agent", "stdio"],
    wellKnownHomeSubdirs: [[".grok", "bin"]],
  },
  "google-antigravity": {
    id: "google-antigravity",
    binaryNames: ["agy"],
    envBinVars: ["OPENCURSOR_ANTIGRAVITY_CLI_BIN", "OPENCURSOR_AGY_BIN"],
  },
  claude: {
    id: "claude",
    binaryNames: ["claude"],
    envBinVars: ["OPENCURSOR_CLAUDE_CODE_SDK_PATH", "OPENCURSOR_CLAUDE_BIN"],
    // `claude install` places the launcher under ~/.claude/local.
    wellKnownHomeSubdirs: [[".claude", "local"], [".claude", "bin"]],
  },
};

const DEFAULT_DETECTION_TTL_MS = 30_000;
const VERSION_PROBE_TIMEOUT_MS = 5_000;

function detectionTtlMs(): number {
  const raw = Number.parseInt(process.env.OPENCURSOR_HARNESS_DETECT_TTL_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DETECTION_TTL_MS;
}

/**
 * Home directories to search, most-preferred first. `OPENCURSOR_REAL_HOME`
 * exists because packaged/daemonized launches sometimes override `HOME`;
 * platform-conventional fallbacks cover the same situation without config.
 */
export function harnessHomeDirCandidates(): string[] {
  const out: string[] = [];
  const push = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && !out.includes(trimmed)) {
      out.push(trimmed);
    }
  };
  push(process.env.OPENCURSOR_REAL_HOME);
  try {
    push(os.homedir());
  } catch {
    // os.homedir() can throw when HOME is unset in minimal containers.
  }
  const user = process.env.USER?.trim() || process.env.LOGNAME?.trim();
  if (user) {
    if (process.platform === "linux") {
      push(`/home/${user}`);
    } else if (process.platform === "darwin") {
      push(`/Users/${user}`);
    }
  }
  if (process.platform === "win32") {
    push(process.env.USERPROFILE);
  }
  return out;
}

/** True when `candidate` is a real file we can execute (X_OK on POSIX). */
export function isExecutableFile(candidate: string): boolean {
  try {
    const stat = statSync(candidate);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform !== "win32") {
      accessSync(candidate, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/** Expands a base binary name into platform-specific executable file names. */
function executableNameCandidates(baseName: string): string[] {
  if (process.platform !== "win32") {
    return [baseName];
  }
  if (path.extname(baseName)) {
    return [baseName];
  }
  return [`${baseName}.exe`, `${baseName}.cmd`, `${baseName}.bat`, `${baseName}.ps1`, baseName];
}

function pathDirectories(): string[] {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * User-level tool directories that frequently hold harness CLIs but are often
 * missing from a service process `PATH` (login-shell-only exports).
 */
function commonBinDirectories(): string[] {
  const dirs: string[] = [];
  const push = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && !dirs.includes(trimmed)) {
      dirs.push(trimmed);
    }
  };
  // Cesium-managed one-click install prefix ({DATA_DIR}/tools) — checked
  // first so engine-driven installs win over ambient user installs.
  push(path.join(getCesiumToolsDir(), "node_modules", ".bin"));
  push(getCesiumToolsDir()); // npm --prefix on Windows puts shims in the root
  const homes = harnessHomeDirCandidates();
  if (process.platform === "win32") {
    if (process.env.APPDATA?.trim()) {
      push(path.join(process.env.APPDATA, "npm"));
    }
    if (process.env.LOCALAPPDATA?.trim()) {
      push(path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"));
    }
    for (const home of homes) {
      push(path.join(home, ".bun", "bin"));
    }
    return dirs;
  }
  for (const home of homes) {
    push(path.join(home, ".local", "bin"));
    push(path.join(home, "bin"));
    push(path.join(home, ".bun", "bin"));
    push(path.join(home, ".npm-global", "bin"));
    push(path.join(home, ".volta", "bin"));
    push(path.join(home, ".cargo", "bin"));
  }
  push("/usr/local/bin");
  push("/opt/homebrew/bin");
  return dirs;
}

function findExecutableInDirectories(
  directories: string[],
  baseNames: string[]
): string | null {
  for (const directory of directories) {
    for (const baseName of baseNames) {
      for (const name of executableNameCandidates(baseName)) {
        const candidate = path.join(directory, name);
        if (isExecutableFile(candidate)) {
          return candidate;
        }
      }
    }
  }
  return null;
}

function looksLikeFilePath(value: string): boolean {
  return value.includes("/") || value.includes("\\") || /^[a-zA-Z]:/.test(value);
}

function resolveEnvOverride(
  descriptor: HarnessCliDescriptor
): { executablePath: string; envVar: string } | null {
  for (const envVar of descriptor.envBinVars) {
    const configured = process.env[envVar]?.trim();
    if (!configured) {
      continue;
    }
    if (looksLikeFilePath(configured)) {
      if (isExecutableFile(configured)) {
        return { executablePath: configured, envVar };
      }
      harnessLog({
        level: "warning",
        event: "harness.detect.env_override_broken",
        detail: `${envVar}=${configured} does not point at an executable file; falling back to automatic discovery.`,
        data: { harness: descriptor.id, envVar },
      });
      continue;
    }
    const onPath = findExecutableInDirectories(
      [...pathDirectories(), ...commonBinDirectories()],
      [configured]
    );
    if (onPath) {
      return { executablePath: onPath, envVar };
    }
    harnessLog({
      level: "warning",
      event: "harness.detect.env_override_broken",
      detail: `${envVar}=${configured} was not found on PATH or common tool dirs; falling back to automatic discovery.`,
      data: { harness: descriptor.id, envVar },
    });
  }
  return null;
}

function wellKnownDirectories(descriptor: HarnessCliDescriptor): string[] {
  const dirs: string[] = [];
  for (const segments of descriptor.wellKnownHomeSubdirs ?? []) {
    for (const home of harnessHomeDirCandidates()) {
      const candidate = path.join(home, ...segments);
      if (!dirs.includes(candidate)) {
        dirs.push(candidate);
      }
    }
  }
  return dirs;
}

function computeDetection(descriptor: HarnessCliDescriptor): HarnessCliDetection | null {
  const envOverride = resolveEnvOverride(descriptor);
  if (envOverride) {
    return {
      id: descriptor.id,
      executablePath: envOverride.executablePath,
      source: "env",
      envVar: envOverride.envVar,
    };
  }

  const onPath = findExecutableInDirectories(pathDirectories(), descriptor.binaryNames);
  if (onPath) {
    return { id: descriptor.id, executablePath: onPath, source: "path", envVar: null };
  }

  const wellKnown = findExecutableInDirectories(
    [...wellKnownDirectories(descriptor), ...commonBinDirectories()],
    descriptor.binaryNames
  );
  if (wellKnown) {
    return { id: descriptor.id, executablePath: wellKnown, source: "well-known", envVar: null };
  }

  return null;
}

/**
 * Everything that can change a detection outcome without a process restart.
 * When this fingerprint changes the cache entry is discarded immediately, so
 * env edits (tests, runtime settings) never serve stale results.
 */
function detectionFingerprint(descriptor: HarnessCliDescriptor): string {
  const parts: string[] = [
    process.env.PATH ?? "",
    process.env.OPENCURSOR_REAL_HOME ?? "",
  ];
  for (const envVar of descriptor.envBinVars) {
    parts.push(`${envVar}=${process.env[envVar] ?? ""}`);
  }
  return parts.join("\u0000");
}

type DetectionCacheEntry = {
  fingerprint: string;
  expiresAt: number;
  detection: HarnessCliDetection | null;
};

const detectionCache = new Map<HarnessCliId, DetectionCacheEntry>();

/** Drops all cached detections so the next lookup re-scans the filesystem. */
export function refreshHarnessCliDetection(): void {
  detectionCache.clear();
}

/**
 * Detects the harness CLI installation. Results are cached with a short TTL
 * and invalidated automatically when the influencing env vars change.
 */
export function detectHarnessCli(id: HarnessCliId): HarnessCliDetection | null {
  const descriptor = HARNESS_CLI_DESCRIPTORS[id];
  const fingerprint = detectionFingerprint(descriptor);
  const cached = detectionCache.get(id);
  if (cached && cached.fingerprint === fingerprint && cached.expiresAt > Date.now()) {
    return cached.detection;
  }
  const detection = computeDetection(descriptor);
  detectionCache.set(id, {
    fingerprint,
    expiresAt: Date.now() + detectionTtlMs(),
    detection,
  });
  if (!cached || cached.detection?.executablePath !== detection?.executablePath) {
    harnessLog({
      level: "debug",
      event: "harness.detect.result",
      detail: detection
        ? `Detected ${id} at ${detection.executablePath} (${detection.source}).`
        : `No ${id} CLI installation found.`,
      data: { harness: id, source: detection?.source ?? null },
    });
  }
  return detection;
}

function quotePreview(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

function quoteCmdArg(value: string): string {
  if (value.length === 0) {
    return '""';
  }
  return /[\s"]/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/**
 * Wraps an executable + args into a directly spawnable invocation, handling
 * Windows `.cmd`/`.bat`/`.ps1` shims that cannot be spawned without a shell.
 */
export function buildCliInvocation(
  executablePath: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): CliRuntimeSpec {
  const ext = path.extname(executablePath).toLowerCase();
  const commandPreview = [quotePreview(executablePath), ...args.map(quotePreview)].join(" ");
  if (process.platform === "win32" && (ext === ".cmd" || ext === ".bat")) {
    const comspec =
      process.env.ComSpec ??
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    const commandLine = [quoteCmdArg(executablePath), ...args.map(quoteCmdArg)].join(" ");
    return { command: comspec, args: ["/d", "/s", "/c", commandLine], env, commandPreview };
  }
  if (process.platform === "win32" && ext === ".ps1") {
    const powershell =
      process.env.PWSH ??
      path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      );
    return {
      command: powershell,
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", executablePath, ...args],
      env,
      commandPreview,
    };
  }
  return { command: executablePath, args, env, commandPreview };
}

function parseJsonArgsOverride(descriptor: HarnessCliDescriptor): string[] | null {
  for (const envVar of descriptor.envArgsVars ?? []) {
    const rawJson = process.env[envVar]?.trim();
    if (!rawJson) {
      continue;
    }
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return parsed;
      }
    } catch {
      // Ignore invalid JSON and use the supported upstream invocation.
    }
    harnessLog({
      level: "warning",
      event: "harness.detect.env_args_invalid",
      detail: `${envVar} is not a JSON string array; using the default ${descriptor.id} args.`,
      data: { harness: descriptor.id, envVar },
    });
  }
  return null;
}

/** The harness's default args (env-overridable for descriptors that allow it). */
export function harnessDefaultArgs(id: HarnessCliId): string[] {
  const descriptor = HARNESS_CLI_DESCRIPTORS[id];
  return parseJsonArgsOverride(descriptor) ?? [...(descriptor.defaultArgs ?? [])];
}

/**
 * Detection + the harness's default transport args (e.g. `grok --no-auto-update
 * agent stdio`). This is the spec long-lived sessions spawn from.
 */
export function resolveHarnessRuntimeSpec(id: HarnessCliId): CliRuntimeSpec | null {
  const detection = detectHarnessCli(id);
  if (!detection) {
    return null;
  }
  return buildCliInvocation(detection.executablePath, harnessDefaultArgs(id));
}

/**
 * Detection + caller-provided args, ignoring the harness default args. Used
 * for one-shot subcommands like `grok models` or `codex app-server`.
 */
export function buildHarnessInvocation(
  id: HarnessCliId,
  args: string[]
): CliRuntimeSpec | null {
  const detection = detectHarnessCli(id);
  if (!detection) {
    return null;
  }
  return buildCliInvocation(detection.executablePath, args);
}

const versionCache = new Map<string, Promise<string | null>>();

function parseVersionOutput(raw: string): string | null {
  const match = /(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?)/.exec(raw);
  return match?.[1] ?? null;
}

/**
 * Probes `<cli> --version` for the detected installation. Results are cached
 * per executable path, so repeated calls (e.g. every backend list request)
 * cost nothing after the first probe.
 */
export function probeHarnessCliVersion(id: HarnessCliId): Promise<string | null> {
  const detection = detectHarnessCli(id);
  if (!detection) {
    return Promise.resolve(null);
  }
  const descriptor = HARNESS_CLI_DESCRIPTORS[id];
  const cacheKey = detection.executablePath;
  const cached = versionCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const invocation = buildCliInvocation(
    detection.executablePath,
    descriptor.versionArgs ?? ["--version"]
  );
  const probe = new Promise<string | null>((resolve) => {
    execFile(
      invocation.command,
      invocation.args,
      {
        env: spawnSafeEnv(),
        timeout: VERSION_PROBE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 256 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          harnessLog({
            level: "debug",
            event: "harness.detect.version_probe_failed",
            detail: `${id} version probe failed: ${error.message}`,
            data: { harness: id },
          });
          resolve(null);
          return;
        }
        resolve(parseVersionOutput(`${stdout}\n${stderr}`));
      }
    );
  });
  versionCache.set(cacheKey, probe);
  return probe;
}

/** Test hook: also clears cached version probes. */
export function resetHarnessRuntimeCachesForTest(): void {
  detectionCache.clear();
  versionCache.clear();
}
