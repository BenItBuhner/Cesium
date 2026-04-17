/**
 * Debounced write coalescer (OSP-75 performance phase).
 *
 * High-frequency PUTs to the same key — session resizes, global-settings
 * toggles spammed from a slider, etc. — get collapsed into a single actual
 * write after a short idle window. The HTTP handler can return `ok: true`
 * immediately; the coalescer owns the actual persistence.
 *
 * Keys are caller-chosen strings (e.g. `workspace-session:<id>`) so different
 * categories can live in the same registry without colliding.
 *
 * Safe for mixed-instance deployments: the coalescer only collapses writes
 * that the SAME server process received within the window. Cross-process
 * invalidation still rides the normal pubsub channels.
 */

export type CoalesceFlush<T> = (value: T) => Promise<void> | void;

type CoalesceEntry<T> = {
  pending: T;
  timer: NodeJS.Timeout;
  inFlight: Promise<void> | null;
  /**
   * When a write lands DURING an in-flight flush, we mark dirty and replay
   * after the flush resolves, so no write is dropped by the debounce.
   */
  dirtyAfterFlush: boolean;
};

export class WriteCoalescer<T> {
  private readonly entries = new Map<string, CoalesceEntry<T>>();

  constructor(
    private readonly flushFn: (key: string, value: T) => Promise<void>,
    private readonly windowMs = 50
  ) {}

  schedule(key: string, value: T): void {
    const existing = this.entries.get(key);
    if (existing) {
      existing.pending = value;
      if (existing.inFlight) {
        existing.dirtyAfterFlush = true;
        return;
      }
      existing.timer.refresh();
      return;
    }

    const entry: CoalesceEntry<T> = {
      pending: value,
      // The timer will be replaced below; initialise with a never-fires sentinel.
      timer: setTimeout(() => undefined, 0),
      inFlight: null,
      dirtyAfterFlush: false,
    };
    entry.timer = setTimeout(() => {
      void this.runFlush(key);
    }, this.windowMs);
    this.entries.set(key, entry);
  }

  private async runFlush(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    const { pending } = entry;
    entry.inFlight = this.flushFn(key, pending).catch((error) => {
      // Swallow errors but surface them to the console so ops can notice. The
      // caller already got an `ok: true`; there isn't a client to return to.
      console.error(`[coalesce] flush failed for key=${key}:`, error);
    });
    try {
      await entry.inFlight;
    } finally {
      entry.inFlight = null;
      if (entry.dirtyAfterFlush) {
        entry.dirtyAfterFlush = false;
        entry.timer = setTimeout(() => {
          void this.runFlush(key);
        }, this.windowMs);
      } else {
        this.entries.delete(key);
      }
    }
  }

  /**
   * Flush one key immediately, bypassing the debounce window. Useful when the
   * caller wants to know a specific write has persisted (e.g. during shutdown
   * or when responding to an If-Match read-after-write).
   */
  async flushNow(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    if (entry.inFlight) {
      await entry.inFlight;
      if (!entry.dirtyAfterFlush) {
        return;
      }
      entry.dirtyAfterFlush = false;
    }
    await this.runFlush(key);
  }

  /** Drain every pending write. Await before shutdown. */
  async flushAll(): Promise<void> {
    const keys = [...this.entries.keys()];
    await Promise.allSettled(keys.map((key) => this.flushNow(key)));
  }

  /** Test helper - abandon pending writes without flushing. */
  _resetForTesting(): void {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
    }
    this.entries.clear();
  }
}
