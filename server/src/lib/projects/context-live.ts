import { promises as fs } from "node:fs";
import { PROJECT_HOME_ENGINE_ID } from "@cesium/core/projects";
import { onProjectContextWrite } from "./context-store.js";
import { isProjectContextClosed, syncProjectContextWithPeer } from "./context-sync.js";
import { watchContextTree, type ContextTreeWatch } from "./context-watch.js";
import { getPeerEngine, listEngineSummaries, notePeerEngineContact } from "./engine-registry.js";
import { isProjectsEnabled } from "./feature-flag.js";
import { getProjectContextDir } from "./paths.js";
import { PeerClient, PeerRequestError } from "./peer-client.js";
import { listProjectRecords, subscribeProjectStoreEvents } from "./project-store.js";
import type { ProjectRecord } from "./types.js";

/**
 * Live Context sync, on the home engine: a write on either side reaches the
 * other within moments instead of at the next periodic sync.
 * - Home → peer: each synced Project's context folder is watched (and the
 *   context routes and tools report their writes); a change syncs the
 *   Project with every peer that holds a copy.
 * - Peer → home: one request per peer stays open on its peer API
 *   (`context-changes`); the peer answers it when one of its copies changes,
 *   and the home syncs that Project with it.
 * Each sync is the ordinary one (`syncProjectContextWithPeer`), so its rules
 * hold: the home wins, conflicting edits are kept beside the original, and
 * deletions only flow home → peer. The periodic sync stays as a safety net.
 */

/** Writes at home settle this long (a burst of files, a folder and its file) before a sync starts... */
const HOME_SETTLE_MS = 100;
/** ...but a folder that keeps changing is still synced this often. */
const SETTLE_MAX_MS = 1_000;
/** How long one request for a peer's changes waits for one. */
const LINK_WAIT_MS = 25_000;
const LINK_RETRY_MS = 1_000;
const LINK_RETRY_MAX_MS = 30_000;
/** A peer from before live sync answers 404; it is asked again this rarely. */
const LINK_UNSUPPORTED_RETRY_MS = 5 * 60_000;
const WARN_INTERVAL_MS = 60_000;
const CONTEXT_WATCH_DEPTH = 8;

type LiveProject = {
  /** Peers that hold a copy of this Project's context. */
  engines: Set<string>;
  watch: ContextTreeWatch | null;
  watchStarted: boolean;
  /** The watch finished its first scan and has not failed. */
  watching: boolean;
};

type PeerLink = { stop: AbortController; up: boolean };

const projects = new Map<string, LiveProject>();
const links = new Map<string, PeerLink>();
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; firstAt: number }>();
const lastWarnedAt = new Map<string, number>();
let stopListening: (() => void) | null = null;

/** Peer engines holding a copy of the Project's context: those its live agents run on. */
export function peerEnginesWithContext(record: ProjectRecord): string[] {
  return [
    ...new Set(
      record.children
        .filter((child) => child.deletedAt == null && child.archivedAt == null && child.engineId !== PROJECT_HOME_ENGINE_ID)
        .map((child) => child.engineId)
    ),
  ];
}

function warn(key: string, message: string, error: unknown): void {
  const now = Date.now();
  if (now - (lastWarnedAt.get(key) ?? 0) < WARN_INTERVAL_MS) {
    return;
  }
  lastWarnedAt.set(key, now);
  console.warn(message, error instanceof Error ? error.message : error);
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
  });
}

async function runSync(projectId: string, engineId: string): Promise<void> {
  if (!projects.get(projectId)?.engines.has(engineId) || isProjectContextClosed(projectId)) {
    return;
  }
  try {
    await syncProjectContextWithPeer(projectId, engineId, { fresh: true });
  } catch (error) {
    warn(`sync:${projectId}:${engineId}`, `[projects] could not sync the context of ${projectId} with engine ${engineId}:`, error);
  }
}

function requestSync(projectId: string, engineId: string, settleMs: number): void {
  const key = `${projectId}:${engineId}`;
  const now = Date.now();
  const queued = pending.get(key);
  if (queued) {
    clearTimeout(queued.timer);
  }
  const firstAt = queued?.firstAt ?? now;
  const timer = setTimeout(() => {
    pending.delete(key);
    void runSync(projectId, engineId);
  }, Math.max(0, Math.min(settleMs, firstAt + SETTLE_MAX_MS - now)));
  timer.unref?.();
  pending.set(key, { timer, firstAt });
}

