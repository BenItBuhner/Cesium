import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../persistence.js";
import type { AgentBackendId } from "../types.js";

/**
 * One-click installers for harness CLIs that back Cesium agent backends.
 *
 * Installs are deterministic and self-contained: packages land in a
 * Cesium-managed tools directory under the data dir (`npm install --prefix`
 * for npm packages, `{tools}/<name>/<version>/` for vendor binary archives),
 * never the user's global prefix - a bun/systemd/desktop server process has
 * no reliable global npm prefix, and Cesium should not mutate one anyway.
 * Runtime resolvers check this tools directory in addition to `PATH`.
 *
 * Every npm spec is a plain argv invocation (no shell string interpolation)
 * so nothing user-controlled ever reaches a shell. Binary-archive specs are
 * downloaded from a pinned vendor manifest and extracted in-process (see
 * `binary-archive-installer.ts`). Specs declare the platforms they support;
 * the setup flow only offers installers valid for the engine's host OS.
 */

type CliInstallSpecBase = {
  backendId: AgentBackendId;
  label: string;
  /** Binary expected under the tools dir (or PATH) after installation. */
  binName: string;
  /** Platforms (process.platform values) this installer supports. */
  platforms: Array<"linux" | "darwin" | "win32">;
  /** Human summary shown next to the one-click button. */
  summary: string;
  /** How the CLI authenticates after installation. */
  authHint: string;
};

export type NpmCliInstallSpec = CliInstallSpecBase & {
  kind: "npm";
  /** npm package installed into the Cesium tools prefix. */
  packageName: string;
};

/** One platform target inside an ACP Registry `distribution.binary` map. */
export type AcpRegistryBinaryTarget = {
  archive: string;
  cmd: string;
  args?: string[];
};

/** Subset of the ACP Registry `agent.json` schema Cesium consumes. */
export type AcpRegistryAgentManifest = {
  id: string;
  name: string;
  version: string;
  description?: string;
  website?: string;
  authors?: string[];
  license?: string;
  distribution: {
    binary?: Record<string, AcpRegistryBinaryTarget>;
    npx?: { package: string };
  };
};

export type BinaryArchiveInstallSpec = CliInstallSpecBase & {
  kind: "binary-archive";
  /** Directory under the tools dir: `{tools}/<installDirName>/<version>/`. */
  installDirName: string;
  /** Live manifest (ACP Registry `agent.json`); falls back to `fallbackManifest`. */
  manifestUrl: string;
  /** Pinned manifest used when the registry is unreachable or malformed. */
  fallbackManifest: AcpRegistryAgentManifest;
  /** Hosts the archive must come from; anything else is refused. */
  allowedArchiveHosts: string[];
  /** Approximate footprint for the confirmation UI and disk precheck. */
  approxDownloadBytes: number;
  approxInstalledBytes: number;
};

export type CliInstallSpec = NpmCliInstallSpec | BinaryArchiveInstallSpec;

const NPM_PLATFORMS: CliInstallSpec["platforms"] = ["linux", "darwin", "win32"];

/**
 * Google's official Antigravity ACP server, as published to the ACP Registry
 * (`agentclientprotocol/registry/antigravity-acp/agent.json`). Pinned to the
 * 1.1.1 release so installs still work when GitHub is unreachable.
 */
export const ANTIGRAVITY_ACP_FALLBACK_MANIFEST: AcpRegistryAgentManifest = {
  id: "antigravity-acp",
  name: "Google Antigravity",
  version: "1.1.1",
  description: "Google’s AI coding agent",
  website: "https://antigravity.google/docs/ide/extensions",
  authors: ["Google LLC"],
  license: "proprietary",
  distribution: {
    binary: {
      "darwin-aarch64": {
        archive:
          "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip",
        cmd: "./agy_acp_server.par",
      },
      "linux-x86_64": {
        archive:
          "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-x86_64.zip",
        cmd: "./agy_acp_server.par",
        args: ["--uid="],
      },
      "linux-aarch64": {
        archive:
          "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-arm64.zip",
        cmd: "./agy_acp_server.par",
        args: ["--uid="],
      },
      "windows-x86_64": {
        archive:
          "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-x86_64.zip",
        cmd: "./agy_acp_server.exe",
      },
      "windows-aarch64": {
        archive:
          "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-arm64.zip",
        cmd: "./agy_acp_server.exe",
      },
    },
  },
};

export const ANTIGRAVITY_ACP_REGISTRY_MANIFEST_URL =
  "https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json";

