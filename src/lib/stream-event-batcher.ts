export const STREAM_EVENT_BATCH_WINDOW_MS = 50;

export type EventBatchMap<T> = Map<string, T[]>;

export type KeyedDeferredValue<T> = {
  key: string;
  value: T;
};

/**
 * A deferred stream value may lag within its current key, but must never leak
 * across keys when the user switches conversations.
 */
export function selectKeyedDeferredValue<T>(
  activeKey: string,
  currentValue: T,
  deferred: KeyedDeferredValue<T>
): T {
  return deferred.key === activeKey ? deferred.value : currentValue;
}

type ScheduleHandle = ReturnType<typeof globalThis.setTimeout>;

export type KeyedEventBatcherOptions<T> = {
  enabled: boolean;
  windowMs?: number;
  onFlush: (batches: EventBatchMap<T>) => void;
  schedule?: (callback: () => void, delayMs: number) => ScheduleHandle;
  cancel?: (handle: ScheduleHandle) => void;
};

/**
 * Coalesces high-frequency events from every active key into one client-state
 * update. A single timer is shared across foreground and background sessions,
 * so N concurrent streams still produce at most one render commit per window.
 */
export class KeyedEventBatcher<T> {
  private enabled: boolean;
  private readonly windowMs: number;
  private readonly onFlush: (batches: EventBatchMap<T>) => void;
  private readonly schedule: (callback: () => void, delayMs: number) => ScheduleHandle;
  private readonly cancel: (handle: ScheduleHandle) => void;
  private pending = new Map<string, T[]>();
  private timer: ScheduleHandle | null = null;

  constructor(options: KeyedEventBatcherOptions<T>) {
    this.enabled = options.enabled;
    this.windowMs = options.windowMs ?? STREAM_EVENT_BATCH_WINDOW_MS;
    this.onFlush = options.onFlush;
    this.schedule =
      options.schedule ??
      ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.cancel =
      options.cancel ??
      ((handle) => globalThis.clearTimeout(handle));
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      return;
    }
    if (!enabled) {
      this.flush();
    }
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  enqueue(key: string, events: readonly T[], flushNow = false): void {
    if (events.length === 0) {
      return;
    }
    if (!this.enabled) {
      this.onFlush(new Map([[key, [...events]]]));
      return;
    }

    const queued = this.pending.get(key);
    if (queued) {
      queued.push(...events);
    } else {
      this.pending.set(key, [...events]);
    }

    if (flushNow) {
      this.flush();
      return;
    }
    if (this.timer == null) {
      this.timer = this.schedule(() => {
        this.timer = null;
        this.flushPending();
      }, this.windowMs);
    }
  }

  flush(): void {
    if (this.timer != null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    this.flushPending();
  }

  pendingEventCount(): number {
    let count = 0;
    for (const events of this.pending.values()) {
      count += events.length;
    }
    return count;
  }

  discard(key: string): void {
    this.pending.delete(key);
    if (this.pending.size === 0 && this.timer != null) {
      this.cancel(this.timer);
      this.timer = null;
    }
  }

  clear(): void {
    if (this.timer != null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }

  dispose(): void {
    this.clear();
  }

  private flushPending(): void {
    if (this.pending.size === 0) {
      return;
    }
    const batches = this.pending;
    this.pending = new Map();
    this.onFlush(batches);
  }
}
