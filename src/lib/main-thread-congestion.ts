/**
 * Shared main-thread congestion signal: decaying sum of recent long-task
 * milliseconds, fed by one lazy PerformanceObserver. Consumers use it to shed
 * load on slow or CPU-throttled devices — the stream batcher stretches its
 * commit window, and ambient animations (aurora) drop their frame rate — so
 * the frame budget recovers instead of death-spiraling.
 */

let recentLongTaskMs = 0;
let started = false;

function ensureStarted(): void {
  if (started) {
    return;
  }
  started = true;
  if (
    typeof PerformanceObserver === "undefined" ||
    !PerformanceObserver.supportedEntryTypes?.includes("longtask")
  ) {
    return;
  }
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        recentLongTaskMs = Math.min(3_000, recentLongTaskMs + entry.duration);
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
    setInterval(() => {
      recentLongTaskMs = Math.max(0, recentLongTaskMs * 0.5 - 4);
    }, 1_000);
  } catch {
    /* observer unsupported — signal stays 0 */
  }
}

/** Decaying long-task milliseconds; 0 means the main thread is healthy. */
export function recentMainThreadCongestionMs(): number {
  ensureStarted();
  return recentLongTaskMs;
}
