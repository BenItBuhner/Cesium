import { existsSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../persistence.js";
import type { AgentBackendId } from "../types.js";

/**
 * One-click installers for harness CLIs that back Cesium agent backends.
 *
 * Installs are deterministic and self-contained: packages land in a
 * Cesium-managed tools directory under the data dir (`npm install --prefix`),
 * never the user's global prefix - a bun/systemd/desktop server process has
 * no reliable global npm prefix, and Cesium should not mutate one anyway.
 * Runtime resolvers check this tools directory in addition to `PATH`.
 *
 * Every spec is a plain argv invocation (no shell string interpolation) so
 * nothing user-controlled ever reaches a shell. Specs declare the platforms
 * they support; the setup flow only offers installers valid for the engine's
 * host OS.
 */

export type CliInstallSpec = {
  backendId: AgentBackendId;
  label: string;
  /** Binary expected under the tools dir (or PATH) after installation. */
  binName: string;
  /** npm package installed into the Cesium tools prefix. */
  packageName: string;
  /** Platforms (process.platform values) this installer supports. */
  platforms: Array<"linux" | "darwin" | "win32">;
  /** Human summary shown next to the one-click button. */
  summary: string;
  /** How the CLI authenticates after installation. */
  authHint: string;
};

const NPM_PLATFORMS: CliInstallSpec["platforms"] = ["linux", "darwin", "win32"];

export const CLI_INSTALL_SPECS: CliInstallSpec[] = [
  {
    backendId: "codex-app-server",
    label: "Codex CLI",
    binName: "codex",
    packageName: "@openai/codex",
    platforms: NPM_PLATFORMS,
    summary: "npm install @openai/codex (Cesium tools dir)",
    authHint: "Run `codex login` on the engine host, or set OPENAI_API_KEY.",
  },
  {
    backendId: "opencode-server",
    label: "OpenCode CLI",
    binName: "opencode",
    packageName: "opencode-ai",
    platforms: NPM_PLATFORMS,
    summary: "npm install opencode-ai (Cesium tools dir)",
    authHint: "Run `opencode auth login` on the engine host.",
  },
];

/** Cesium-managed CLI install prefix: `{OPENCURSOR_DATA_DIR}/tools`. */
export function getCesiumToolsDir(): string {
  return path.join(DATA_DIR, "tools");
}

/** argv for `spec`'s installer (never a shell string). */
export function buildInstallCommand(spec: CliInstallSpec): {
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

export function getInstallSpecForBackend(
  backendId: string
): CliInstallSpec | null {
  return CLI_INSTALL_SPECS.find((spec) => spec.backendId === backendId) ?? null;
}

export function isInstallSupportedOnThisHost(spec: CliInstallSpec): boolean {
  return spec.platforms.includes(process.platform as "linux" | "darwin" | "win32");
}
