import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { watchContextTree, type ContextTreeWatch } from "./context-watch.js";
import { getPeerMirrorsDir } from "./paths.js";
import type { PeerContextChanges } from "./peer-client.js";

/**
 * On a peer engine: tells the home that holds a peer token when a Project
 * context mirror kept for that token changes (an agent here saved findings
 * or a screenshot), so the home syncs it right away. The home keeps one
 * request open (`GET /api/projects/peer/context-changes`) and the feed
 * answers it on the first change. Writes the home made itself through the
 * sync routes are not reported back.
 */

/** Longest a request waits for a change before it is answered empty. */
export const CONTEXT_CHANGES_MAX_WAIT_MS = 25_000;
/** A burst of writes (a folder and its file, a temp file and its rename) settles into one report. */
const SETTLE_MS = 100;
const SETTLE_MAX_MS = 1_000;
const LOG_MAX = 500;
/** How long a write the home made is recognised when its watch event arrives. */
const OWN_WRITE_MS = 10_000;
/** A mirror the home dropped stays quiet while its folder is removed. */
const DROPPED_MS = 30_000;
/** A feed nobody has asked about for this long stops watching. */
const IDLE_CLOSE_MS = 10 * 60_000;
const READY_WAIT_MS = 5_000;
const MIRROR_WATCH_DEPTH = 10;

/** What a file looks like right after the home's own write, or `"absent"` after its delete. */
export type OwnMirrorWrite = { size: number; mtimeMs: number } | "absent";

class MirrorFeed {
  readonly id = randomBytes(8).toString("hex");
  readonly ready: Promise<void>;
  lastAskedAt = Date.now();
  private seq = 0;
  private log: Array<{ seq: number; projectId: string }> = [];
  private readonly waiters = new Set<() => void>();
  private readonly settling = new Set<string>();
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private settleStartedAt = 0;
  private readonly ownWrites = new Map<string, { expect: OwnMirrorWrite; until: number }>();
  private readonly dropped = new Map<string, number>();
  private watch: ContextTreeWatch | null = null;
  private closed = false;

  constructor(private readonly root: string) {
    this.ready = this.start().catch((error: unknown) => {
      console.warn(
        `[projects] cannot watch the Project context mirrors in ${root}; homes fall back to their periodic sync:`,
        error instanceof Error ? error.message : error
      );
    });
  }

  get waiting(): number {
    return this.waiters.size;
  }

  private async start(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    if (this.closed) {
      return;
    }
    this.watch = watchContextTree(this.root, {
      depth: MIRROR_WATCH_DEPTH,
      onChange: (relative) => void this.changed(relative),
      onError: (error) =>
        console.warn("[projects] watching Project context mirrors failed:", error instanceof Error ? error.message : error),
    });
    await this.watch.ready;
  }

