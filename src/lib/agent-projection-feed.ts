"use client";

/**
 * Tiny pub/sub for the multi-agent projection set that `MobileBridgeSync`
 * already derives for the Android shell. Desktop (Electron) consumers
 * subscribe here instead of re-deriving projections from conversation state.
 */

import type { MobileAgentProjection } from "@/lib/mobile-agent-projection";

export type AgentProjectionFeedSnapshot = {
  projections: MobileAgentProjection[];
  bootstrapped: boolean;
};

type Listener = (snapshot: AgentProjectionFeedSnapshot) => void;

let latest: AgentProjectionFeedSnapshot = { projections: [], bootstrapped: false };
const listeners = new Set<Listener>();

export function publishAgentProjectionFeed(snapshot: AgentProjectionFeedSnapshot): void {
  latest = snapshot;
  for (const listener of [...listeners]) {
    try {
      listener(snapshot);
    } catch {
      // A broken subscriber must not break the publisher.
    }
  }
}

export function subscribeAgentProjectionFeed(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAgentProjectionFeedSnapshot(): AgentProjectionFeedSnapshot {
  return latest;
}
