import { agentRuntimeManager } from "../lib/agents/runtime-manager.js";
import { flushServerPerfReport } from "../lib/perf.js";

const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
/** Extra time past the drain bound for marking turns and stopping the listener. */
const EXIT_GRACE_MS = 5_000;

export type GracefulShutdownOptions = {
  stopServer: () => void | Promise<void>;
  drainTimeoutMs?: number;
  signals?: NodeJS.Signals[];
  exit?: (code: number) => void;
  shutdownAgents?: (options: { timeoutMs?: number }) => Promise<{
    interrupted: string[];
    drained: boolean;
  }>;
};

/**
 * SIGTERM/SIGINT handling for a server entry point: refuse new agent turns,
 * interrupt the running ones and record that on their conversations, stop
 * the listener, then exit. A second signal exits at once. Other modules only
 * add cleanup listeners, and a signal listener disables Node's default exit,
 * so this handler must always end the process itself.
 *
 * Returns a function that removes the handlers.
 */
export function installGracefulShutdown(options: GracefulShutdownOptions): () => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const shutdownAgents =
    options.shutdownAgents ?? ((input) => agentRuntimeManager.shutdown(input));
  const signals = options.signals ?? ["SIGTERM", "SIGINT"];
  let started = false;

  const onSignal = (signal: NodeJS.Signals) => {
    if (started) {
      console.warn(`[shutdown] ${signal} received again; exiting without waiting.`);
      exit(1);
      return;
    }
    started = true;
    console.log(`[shutdown] ${signal} received; interrupting running agent turns…`);
    const hardExit = setTimeout(() => {
      console.warn("[shutdown] timed out; exiting.");
      exit(1);
    }, drainTimeoutMs + EXIT_GRACE_MS);
    hardExit.unref?.();
    void (async () => {
      try {
        const result = await shutdownAgents({ timeoutMs: drainTimeoutMs });
        if (result.interrupted.length > 0 || !result.drained) {
          console.log(
            `[shutdown] marked ${result.interrupted.length} agent turn(s) interrupted${
              result.drained ? "" : " (some did not unwind in time)"
            }.`
          );
        }
      } catch (error) {
        console.warn(
          "[shutdown] interrupting agent turns failed:",
          error instanceof Error ? error.message : error
        );
      }
      await flushServerPerfReport("shutdown").catch(() => undefined);
      try {
        await options.stopServer();
      } catch (error) {
        console.warn(
          "[shutdown] stopping the listener failed:",
          error instanceof Error ? error.message : error
        );
      }
      clearTimeout(hardExit);
      exit(0);
    })();
  };

  for (const signal of signals) {
    process.on(signal, onSignal);
  }
  return () => {
    for (const signal of signals) {
      process.off(signal, onSignal);
    }
  };
}
