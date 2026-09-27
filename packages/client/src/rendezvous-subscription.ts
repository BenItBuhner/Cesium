import type { EncryptedRendezvousRecord } from "./rendezvous";

export type CloudRendezvousSnapshot = {
  serverIds: string[];
  records: Array<EncryptedRendezvousRecord | null>;
};

type Listener = (snapshot: CloudRendezvousSnapshot | null) => void;

let currentSnapshot: CloudRendezvousSnapshot | null = null;
const listeners = new Set<Listener>();

/**
 * Small cross-package bridge from the app's Convex provider to the shared
 * server-connections provider. It keeps Convex as an optional app concern:
 * Electron/local-only consumers of @cesium/client do not depend on Convex.
 */
export function publishCloudRendezvousSnapshot(
  snapshot: CloudRendezvousSnapshot | null
): void {
  currentSnapshot = snapshot;
  for (const listener of listeners) {
    listener(snapshot);
  }
}

export function readCloudRendezvousSnapshot(): CloudRendezvousSnapshot | null {
  return currentSnapshot;
}

export function subscribeCloudRendezvousSnapshot(listener: Listener): () => void {
  listeners.add(listener);
  listener(currentSnapshot);
  return () => listeners.delete(listener);
}
