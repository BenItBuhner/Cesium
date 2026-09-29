type ShutdownHook = () => void | Promise<void>;

const hooks = new Set<ShutdownHook>();

/**
 * Registers cleanup that must run only after graceful shutdown has recorded
 * the interrupted agent turns and stopped the listener (e.g. closing the
 * database pool those records are written through). Returns an unregister.
 */
export function onShutdown(hook: ShutdownHook): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

/** Runs every registered hook once, in registration order; a failing hook does not stop the rest. */
export async function runShutdownHooks(): Promise<void> {
  const pending = [...hooks];
  hooks.clear();
  for (const hook of pending) {
    try {
      await hook();
    } catch (error) {
      console.warn("[shutdown] cleanup hook failed:", error instanceof Error ? error.message : error);
    }
  }
}
