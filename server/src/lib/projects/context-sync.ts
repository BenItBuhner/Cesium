import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { PROJECT_HOME_ENGINE_ID, projectSlug } from "@cesium/core/projects";
import {
  ProjectContextError,
  assertNoSymlinkEscapeIn,
  assertTotalFits,
  listContextEntriesIn,
  resolveContextPathIn,
} from "./context-store.js";
import { isContextNoisePath } from "./context-watch.js";
import { callPeerEngine, listEngineSummaries } from "./engine-registry.js";
import { getProjectContextDir, getProjectDir } from "./paths.js";

/**
 * Keeps a peer engine's copy of a Project context in step with the home's.
 * The home pushes its files to the peer's mirror (where agents on that peer
 * read and write them) and pulls back what those agents wrote. The home is
 * the source of truth: deletions only flow home → peer, notes.md and inbox/
 * are never pulled back, and when both sides changed a file the home keeps
 * its version and saves the peer's beside it as `name.conflict-<engine>.ext`.
 * A sync runs when either side writes (context-live.ts), before an agent
 * starts on a peer and after its turns, and periodically as a safety net.
 */

/** Largest file one sync moves; bigger ones stay put and are reported. */
export const CONTEXT_SYNC_FILE_MAX_BYTES = 50 * 1024 * 1024;

export type ContextManifestEntry = { path: string; size: number; sha256: string; mtimeMs: number };

const hashCache = new Map<string, { size: number; mtimeMs: number; sha256: string }>();

