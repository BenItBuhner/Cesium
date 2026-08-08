import type { AgentBackendId } from "../types.js";

/**
 * One-click installers for harness CLIs that back Cesium agent backends.
 *
 * Every spec is a plain argv invocation (no shell string interpolation) so
 * nothing user-controlled ever reaches a shell. Specs declare the platforms
 * they support; the setup flow only offers installers valid for the engine's
 * host OS (e.g. curl|bash installers are hidden on Windows).
 */

export type CliInstallSpec = {
  backendId: AgentBackendId;
  label: string;
  /** Binary expected on PATH after a successful install. */
  binName: string;
  command: string;
  args: string[];
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
    command: "npm",
    args: ["install", "-g", "@openai/codex"],
    platforms: NPM_PLATFORMS,
    summary: "npm install -g @openai/codex",
    authHint: "Run `codex login` on the engine host, or set OPENAI_API_KEY.",
  },
  {
    backendId: "claude-code-sdk",
    label: "Claude Code CLI",
    binName: "claude",
    command: "npm",
    args: ["install", "-g", "@anthropic-ai/claude-code"],
    platforms: NPM_PLATFORMS,
    summary: "npm install -g @anthropic-ai/claude-code",
    authHint:
      "Set ANTHROPIC_API_KEY on the engine, or save a key under Settings → Agents.",
  },
  {
    backendId: "opencode-server",
    label: "OpenCode CLI",
    binName: "opencode",
    command: "npm",
    args: ["install", "-g", "opencode-ai"],
    platforms: NPM_PLATFORMS,
    summary: "npm install -g opencode-ai",
    authHint: "Run `opencode auth login` on the engine host.",
  },
];

export function getInstallSpecForBackend(
  backendId: string
): CliInstallSpec | null {
  return CLI_INSTALL_SPECS.find((spec) => spec.backendId === backendId) ?? null;
}

export function isInstallSupportedOnThisHost(spec: CliInstallSpec): boolean {
  return spec.platforms.includes(process.platform as "linux" | "darwin" | "win32");
}