function requestProjectSyncs(projectId: string, settleMs: number): void {
  for (const engineId of projects.get(projectId)?.engines ?? []) {
    requestSync(projectId, engineId, settleMs);
  }
}

function cancelSyncs(projectId: string, engineId?: string): void {
  for (const [key, queued] of pending) {
    if (key === `${projectId}:${engineId}` || (engineId === undefined && key.startsWith(`${projectId}:`))) {
      clearTimeout(queued.timer);
      pending.delete(key);
    }
  }
}

function watchProject(projectId: string, entry: LiveProject): void {
  entry.watchStarted = true;
  const root = getProjectContextDir(projectId);
  void fs.stat(root).then(
    (stat) => {
      if (projects.get(projectId) !== entry || !stat.isDirectory()) {
        return;
      }
      const watch = watchContextTree(root, {
        depth: CONTEXT_WATCH_DEPTH,
        onChange: () => requestProjectSyncs(projectId, HOME_SETTLE_MS),
        onError: (error) => {
          entry.watching = false;
          warn(`watch:${projectId}`, `[projects] watching the context of ${projectId} failed; its peers get changes from the periodic sync:`, error);
        },
      });
      entry.watch = watch;
      void watch.ready.then(() => {
        if (projects.get(projectId) !== entry) {
          void watch.close().catch(() => undefined);
          return;
        }
        entry.watching = true;
        // Whatever changed before the watch started.
        requestProjectSyncs(projectId, 0);
      });
    },
    () => {
      // No context folder (yet): the periodic sync covers this Project.
      entry.watchStarted = false;
    }
  );
}

/** Keeps a request for the peer's context changes open and syncs the Projects it reports. */
async function followPeer(engineId: string, link: PeerLink): Promise<void> {
  const { signal } = link.stop;
  let feed: string | null = null;
  let cursor = 0;
  let failures = 0;
  while (!signal.aborted) {
    const engine = await getPeerEngine(engineId).catch(() => null);
    if (!engine?.connection.token) {
      link.up = false;
      await pause(LINK_RETRY_MAX_MS, signal);
      continue;
    }
    try {
      const changes = await new PeerClient(engine.connection).contextChanges({ feed, cursor, waitMs: LINK_WAIT_MS }, signal);
      if (signal.aborted) {
        return;
      }
      notePeerEngineContact(engineId, null);
      failures = 0;
      link.up = true;
      // A new feed is a restarted peer (or a first request): anything may have changed.
      const everything = changes.reset || changes.feed !== feed;
      feed = changes.feed;
      cursor = changes.cursor;
      for (const [projectId, entry] of projects) {
        if (entry.engines.has(engineId) && (everything || changes.projects.includes(projectId))) {
          requestSync(projectId, engineId, 0);
        }
      }
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      link.up = false;
      if (error instanceof PeerRequestError && error.status === 404) {
        // An engine from before live sync: the periodic sync keeps its copies current.
        await pause(LINK_UNSUPPORTED_RETRY_MS, signal);
        continue;
      }
      notePeerEngineContact(engineId, error);
      failures += 1;
      warn(`link:${engineId}`, `[projects] lost the live context link to engine ${engineId}, retrying:`, error);
      await pause(Math.min(LINK_RETRY_MAX_MS, LINK_RETRY_MS * 2 ** Math.min(failures - 1, 5)), signal);
    }
  }
}

function updateLinks(): void {
  const wanted = new Set<string>();
  for (const entry of projects.values()) {
    for (const engineId of entry.engines) {
      wanted.add(engineId);
    }
  }
  for (const [engineId, link] of links) {
    if (!wanted.has(engineId)) {
      link.stop.abort();
      links.delete(engineId);
    }
  }
  for (const engineId of wanted) {
    if (!links.has(engineId)) {
      const link: PeerLink = { stop: new AbortController(), up: false };
      links.set(engineId, link);
      void followPeer(engineId, link);
    }
  }
}

function closeProject(projectId: string, entry: LiveProject): void {
  projects.delete(projectId);
  cancelSyncs(projectId);
  void entry.watch?.close().catch(() => undefined);
}