async function sha256Of(absolute: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolute)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function cachedSha256(absolute: string, stat: { size: number; mtimeMs: number }): Promise<string> {
  const cached = hashCache.get(absolute);
  const sha256 =
    cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs ? cached.sha256 : await sha256Of(absolute);
  hashCache.set(absolute, { size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
  return sha256;
}

/** A file's content hash now, or null when there is no file. */
export async function currentSha256(absolute: string): Promise<string | null> {
  const stat = await fs.stat(absolute).catch(() => null);
  return stat?.isFile() ? cachedSha256(absolute, stat) : null;
}

/** Every file under a context folder, with content hashes (cached by size and mtime). */
export async function contextManifest(root: string): Promise<ContextManifestEntry[]> {
  const { files } = await listContextEntriesIn(root);
  const entries: ContextManifestEntry[] = [];
  for (const file of files) {
    if (isContextNoisePath(file.path)) {
      continue;
    }
    const absolute = path.join(root, file.path);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile()) {
      continue;
    }
    const sha256 = await cachedSha256(absolute, stat);
    entries.push({ path: file.path, size: stat.size, sha256, mtimeMs: Math.round(stat.mtimeMs) });
  }
  return entries;
}

/** `ifMatch` for a file the peer did not have when the sync listed it. */
export const CONTEXT_FILE_ABSENT = "absent";

/** Drops cached hashes for a context folder that is being removed. */
export function forgetContextHashes(root: string): void {
  const prefix = `${path.resolve(root)}${path.sep}`;
  for (const key of hashCache.keys()) {
    if (key.startsWith(prefix)) {
      hashCache.delete(key);
    }
  }
}

/** Validated absolute path for a file in a context folder (no escapes, no hidden segments). */
export async function contextFileIn(root: string, relativePath: string): Promise<{ absolute: string; relative: string }> {
  await fs.mkdir(root, { recursive: true });
  const resolved = resolveContextPathIn(root, relativePath);
  await assertNoSymlinkEscapeIn(root, resolved.absolute);
  return resolved;
}

export async function writeContextBytesIn(
  root: string,
  relativePath: string,
  bytes: Uint8Array,
  mtimeMs: number | null
): Promise<void> {
  const { absolute, relative } = await contextFileIn(root, relativePath);
  if (bytes.byteLength > CONTEXT_SYNC_FILE_MAX_BYTES) {
    throw new ProjectContextError(`${relative} is larger than ${CONTEXT_SYNC_FILE_MAX_BYTES} bytes.`);
  }
  const existing = await fs.stat(absolute).catch(() => null);
  if (existing && !existing.isFile()) {
    throw new ProjectContextError(`${relative} is a directory.`);
  }
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temp = `${absolute}.${process.pid}.${Date.now()}.sync`;
  await fs.writeFile(temp, bytes);
  if (mtimeMs != null && Number.isFinite(mtimeMs)) {
    const when = new Date(mtimeMs);
    await fs.utimes(temp, when, when).catch(() => undefined);
  }
  await fs.rename(temp, absolute);
}

export async function deleteContextFileIn(root: string, relativePath: string): Promise<void> {
  const { absolute } = await contextFileIn(root, relativePath);
  await fs.rm(absolute, { force: true });
}

// ---------------------------------------------------------------------------
// Planning

export type ContextSyncAction =
  | { kind: "push"; path: string }
  | { kind: "pull"; path: string; to: string }
  | { kind: "delete_peer"; path: string }
  | { kind: "skip"; path: string; reason: string };

/** Paths only the home writes: the coordinator's status board and raw event payloads. */
export function isHomeOwnedContextPath(filePath: string): boolean {
  return filePath === "notes.md" || filePath.startsWith("inbox/");
}

/** `docs/plan.md` → `docs/plan.conflict-build-box.md`. */
export function conflictCopyPath(filePath: string, engineSlug: string): string {
  const slash = filePath.lastIndexOf("/");
  const dir = slash < 0 ? "" : filePath.slice(0, slash + 1);
  const base = slash < 0 ? filePath : filePath.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  return `${dir}${stem}.conflict-${engineSlug || "peer"}${ext}`;
}

/**
 * What one sync does, from both manifests and the hashes both sides agreed
 * on after the last sync (`base`).
 */
export function planContextSync(input: {
  home: readonly ContextManifestEntry[];
  peer: readonly ContextManifestEntry[];
  base: Readonly<Record<string, string>>;
  engineSlug: string;
  maxBytes?: number;
}): ContextSyncAction[] {
  const maxBytes = input.maxBytes ?? CONTEXT_SYNC_FILE_MAX_BYTES;
  const homeBy = new Map(input.home.map((entry) => [entry.path, entry]));
  const peerBy = new Map(input.peer.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...homeBy.keys(), ...peerBy.keys()])].sort();
  const actions: ContextSyncAction[] = [];
  const tooBig = (entry: ContextManifestEntry) => entry.size > maxBytes;
  for (const filePath of paths) {
    const home = homeBy.get(filePath);
    const peer = peerBy.get(filePath);
    const base = input.base[filePath];
    if (home && peer && home.sha256 === peer.sha256) {
      continue;
    }
    if (home && (!peer || peer.sha256 === base || isHomeOwnedContextPath(filePath))) {
      // New or changed at home, or the peer lost or edited a home-owned file.
      actions.push(tooBig(home) ? { kind: "skip", path: filePath, reason: "too large to copy" } : { kind: "push", path: filePath });
      continue;
    }
    if (!home && peer) {
      if (isHomeOwnedContextPath(filePath) || (base !== undefined && peer.sha256 === base)) {
        // Deleted at home since the last sync (or never the peer's to add).
        actions.push({ kind: "delete_peer", path: filePath });
      } else {
        actions.push(tooBig(peer) ? { kind: "skip", path: filePath, reason: "too large to copy" } : { kind: "pull", path: filePath, to: filePath });
      }
      continue;
    }
    if (home && peer) {
      if (tooBig(home) || tooBig(peer)) {
        actions.push({ kind: "skip", path: filePath, reason: "too large to copy" });
      } else if (home.sha256 === base) {
        actions.push({ kind: "pull", path: filePath, to: filePath });
      } else {
        // Both changed since the last sync: the home's version stays, the peer's is kept beside it.
        actions.push({ kind: "pull", path: filePath, to: conflictCopyPath(filePath, input.engineSlug) });
        actions.push({ kind: "push", path: filePath });
      }
    }
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Running a sync (home side)

export type ContextSyncResult = {
  pushed: string[];
  pulled: string[];
  deletedOnPeer: string[];
  conflicts: Array<{ path: string; savedAs: string }>;
  skipped: Array<{ path: string; reason: string }>;
};

type SyncState = { files: Record<string, string>; syncedAt: number };

function syncStatePath(projectId: string, engineId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(engineId)) {
    throw new Error(`Invalid engine id: ${engineId}`);
  }
  return path.join(getProjectDir(projectId), "context-sync", `${engineId}.json`);
}

async function readSyncState(projectId: string, engineId: string): Promise<SyncState> {
  try {
    const parsed = JSON.parse(await fs.readFile(syncStatePath(projectId, engineId), "utf8")) as Partial<SyncState>;
    const files =
      parsed.files && typeof parsed.files === "object"
        ? Object.fromEntries(
            Object.entries(parsed.files).filter((entry): entry is [string, string] => typeof entry[1] === "string")
          )
        : {};
    return { files, syncedAt: typeof parsed.syncedAt === "number" ? parsed.syncedAt : 0 };
  } catch {
    return { files: {}, syncedAt: 0 };
  }
}

