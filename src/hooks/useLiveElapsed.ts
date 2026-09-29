"use client";

import { useSyncExternalStore } from "react";
import { formatAgentElapsed } from "@/lib/format-agent-run-duration";

const TICK_MS = 1_000;

const listeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (ticker == null) {
    ticker = setInterval(() => {
      for (const notify of [...listeners]) {
        notify();
      }
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && ticker != null) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}

function subscribeNever(): () => void {
  return () => {};
}

/**
 * Ticking "2m 14s" label since `startedAt`, driven by ONE shared 1s ticker.
 * Returns null while `startedAt` is unset or the elapsed time is below
 * `minMs`. `startedAt` is a server event timestamp, so client clock skew is
 * clamped to zero rather than shown as negative time.
 */
export function useLiveElapsedLabel(
  startedAt: number | null | undefined,
  minMs = 0
): string | null {
  return useSyncExternalStore(
    startedAt == null ? subscribeNever : subscribe,
    () => {
      if (startedAt == null) {
        return null;
      }
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      return elapsedMs < minMs ? null : formatAgentElapsed(elapsedMs);
    },
    () => null
  );
}