/** Starts or stops live sync for one Project given the peers that hold a copy of its context. */
function applyProject(projectId: string, engines: readonly string[]): void {
  if (!stopListening) {
    return;
  }
  const entry = projects.get(projectId);
  if (engines.length === 0 || isProjectContextClosed(projectId)) {
    if (entry) {
      closeProject(projectId, entry);
      updateLinks();
    }
    return;
  }
  if (!entry) {
    const created: LiveProject = { engines: new Set(engines), watch: null, watchStarted: false, watching: false };
    projects.set(projectId, created);
    watchProject(projectId, created);
  } else {
    const added = engines.filter((engineId) => !entry.engines.has(engineId));
    for (const engineId of entry.engines) {
      if (!engines.includes(engineId)) {
        cancelSyncs(projectId, engineId);
      }
    }
    entry.engines = new Set(engines);
    if (entry.watching) {
      // A peer that just got its copy: catch up on anything written since.
      for (const engineId of added) {
        requestSync(projectId, engineId, 0);
      }
    }
    if (!entry.watchStarted) {
      watchProject(projectId, entry);
    }
  }
  updateLinks();
}

/**
 * Brings live sync in line with the Project records and paired engines: at
 * start, and as a backstop on each peer poll (store events cover the rest).
 */
export async function reconcileLiveContextSync(records?: readonly ProjectRecord[]): Promise<void> {
  if (!stopListening) {
    return;
  }
  const list = (await isProjectsEnabled()) ? (records ?? (await listProjectRecords())) : [];
  const paired = new Set((await listEngineSummaries()).filter((engine) => engine.kind === "peer").map((engine) => engine.id));
  const seen = new Set<string>();
  for (const record of list) {
    seen.add(record.id);
    applyProject(record.id, peerEnginesWithContext(record).filter((engineId) => paired.has(engineId)));
  }
  for (const projectId of [...projects.keys()]) {
    if (!seen.has(projectId)) {
      applyProject(projectId, []);
    }
  }
}

export function stopLiveContextSync(): void {
  stopListening?.();
  stopListening = null;
  for (const [projectId, entry] of [...projects]) {
    closeProject(projectId, entry);
  }
  for (const link of links.values()) {
    link.stop.abort();
  }
  links.clear();
  for (const queued of pending.values()) {
    clearTimeout(queued.timer);
  }
  pending.clear();
}

/** Starts live sync for every Project with copies on peers and follows Project changes; returns a stop function. */
export function startLiveContextSync(): () => void {
  if (stopListening) {
    return stopLiveContextSync;
  }
  const unsubscribeStore = subscribeProjectStoreEvents((event) => {
    if (event.type === "project") {
      applyProject(event.project.id, peerEnginesWithContext(event.project));
    } else {
      applyProject(event.projectId, []);
    }
  });
  const unsubscribeWrites = onProjectContextWrite((projectId) => requestProjectSyncs(projectId, HOME_SETTLE_MS));
  stopListening = () => {
    unsubscribeStore();
    unsubscribeWrites();
  };
  void reconcileLiveContextSync().catch((error: unknown) =>
    warn("reconcile", "[projects] could not start live context sync:", error)
  );
  return stopLiveContextSync;
}

/** A Project being deleted: stop watching it and drop its pending syncs. */
export function forgetLiveContextProject(projectId: string): void {
  applyProject(projectId, []);
}

/** True while writes on both sides of this Project and peer reach the other live. */
export function isLiveContextSyncUp(projectId: string, engineId: string): boolean {
  const entry = projects.get(projectId);
  return Boolean(entry?.watching && entry.engines.has(engineId) && links.get(engineId)?.up);
}

/** What live sync is doing, for diagnostics and tests. */
export function liveContextSyncStatus(): {
  projects: Record<string, { engines: string[]; watching: boolean }>;
  links: Record<string, { up: boolean }>;
} {
  return {
    projects: Object.fromEntries(
      [...projects].map(([projectId, entry]) => [projectId, { engines: [...entry.engines].sort(), watching: entry.watching }])
    ),
    links: Object.fromEntries([...links].map(([engineId, link]) => [engineId, { up: link.up }])),
  };
}
