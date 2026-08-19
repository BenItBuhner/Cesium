"use client";

import { useSyncExternalStore } from "react";
import { formatAgentRailRelativeTime } from "@/lib/agent-rail-status";

const TICK_MS = 30_000;

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

/**
 * Relative "5m ago" label for a rail row, driven by ONE shared 30s ticker.
 *
 * The rail used to keep a `railNow` timestamp in the top-level component and
 * thread it into every row, so each tick re-rendered every row (thousands,
 * with heavy rails). The string snapshot here only changes when the LABEL
 * changes ("5m ago" -> "6m ago"), so `useSyncExternalStore` bails out of
 * re-rendering rows whose label is unchanged.
 */
export function useAgentRailRelativeTime(
  timestamp: number | null | undefined
): string | null {
  return useSyncExternalStore(
    subscribe,
    () =>
      timestamp == null ? null : formatAgentRailRelativeTime(timestamp, Date.now()),
    () => null
  );
}
