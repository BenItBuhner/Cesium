import type { ChildProcess } from "node:child_process";

const shutdownHooks = new Set<() => void>();
let shutdownHooksRegistered = false;

function runShutdownHooks(): void {
  for (const hook of [...shutdownHooks]) {
    try {
      hook();
    } catch {
      // Shutdown must never throw.
    }
  }
}

/**
 * Managed OpenCode servers now linger after their last session detaches, so
 * they must be stopped when Cesium itself goes away: `opencode serve` (1.x)
 * does not watch its parent and would otherwise run orphaned. Signals are
 * re-raised after the hooks so the default termination behavior is unchanged.
 */
export function registerManagedServerShutdownHook(hook: () => void): void {
  shutdownHooks.add(hook);
  if (shutdownHooksRegistered) return;
  shutdownHooksRegistered = true;
  process.once("exit", runShutdownHooks);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      runShutdownHooks();
      if (process.listenerCount(signal) === 0) {
        process.kill(process.pid, signal);
      }
    });
  }
}

/** Keeps the most recent process output lines for startup diagnostics. */
export class RecentOutput {
  private readonly lines: string[] = [];

  constructor(private readonly limit = 40) {}

  push(chunk: unknown): string[] {
    const added: string[] = [];
    // CLIs color fatal errors; keep the captured lines readable in messages.
    // eslint-disable-next-line no-control-regex
    const plain = String(chunk).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
    for (const line of plain.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      added.push(trimmed);
      this.lines.push(trimmed);
      if (this.lines.length > this.limit) {
        this.lines.shift();
      }
    }
    return added;
  }

  snapshot(): string[] {
    return [...this.lines];
  }
}

/**
 * Translate known OpenCode startup failures into something the user can act on.
 *
 * Both generations share `~/.local/share/opencode/opencode.db` (and its
 * migration guard): a database first created by the v2 beta has no `session`
 * table, so the current release refuses to start with an opaque error.
 */
export function describeOpenCodeStartupFailure(output: string[]): string | undefined {
  const text = output.join("\n");
  if (/Database is not empty and has no session table/i.test(text)) {
    return [
      "OpenCode's database (~/.local/share/opencode/opencode.db) was initialized by the OpenCode v2 beta,",
      "which the current release cannot open. Give one generation its own database: set",
      "OPENCURSOR_OPENCODE_DB=opencode-current.db (current release) or OPENCURSOR_OPENCODE_V2_DB=opencode-beta.db",
      "(v2 beta) in Cesium's environment - relative to OpenCode's data dir or absolute - or start the current",
      "release once before the beta on a fresh data directory.",
    ].join(" ");
  }
  if (/EADDRINUSE|address already in use|already in use by another process/i.test(text)) {
    return "The port OpenCode was asked to listen on is already in use; another OpenCode server may still be running.";
  }
  if (/Authentication required|Missing server password/i.test(text)) {
    return "OpenCode refused to start without a server password; set OPENCODE_PASSWORD (or OPENCURSOR_OPENCODE_V2_PASSWORD).";
  }
  return undefined;
}

export type ManagedServerReadinessInput = {
  child: ChildProcess;
  /** Human-readable name used in error messages, e.g. `OpenCode Server at http://…`. */
  label: string;
  /** Returns true once the server answers its health route. */
  probe: () => Promise<boolean>;
  timeoutMs: number;
  intervalMs: number;
  recentOutput: () => string[];
};

/**
 * Wait for a spawned OpenCode server to become healthy, but stop waiting the
 * moment the process dies or fails to spawn. Polling the health route alone
 * made a server that crashed on startup (missing binary, port clash, database
 * mismatch) look like a 20s timeout with no explanation.
 */
export async function waitForManagedServerReady(input: ManagedServerReadinessInput): Promise<void> {
  const { child } = input;
  let settled = false;
  let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  let onError: ((error: Error) => void) | undefined;
  const failure = new Promise<never>((_, reject) => {
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      const output = input.recentOutput();
      const hint = describeOpenCodeStartupFailure(output);
      const tail = output.slice(-6).join(" | ");
      reject(
        new Error(
          `${message}${hint ? ` ${hint}` : ""}${tail ? ` Last output: ${tail}` : ""}`
        )
      );
    };
    onExit = (code, signal) =>
      fail(
        `${input.label} exited before becoming healthy (code ${code ?? "null"}, signal ${signal ?? "null"}).`
      );
    onError = (error) => fail(`${input.label} failed to start: ${error.message}.`);
    if (child.exitCode != null || child.signalCode) {
      onExit(child.exitCode, child.signalCode);
      return;
    }
    child.once("exit", onExit);
    child.once("error", onError);
  });
  const healthy = (async () => {
    const deadline = Date.now() + input.timeoutMs;
    let lastError = "";
    while (Date.now() < deadline) {
      if (settled) return;
      try {
        if (await input.probe()) {
          settled = true;
          return;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, input.intervalMs));
    }
    if (settled) return;
    settled = true;
    const output = input.recentOutput();
    const tail = output.slice(-6).join(" | ");
    throw new Error(
      `${input.label} did not become healthy within ${Math.round(input.timeoutMs / 1000)}s.${
        lastError ? ` Last health error: ${lastError}.` : ""
      }${tail ? ` Last output: ${tail}` : ""}`
    );
  })();
  try {
    await Promise.race([healthy, failure]);
  } finally {
    if (onExit) child.off("exit", onExit);
    if (onError) child.off("error", onError);
  }
}
