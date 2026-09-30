import path from "node:path";
import chokidar from "chokidar";

/**
 * Watches a context folder (a Project's, or a peer's folder of mirrors) and
 * reports changed files relative to it. Hidden entries (engine-managed
 * `.cesium/…` files) are not Project context, and the engine's own temp
 * files are writes still in progress, so neither is ever reported.
 */

/** `notes.md.4242.1727600000000.tmp` (`.sync` for sync writes): the temp name of a write in progress. */
const WRITE_IN_PROGRESS = /\.\d{1,10}\.\d{13}\.(?:tmp|sync)$/;

export function isContextNoisePath(relative: string): boolean {
  return relative.split(/[\\/]/).some((segment) => segment.startsWith(".")) || WRITE_IN_PROGRESS.test(relative);
}

export type ContextTreeWatch = {
  /** Settles once the initial scan is done; changes after it are reported. */
  ready: Promise<void>;
  close(): Promise<void>;
};

export function watchContextTree(
  root: string,
  options: { depth: number; onChange: (relative: string) => void; onError?: (error: unknown) => void }
): ContextTreeWatch {
  const inside = (absolute: string): string | null => {
    const relative = path.relative(root, absolute);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.replace(/\\/g, "/") : null;
  };
  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    persistent: false,
    depth: options.depth,
    ignored: (watched) => {
      const relative = inside(watched);
      return relative !== null && isContextNoisePath(relative);
    },
  });
  const report = (absolute: string) => {
    const relative = inside(absolute);
    if (relative !== null && !isContextNoisePath(relative)) {
      options.onChange(relative);
    }
  };
  watcher.on("add", report).on("change", report).on("unlink", report).on("unlinkDir", report);
  watcher.on("error", (error) => options.onError?.(error));
  const ready = new Promise<void>((resolve) => watcher.once("ready", () => resolve()));
  return { ready, close: () => watcher.close() };
}