export const CLI_INSTALL_SPECS: CliInstallSpec[] = [
  {
    kind: "npm",
    backendId: "codex-app-server",
    label: "Codex CLI",
    binName: "codex",
    packageName: "@openai/codex",
    platforms: NPM_PLATFORMS,
    summary: "npm install @openai/codex (Cesium tools dir)",
    authHint: "Run `codex login` on the engine host, or set OPENAI_API_KEY.",
  },
  {
    kind: "npm",
    backendId: "opencode-server",
    label: "OpenCode CLI",
    binName: "opencode",
    packageName: "opencode-ai",
    platforms: NPM_PLATFORMS,
    summary: "npm install opencode-ai (Cesium tools dir)",
    authHint: "Run `opencode auth login` on the engine host.",
  },
  {
    kind: "binary-archive",
    backendId: "google-antigravity-acp",
    label: "Google Antigravity ACP server",
    binName: "agy_acp_server",
    installDirName: "antigravity-acp",
    manifestUrl: ANTIGRAVITY_ACP_REGISTRY_MANIFEST_URL,
    fallbackManifest: ANTIGRAVITY_ACP_FALLBACK_MANIFEST,
    allowedArchiveHosts: ["dl.google.com"],
    // 1.1.1 linux-x86_64: 682 MB zip, 1.9 GB extracted.
    approxDownloadBytes: 700 * 1024 * 1024,
    approxInstalledBytes: 2 * 1024 * 1024 * 1024,
    platforms: ["linux", "darwin", "win32"],
    summary:
      "Download Google's official agy_acp_server from the ACP Registry (~700 MB download, ~2 GB on disk)",
    authHint:
      "Open Settings -> Agents -> Google Antigravity and click Log in with Google (or pick an API key method).",
  },
];

/** Cesium-managed CLI install prefix: `{OPENCURSOR_DATA_DIR}/tools`. */
export function getCesiumToolsDir(): string {
  return path.join(DATA_DIR, "tools");
}

/** argv for an npm `spec`'s installer (never a shell string). */
export function buildInstallCommand(spec: NpmCliInstallSpec): {
  command: string;
  args: string[];
} {
  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: [
      "install",
      "--prefix",
      getCesiumToolsDir(),
      "--no-audit",
      "--no-fund",
      spec.packageName,
    ],
  };
}

/**
 * Resolve a CLI binary installed into the Cesium tools dir, if present.
 * npm `--prefix` layouts differ per platform: POSIX gets `node_modules/.bin`,
 * Windows puts shims next to `node_modules` in the prefix root.
 */
export function resolveCesiumToolBin(binName: string): string | null {
  const toolsDir = getCesiumToolsDir();
  const candidates =
    process.platform === "win32"
      ? [
          path.join(toolsDir, `${binName}.cmd`),
          path.join(toolsDir, `${binName}.exe`),
          path.join(toolsDir, binName),
          path.join(toolsDir, "node_modules", ".bin", `${binName}.cmd`),
        ]
      : [path.join(toolsDir, "node_modules", ".bin", binName)];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Unreadable path - keep looking.
    }
  }
  return null;
}

/** Root for one binary-archive install: `{tools}/<installDirName>/`. */
export function binaryArchiveInstallRoot(installDirName: string): string {
  return path.join(getCesiumToolsDir(), installDirName);
}

/** `{tools}/<installDirName>/<version>/` for a specific version. */
export function binaryArchiveVersionDir(installDirName: string, version: string): string {
  return path.join(binaryArchiveInstallRoot(installDirName), version);
}

/** Pointer file written when a `current` symlink/junction cannot be created. */
export function binaryArchiveCurrentPointerPath(installDirName: string): string {
  return path.join(binaryArchiveInstallRoot(installDirName), "current.json");
}

/**
 * Directory holding the active install: the `current` link when present,
 * else the version recorded in `current.json`, else the bare `current` path
 * (which simply will not exist). Never throws - used from detection paths.
 */
export function binaryArchiveCurrentDir(installDirName: string): string {
  const root = binaryArchiveInstallRoot(installDirName);
  const link = path.join(root, "current");
  try {
    if (statSync(link).isDirectory()) {
      return link;
    }
  } catch {
    // no link - try the pointer file
  }
  try {
    const raw = readFileSync(binaryArchiveCurrentPointerPath(installDirName), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim()) {
      return path.join(root, parsed.version.trim());
    }
  } catch {
    // no pointer file either
  }
  return link;
}

/** Maps Node's platform/arch onto ACP Registry `distribution.binary` keys. */
export function acpRegistryPlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | null {
  const archKey = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  if (!archKey) {
    return null;
  }
  if (platform === "linux") {
    return `linux-${archKey}`;
  }
  if (platform === "darwin") {
    return `darwin-${archKey}`;
  }
  if (platform === "win32") {
    return `windows-${archKey}`;
  }
  return null;
}

export function getInstallSpecForBackend(
  backendId: string
): CliInstallSpec | null {
  return CLI_INSTALL_SPECS.find((spec) => spec.backendId === backendId) ?? null;
}

export function isInstallSupportedOnThisHost(
  spec: CliInstallSpec,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): boolean {
  if (!spec.platforms.includes(platform as "linux" | "darwin" | "win32")) {
    return false;
  }
  if (spec.kind === "binary-archive") {
    const key = acpRegistryPlatformKey(platform, arch);
    return key !== null && Boolean(spec.fallbackManifest.distribution.binary?.[key]);
  }
  return true;
}
