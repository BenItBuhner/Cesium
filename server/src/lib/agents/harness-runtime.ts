import { accessSync, constants as fsConstants, existsSync, readdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { harnessLog } from "./harness-diagnostics.js";
import {
  binaryArchiveCurrentDir,
  getCesiumToolsDir,
} from "./install/cli-install-registry.js";
import { spawnSafeEnv } from "./spawn-env.js";
import type { CliRuntimeSpec } from "./cli-adapter.js";

/**
 * Central discovery layer for external agent harness CLIs (OpenCode, Codex,
 * Grok Build, Devin, Claude Code, Google's Antigravity ACP server, ...).
 *
 * Every harness is described once by a `HarnessCliDescriptor` and resolved
 * through a single pipeline:
 *
 *   1. explicit env override (`OPENCURSOR_*_BIN`) - absolute path or PATH name
 *   2. `PATH` scan (real executable check, not just `existsSync`)
 *   3. harness-specific well-known install dirs (`~/.grok/bin`, `~/.opencode/bin`, ...)
 *   4. common user-level tool dirs (`~/.local/bin`, `~/.bun/bin`, npm/volta/cargo
 *      global bins, Homebrew, Windows npm/WinGet shims)
 *
 * Detections are cached with a short TTL and fingerprinted against the env
 * vars that influence them, so CLIs installed *after* server boot are picked
 * up automatically - no restart, no module-reload hacks.
 */

export type HarnessCliId =
  | "opencode"
  | "opencode-v2"
  | "codex"
  | "devin"
  | "grok"
  | "google-antigravity-acp"
  | "claude"
  | "cursor";

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
  /**
   * Absolute install dirs computed at detection time (e.g. versioned ACP
   * Registry installs). Searched before `wellKnownHomeSubdirs`.
   */
  wellKnownDirs?: () => string[];
  /** Args used to probe the CLI version. Defaults to `["--version"]`. */
  versionArgs?: string[];
  /** Custom version extractor when the generic `\d+.\d+` probe is ambiguous. */
  parseVersion?: (raw: string) => string | null;
  /** Override for slow-starting binaries (default 5 s). */
  versionProbeTimeoutMs?: number;
};

/**
 * Where Zed keeps ACP Registry installs (`<data>/external_agents/registry/<id>/<version>/`).
 * Treating an existing Zed install as well-known means a user never downloads
 * the same multi-hundred-MB agent archive twice on one machine.
 */
export function zedExternalAgentRegistryDirs(agentId: string): string[] {
  const roots: string[] = [];
  const push = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && !roots.includes(trimmed)) {
      roots.push(trimmed);
    }
  };
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) {
      push(path.join(localAppData, "Zed", "external_agents", "registry", agentId));
    }
  } else if (process.platform === "darwin") {
    for (const home of harnessHomeDirCandidates()) {
      push(
        path.join(home, "Library", "Application Support", "Zed", "external_agents", "registry", agentId)
      );
    }
  } else {
    const xdgData = process.env.XDG_DATA_HOME?.trim();
    if (xdgData) {
      push(path.join(xdgData, "zed", "external_agents", "registry", agentId));
    }
    for (const home of harnessHomeDirCandidates()) {
      push(path.join(home, ".local", "share", "zed", "external_agents", "registry", agentId));
    }
  }
  return roots;
}

/**
 * Expands install roots into their version subdirectories (newest mtime
 * first) followed by the root itself, so `<root>/<version>/<binary>` resolves
 * without knowing the version string.
 */
export function expandVersionedInstallDirs(roots: string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) {
      continue;
    }
    let entries: Array<{ dir: string; mtimeMs: number }> = [];
    try {
      entries = readdirSync(root)
        .map((name) => path.join(root, name))
        .filter((candidate) => {
          try {
            return statSync(candidate).isDirectory();
          } catch {
            return false;
          }
        })
        .map((dir) => {
          let mtimeMs = 0;
          try {
            mtimeMs = statSync(dir).mtimeMs;
          } catch {
            // keep 0
          }
          return { dir, mtimeMs };
        });
    } catch {
      entries = [];
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of entries) {
      if (!out.includes(entry.dir)) {
        out.push(entry.dir);
      }
    }
    if (!out.includes(root)) {
      out.push(root);
    }
  }
  return out;
}

/** Version from Google's `agy_acp_server_<version>` build label / agentInfo. */
function parseAntigravityAcpVersionLabel(raw: string): string | null {
  const semver = /agy_acp_server[_-]v?(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*)/.exec(raw);
  if (semver?.[1]) {
    return semver[1];
  }
  const rc = /agy_acp_server[_-](\d{8}_\d+_RC\d+)/.exec(raw);
  return rc?.[1] ?? null;
}

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
  "google-antigravity-acp": {
    id: "google-antigravity-acp",
    // Google ships `agy_acp_server.par` (macOS/Linux) and `agy_acp_server.exe`
    // (Windows); the bare name lets `.exe` expansion find the Windows build.
    binaryNames: ["agy_acp_server.par", "agy_acp_server"],
    envBinVars: ["OPENCURSOR_ANTIGRAVITY_ACP_BIN"],
    envArgsVars: ["OPENCURSOR_ANTIGRAVITY_ACP_ARGS"],
    // The ACP Registry manifest passes `--uid=` on Linux only.
    defaultArgs: process.platform === "linux" ? ["--uid="] : [],
    wellKnownDirs: () => [
      binaryArchiveCurrentDir("antigravity-acp"),
      ...expandVersionedInstallDirs(zedExternalAgentRegistryDirs("antigravity-acp")),
    ],
    versionArgs: ["--version"],
    parseVersion: parseAntigravityAcpVersionLabel,
    // The 1.9 GB `.par` needs a moment to map before it prints its banner.
    versionProbeTimeoutMs: 15_000,
  },
  claude: {
    id: "claude",
    binaryNames: ["claude"],
    envBinVars: ["OPENCURSOR_CLAUDE_CODE_SDK_PATH", "OPENCURSOR_CLAUDE_BIN"],
    // `claude install` places the launcher under ~/.claude/local.
    wellKnownHomeSubdirs: [[".claude", "local"], [".claude", "bin"]],
  },
  cursor: {
    id: "cursor",
    binaryNames: ["agent", "cursor-agent"],
    envBinVars: ["OPENCURSOR_CURSOR_CLI_BIN", "OPENCURSOR_CURSOR_ACP_BIN"],
    // Extra argv is prepended in providers.ts so `acp` always remains last.
    defaultArgs: ["acp"],
    wellKnownHomeSubdirs: [
      [".local", "bin"],
      [".cursor", "bin"],
      [".cursor-agent", "bin"],
    ],
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
  // Cesium-managed one-click install prefix ({DATA_DIR}/tools) - checked
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
    [
      ...(descriptor.wellKnownDirs?.() ?? []),
      ...wellKnownDirectories(descriptor),
      ...commonBinDirectories(),
    ],
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
        timeout: descriptor.versionProbeTimeoutMs ?? VERSION_PROBE_TIMEOUT_MS,
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
        const combined = `${stdout}\n${stderr}`;
        resolve(
          descriptor.parseVersion
            ? descriptor.parseVersion(combined)
            : parseVersionOutput(combined)
        );
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