async function writeSyncState(projectId: string, engineId: string, state: SyncState): Promise<void> {
  const file = syncStatePath(projectId, engineId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2));
  await fs.rename(temp, file);
}

const running = new Map<string, Promise<ContextSyncResult>>();
/** The one run queued behind a running one for callers that need a run started after their change. */
const followUps = new Map<string, Promise<ContextSyncResult>>();
/** Projects being deleted: no sync starts, and a running one stops after its current file. */
const closed = new Set<string>();
const CLOSE_WAIT_MS = 15_000;
const lastSyncAt = new Map<string, number>();
/** What came back from each peer since the coordinator was last told. */
const unreported = new Map<string, { pulled: Set<string>; conflicts: Map<string, string> }>();

/** When this engine last synced a Project's context with a peer (0: not since it started). */
export function contextSyncedAt(projectId: string, engineId: string): number {
  return lastSyncAt.get(`${projectId}:${engineId}`) ?? 0;
}

/** Files copied back from a peer (and conflict copies) since the last call, for the coordinator. */
export function takeUnreportedContextSync(projectId: string, engineId: string): Pick<ContextSyncResult, "pulled" | "conflicts"> {
  const key = `${projectId}:${engineId}`;
  const pending = unreported.get(key);
  unreported.delete(key);
  return {
    pulled: [...(pending?.pulled ?? [])].sort(),
    conflicts: [...(pending?.conflicts ?? new Map<string, string>())].map(([filePath, savedAs]) => ({ path: filePath, savedAs })),
  };
}

/** True once the Project's deletion has started: its context is no longer synced. */
export function isProjectContextClosed(projectId: string): boolean {
  return closed.has(projectId);
}

/**
 * Brings a peer's mirror of the Project context and the home's context in
 * step (see the module comment). One sync per Project and engine at a time;
 * a call while one runs waits for it and returns its result. With `fresh`,
 * the caller knows of a change the running sync may have listed too early,
 * so it gets the next run instead, shared with everyone who asked meanwhile.
 */
export function syncProjectContextWithPeer(
  projectId: string,
  engineId: string,
  options?: { fresh?: boolean }
): Promise<ContextSyncResult> {
  if (closed.has(projectId)) {
    return Promise.reject(new Error("The Project is being deleted."));
  }
  const key = `${projectId}:${engineId}`;
  const inFlight = running.get(key);
  if (inFlight && options?.fresh) {
    let followUp = followUps.get(key);
    if (!followUp) {
      followUp = inFlight
        .catch(() => undefined)
        .then(() => {
          followUps.delete(key);
          return syncProjectContextWithPeer(projectId, engineId);
        });
      followUps.set(key, followUp);
    }
    return followUp;
  }
  if (inFlight) {
    return inFlight;
  }
  const next = runContextSync(projectId, engineId).finally(() => {
    if (running.get(key) === next) {
      running.delete(key);
    }
  });
  running.set(key, next);
  return next;
}

