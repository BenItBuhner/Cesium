/**
 * Per-turn <system-reminder> describing the browser machine environment.
 * This is the browser-specific analog of the engine's
 * `buildCesiumTurnReminder()`: it tells the model exactly how shallow (and
 * how capable) this environment is so it can plan around it.
 */
import type { WorkspaceRecord } from "@cesium/core";

export type BrowserReminderInput = {
  workspace: WorkspaceRecord;
  modelName: string;
  gitSummary: string;
  shellCommands: string[];
  installedPacks: string[];
  dateLabel: string;
};

/** Per-turn facts: sent with every turn's reminder. */
export function buildBrowserMachineFacts(input: BrowserReminderInput): string {
  return [
    `Model: ${input.modelName}. Date: ${input.dateLabel}.`,
    `Workspace root: ${input.workspace.root} (name: ${input.workspace.name}).`,
    `Git: ${input.gitSummary}.`,
  ].join("\n");
}

/** What this environment can do; sent once, then again only when it changes. */
export function buildBrowserMachineEnvironment(input: BrowserReminderInput): string {
  const packs =
    input.installedPacks.length > 0
      ? input.installedPacks.join(", ")
      : "none installed (JS/TS toolchain is built in)";
  return [
    "## Environment: Cesium Browser Machine",
    "You are running INSIDE the user's web browser tab - there is no operating system, no real processes, and no PTY. Everything below is what you have instead. It is shallower than a normal Linux environment but fully functional for reading, editing, searching, committing, and JavaScript/TypeScript-centric development.",
    "",
    "- Filesystem: a virtual filesystem persisted in the browser (IndexedDB). All workspace paths are POSIX-style under the workspace root. Files survive page reloads but live only on this device/browser profile.",
    `- Shell (terminal tool): a built-in POSIX-ish interpreter, NOT bash. Supported: pipes, &&/||/;, redirects, $VAR, $(...) substitution, globs. Available commands: ${input.shellCommands.join(", ")}. No background processes, no sudo, no apt/brew. Loops/conditionals in shell scripts are unsupported - use multiple commands or ask for a JS script instead.`,
    "- Git: real git (isomorphic-git) against the virtual filesystem. clone/status/add/commit/branch/checkout/log/push/pull work; push/pull go through a CORS relay and need a stored GitHub token for private repos or pushes.",
    "- Network: only browser fetch() semantics. curl works for CORS-enabled endpoints; many sites will refuse cross-origin requests. There is no raw TCP, ssh, or DNS control.",
    `- Language toolchains: ${packs}. Install more with \`packs list\` / \`packs install <id>\` (python and ruby load fully in-browser). Anything not listed cannot be compiled or executed here yet - do not pretend otherwise. If a task needs an unavailable toolchain, say so and suggest switching to a server/Codespace machine, or accomplish it with the tools you do have.`,
    "- JavaScript/TypeScript workflow: `npm install` (real registry installs into node_modules), `node script.ts` (bundled with esbuild, node fs/path shimmed to the virtual FS), `npm run <script>`, `esbuild entry.tsx --outfile=dist/app.js` for builds.",
    "- Web preview: `serve <dir>` publishes a static directory to a same-origin /preview/... URL served by a service worker; tell the user to open that URL to view it. Re-run serve after rebuilding.",
    "- Full Linux VM (experimental escape hatch): `vm start --image <url>` boots a v86 x86 Linux image with a serial console (`vm exec`, `vm tail`). Very slow; only for toolchains with no browser build.",
    "- Performance/limits: heavy commands and huge repos are slower than native; keep operations bounded (prefer targeted grep/read over full-tree scans). Output over ~400KB per command is truncated.",
    "- Nothing you run can escape the browser sandbox; there is no access to the user's real local disk.",
  ].join("\n");
}

/** Stable 32-bit FNV-1a digest; the page has no synchronous crypto hash. */
export function browserMachineEnvironmentHash(environment: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < environment.length; index += 1) {
    hash ^= environment.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The turn's reminder: facts always, the environment block only when
 * `previousEnvironmentHash` is missing or differs from the current one.
 */
export function buildBrowserMachineReminder(
  input: BrowserReminderInput,
  previousEnvironmentHash: string | null = null
): { text: string; environmentHash: string; includesEnvironment: boolean } {
  const environment = buildBrowserMachineEnvironment(input);
  const environmentHash = browserMachineEnvironmentHash(environment);
  const includesEnvironment = previousEnvironmentHash !== environmentHash;
  return {
    text: [
      "<system-reminder>",
      buildBrowserMachineFacts(input),
      ...(includesEnvironment ? ["", environment] : []),
      "</system-reminder>",
    ].join("\n"),
    environmentHash,
    includesEnvironment,
  };
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