  private async changed(relative: string): Promise<void> {
    const [projectId, folder, ...rest] = relative.split("/");
    if (!projectId || folder !== "context" || rest.length === 0 || this.closed) {
      return;
    }
    if ((this.dropped.get(projectId) ?? 0) > Date.now() || (await this.isOwnWrite(path.join(this.root, relative)))) {
      return;
    }
    this.settling.add(projectId);
    const now = Date.now();
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
    } else {
      this.settleStartedAt = now;
    }
    this.settleTimer = setTimeout(
      () => this.publish(),
      Math.max(0, Math.min(SETTLE_MS, this.settleStartedAt + SETTLE_MAX_MS - now))
    );
    this.settleTimer.unref?.();
  }

  private async isOwnWrite(absolute: string): Promise<boolean> {
    const own = this.ownWrites.get(absolute);
    if (!own) {
      return false;
    }
    if (own.until < Date.now()) {
      this.ownWrites.delete(absolute);
      return false;
    }
    const stat = await fs.stat(absolute).catch(() => null);
    if (own.expect === "absent") {
      return stat === null;
    }
    return Boolean(stat?.isFile() && stat.size === own.expect.size && Math.abs(stat.mtimeMs - own.expect.mtimeMs) < 2);
  }

  private publish(): void {
    this.settleTimer = null;
    for (const projectId of this.settling) {
      this.seq += 1;
      this.log.push({ seq: this.seq, projectId });
    }
    this.settling.clear();
    if (this.log.length > LOG_MAX) {
      this.log.splice(0, this.log.length - LOG_MAX);
    }
    this.wake();
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) {
      waiter();
    }
  }

  expectOwnWrite(absolute: string, expect: OwnMirrorWrite): void {
    const now = Date.now();
    for (const [key, own] of this.ownWrites) {
      if (own.until < now) {
        this.ownWrites.delete(key);
      }
    }
    this.ownWrites.set(absolute, { expect, until: now + OWN_WRITE_MS });
  }

  dropProject(projectId: string): void {
    this.dropped.set(projectId, Date.now() + DROPPED_MS);
    this.settling.delete(projectId);
    this.log = this.log.filter((entry) => entry.projectId !== projectId);
  }

  /** Changes after `cursor`, a reset when the cursor is not this feed's, or null when nothing is new. */
  private since(feed: string | null, cursor: number): PeerContextChanges | null {
    const oldest = this.log[0]?.seq ?? this.seq + 1;
    if (feed !== this.id || !Number.isInteger(cursor) || cursor > this.seq || cursor < oldest - 1) {
      return { feed: this.id, cursor: this.seq, projects: [], reset: true };
    }
    const projects = [...new Set(this.log.filter((entry) => entry.seq > cursor).map((entry) => entry.projectId))];
    return projects.length > 0 ? { feed: this.id, cursor: this.seq, projects, reset: false } : null;
  }

  /** Answers now when something changed after `cursor`, else on the next change or after `waitMs`; null once closed. */
  async next(input: { feed: string | null; cursor: number; waitMs: number; signal?: AbortSignal }): Promise<PeerContextChanges | null> {
    this.lastAskedAt = Date.now();
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.ready,
      new Promise<void>((resolve) => {
        readyTimer = setTimeout(resolve, READY_WAIT_MS);
      }),
    ]);
    clearTimeout(readyTimer);
    const immediate = this.closed ? null : this.since(input.feed, input.cursor);
    if (this.closed || immediate) {
      return immediate;
    }
    if (input.waitMs > 0 && !input.signal?.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", done);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, input.waitMs);
        this.waiters.add(done);
        input.signal?.addEventListener("abort", done, { once: true });
      });
    }
    this.lastAskedAt = Date.now();
    if (this.closed) {
      return null;
    }
    return this.since(input.feed, input.cursor) ?? { feed: this.id, cursor: this.seq, projects: [], reset: false };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this.wake();
    await this.ready;
    await this.watch?.close().catch(() => undefined);
    this.watch = null;
  }
}

const feeds = new Map<string, MirrorFeed>();
let sweeper: ReturnType<typeof setInterval> | null = null;

function feedFor(tokenId: string): MirrorFeed {
  let feed = feeds.get(tokenId);
  if (!feed) {
    feed = new MirrorFeed(getPeerMirrorsDir(tokenId));
    feeds.set(tokenId, feed);
  }
  if (!sweeper) {
    sweeper = setInterval(() => {
      const now = Date.now();
      for (const [id, candidate] of feeds) {
        if (candidate.waiting === 0 && now - candidate.lastAskedAt > IDLE_CLOSE_MS) {
          feeds.delete(id);
          void candidate.close();
        }
      }
      if (feeds.size === 0 && sweeper) {
        clearInterval(sweeper);
        sweeper = null;
      }
    }, 60_000);
    sweeper.unref?.();
  }
  return feed;
}

/**
 * The next change to the mirrors kept for `tokenId` after the caller's
 * cursor (see `PeerContextChanges`), waiting up to `waitMs` for one. Null when
 * the token was revoked while the request waited.
 */
export function waitForMirrorChanges(
  tokenId: string,
  input: { feed: string | null; cursor: number; waitMs: number; signal?: AbortSignal }
): Promise<PeerContextChanges | null> {
  return feedFor(tokenId).next({ ...input, waitMs: Math.min(Math.max(0, input.waitMs), CONTEXT_CHANGES_MAX_WAIT_MS) });
}

/** The home is about to write (or delete) this file in its mirror: its watch event is not a change to report. */
export function expectOwnMirrorWrite(tokenId: string, absolute: string, expect: OwnMirrorWrite): void {
  feeds.get(tokenId)?.expectOwnWrite(absolute, expect);
}

/** The home dropped its copy of a Project: nothing about it is reported any more. */
export function dropMirrorFeedProject(tokenId: string, projectId: string): void {
  feeds.get(tokenId)?.dropProject(projectId);
}

/** The token was revoked: stop watching its mirrors and end the requests waiting on them. */
export async function closeMirrorFeed(tokenId: string): Promise<void> {
  const feed = feeds.get(tokenId);
  feeds.delete(tokenId);
  await feed?.close();
}