async function runContextSync(projectId: string, engineId: string): Promise<ContextSyncResult> {
  const root = getProjectContextDir(projectId);
  await fs.mkdir(root, { recursive: true });
  const [home, peer, state, engines] = await Promise.all([
    contextManifest(root),
    callPeerEngine(engineId, (client) => client.contextManifest(projectId)),
    readSyncState(projectId, engineId),
    listEngineSummaries(),
  ]);
  const engineLabel = engines.find((engine) => engine.id === engineId)?.label ?? engineId;
  const actions = planContextSync({ home, peer, base: state.files, engineSlug: projectSlug(engineLabel, 32) });
  const homeBy = new Map(home.map((entry) => [entry.path, entry]));
  const peerBy = new Map(peer.map((entry) => [entry.path, entry]));
  const result: ContextSyncResult = { pushed: [], pulled: [], deletedOnPeer: [], conflicts: [], skipped: [] };
  const agreed: Record<string, string> = {};
  for (const entry of home) {
    if (peerBy.get(entry.path)?.sha256 === entry.sha256) {
      agreed[entry.path] = entry.sha256;
    }
  }
  for (const action of actions) {
    if (closed.has(projectId)) {
      return result;
    }
    try {
      // Writes are conditional on what was listed: a file an agent or the
      // coordinator changed since is left for the next sync, which sees both
      // edits and keeps the home's version with the peer's beside it.
      if (action.kind === "push") {
        const entry = homeBy.get(action.path)!;
        const bytes = await fs.readFile(path.join(root, action.path));
        const ifMatch = peerBy.get(action.path)?.sha256 ?? CONTEXT_FILE_ABSENT;
        await callPeerEngine(engineId, (client) =>
          client.writeContextFile(projectId, action.path, bytes, entry.mtimeMs, ifMatch)
        );
        agreed[action.path] = entry.sha256;
        result.pushed.push(action.path);
      } else if (action.kind === "pull") {
        const entry = peerBy.get(action.path)!;
        const bytes = await callPeerEngine(engineId, (client) => client.readContextFile(projectId, action.path));
        if (
          action.to === action.path &&
          (await currentSha256(path.join(root, action.path))) !== (homeBy.get(action.path)?.sha256 ?? null)
        ) {
          throw new ProjectContextError(`${action.path} changed here during the sync.`);
        }
        await assertTotalFits(projectId, action.to, bytes.byteLength);
        await writeContextBytesIn(root, action.to, bytes, entry.mtimeMs);
        if (action.to === action.path) {
          agreed[action.path] = entry.sha256;
          result.pulled.push(action.path);
        } else {
          result.conflicts.push({ path: action.path, savedAs: action.to });
        }
      } else if (action.kind === "delete_peer") {
        const ifMatch = peerBy.get(action.path)?.sha256 ?? CONTEXT_FILE_ABSENT;
        await callPeerEngine(engineId, (client) => client.deleteContextFile(projectId, action.path, ifMatch));
        result.deletedOnPeer.push(action.path);
      } else {
        result.skipped.push({ path: action.path, reason: action.reason });
        if (state.files[action.path]) {
          agreed[action.path] = state.files[action.path]!;
        }
      }
    } catch (error) {
      // Keep the old agreement so the next sync decides this path again.
      if (state.files[action.path]) {
        agreed[action.path] = state.files[action.path]!;
      }
      result.skipped.push({ path: action.path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  if (closed.has(projectId)) {
    return result;
  }
  await writeSyncState(projectId, engineId, { files: agreed, syncedAt: Date.now() });
  const key = `${projectId}:${engineId}`;
  lastSyncAt.set(key, Date.now());
  if (result.pulled.length > 0 || result.conflicts.length > 0) {
    const pending = unreported.get(key) ?? { pulled: new Set<string>(), conflicts: new Map<string, string>() };
    for (const filePath of result.pulled) {
      pending.pulled.add(filePath);
    }
    for (const conflict of result.conflicts) {
      pending.conflicts.set(conflict.path, conflict.savedAs);
    }
    unreported.set(key, pending);
  }
  return result;
}

/**
 * For a Project being deleted: stops syncing its context and has every peer
 * that holds a copy (engines of `engineIds` plus any it was synced with) drop
 * it. A peer that is offline keeps its copy until its token is revoked there.
 */
export async function dropProjectContextMirrors(projectId: string, engineIds: readonly string[]): Promise<void> {
  closed.add(projectId);
  (await import("./context-live.js")).forgetLiveContextProject(projectId);
  const inFlight = [...running].filter(([key]) => key.startsWith(`${projectId}:`)).map(([, run]) => run.catch(() => undefined));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(inFlight),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSE_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  forgetContextHashes(getProjectContextDir(projectId));
  const synced = await fs.readdir(path.join(getProjectDir(projectId), "context-sync")).catch(() => [] as string[]);
  const engines = new Set([
    ...engineIds,
    ...synced.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length)),
  ]);
  engines.delete(PROJECT_HOME_ENGINE_ID);
  for (const engineId of engines) {
    const key = `${projectId}:${engineId}`;
    lastSyncAt.delete(key);
    unreported.delete(key);
    await callPeerEngine(engineId, (client) => client.deleteContextMirror(projectId)).catch((error: unknown) => {
      console.warn(
        `[projects] engine ${engineId} could not drop its copy of the context of ${projectId}:`,
        error instanceof Error ? error.message : error
      );
    });
  }
}

/** One line for the coordinator about files that came back from a peer, or null. */
export function describeContextSync(
  result: Pick<ContextSyncResult, "pulled" | "conflicts">,
  engineName: string
): string | null {
  const parts: string[] = [];
  if (result.pulled.length > 0) {
    const shown = result.pulled.slice(0, 8);
    parts.push(
      `Copied back to the Project context from ${engineName}: ${shown.join(", ")}${result.pulled.length > shown.length ? ` and ${result.pulled.length - shown.length} more` : ""}.`
    );
  }
  for (const conflict of result.conflicts.slice(0, 4)) {
    parts.push(`${conflict.path} changed here and on ${engineName}; their version is at ${conflict.savedAs}.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}
