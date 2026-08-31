/**
 * Per-turn <system-reminder> describing the browser machine environment.
 * This is the browser-specific analog of the engine's
 * `buildCesiumModeReminder()`: it tells the model exactly how shallow (and
 * how capable) this environment is so it can plan around it.
 */
import type { WorkspaceRecord } from "@cesium/core";

export type BrowserReminderInput = {
  workspace: WorkspaceRecord;
  mode: string;
  modelName: string;
  gitSummary: string;
  shellCommands: string[];
  installedPacks: string[];
  dateLabel: string;
};

export function buildBrowserMachineReminder(input: BrowserReminderInput): string {
  const packs =
    input.installedPacks.length > 0
      ? input.installedPacks.join(", ")
      : "none installed (JS/TS toolchain is built in)";
  return [
    "<system-reminder>",
    `Current mode: ${input.mode}. Model: ${input.modelName}. Date: ${input.dateLabel}.`,
    `Workspace root: ${input.workspace.root} (name: ${input.workspace.name}).`,
    `Git: ${input.gitSummary}.`,
    "",
    "## Environment: Cesium Browser Machine",
    "You are running INSIDE the user's web browser tab - there is no operating system, no real processes, and no PTY. Everything below is what you have instead. It is shallower than a normal Linux environment but fully functional for reading, editing, searching, committing, and JavaScript/TypeScript-centric development.",
    "",
    "- Filesystem: a virtual filesystem persisted in the browser (IndexedDB). All workspace paths are POSIX-style under the workspace root. Files survive page reloads but live only on this device/browser profile.",
    `- Shell (terminal tool): a built-in POSIX-ish interpreter, NOT bash. Supported: pipes, &&/||/;, redirects, $VAR, $(...) substitution, globs. Available commands: ${input.shellCommands.join(", ")}. No background processes, no sudo, no apt/brew. Loops/conditionals in shell scripts are unsupported - use multiple commands or ask for a JS script instead.`,
    "- Git: real git (isomorphic-git) against the virtual filesystem. clone/status/add/commit/branch/checkout/log/push/pull work; push/pull go through a CORS relay and need a stored GitHub token for private repos or pushes.",
    "- Network: only browser fetch() semantics. curl works for CORS-enabled endpoints; many sites will refuse cross-origin requests. There is no raw TCP, ssh, or DNS control.",
    `- Language toolchains: ${packs}. Anything not listed cannot be compiled or executed here yet - do not pretend otherwise. If a task needs an unavailable toolchain, say so and suggest switching to a server/Codespace machine, or accomplish it with the tools you do have.`,
    "- Performance/limits: heavy commands and huge repos are slower than native; keep operations bounded (prefer targeted grep/read over full-tree scans). Output over ~400KB per command is truncated.",
    "- Nothing you run can escape the browser sandbox; there is no access to the user's real local disk.",
    "</system-reminder>",
  ].join("\n");
}

export function formatGitSummary(input: {
  isGitRepo: boolean;
  branch?: string | null;
  dirty?: boolean;
}): string {
  if (!input.isGitRepo) return "not a git repository";
  const branch = input.branch ?? "(detached)";
  return `on branch ${branch}${input.dirty ? ", uncommitted changes present" : ", clean"}`;
}
