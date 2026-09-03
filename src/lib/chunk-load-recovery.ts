/**
 * Recovery for lazily loaded (code-split) chunks that fail to download.
 *
 * The web client ships as immutable, content-hashed chunks. When a new
 * deployment goes live, any tab still running the previous build keeps
 * referencing chunk URLs that no longer exist on the host, so the first
 * `next/dynamic` import after the deploy (opening the Terminal, Monaco, the
 * Browser tab, ...) gets a 404 and Turbopack throws a `ChunkLoadError`. Left
 * alone that error reaches the nearest React error boundary - historically
 * Next's default "Application error: a client-side exception has occurred"
 * page, a dead end that only a manual reload fixes.
 *
 * The same failure shape also shows up on flaky links (mobile radio wake, a
 * tunnel or proxy hiccup), which a plain retry fixes. So the strategy is:
 *
 *   1. retry the import once after a short delay;
 *   2. if it still fails as a chunk-load error, reload the page - at most once
 *      per {@link CHUNK_RELOAD_COOLDOWN_MS} per tab, so a chunk that is
 *      permanently broken cannot trap the user in a reload loop;
 *   3. only if the reload is not allowed, surface the error so the route
 *      error boundary can offer a manual reload.
 *
 * Everything with a side effect (clock, storage, reload, sleep) is injectable
 * for tests.
 */

export const CHUNK_RELOAD_STORAGE_KEY = "cesium:chunk-reload-at";
export const CHUNK_RELOAD_COOLDOWN_MS = 60_000;
export const CHUNK_RETRY_DELAY_MS = 400;
/**
 * How long a suspended import stays parked after a reload was requested before
 * it gives up and rethrows. Only matters if the navigation never happens (for
 * example a `beforeunload` prompt kept the page alive).
 */
export const CHUNK_RELOAD_GRACE_MS = 8_000;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export type ChunkRecoveryDeps = {
  now?: () => number;
  /** Pass `null` to simulate an environment without session storage. */
  storage?: StorageLike | null;
  reload?: () => void;
  sleep?: (ms: number) => Promise<void>;
};

const CHUNK_ERROR_MESSAGE_PATTERNS: readonly RegExp[] = [
  // Turbopack runtime (Next 15/16): "Failed to load chunk <url> from module <id>".
  /failed to load chunk/i,
  // webpack runtime: "Loading chunk 123 failed." / "Loading CSS chunk 123 failed."
  /loading (?:css )?chunk [\w./-]+ failed/i,
  // Native `import()` failures - Chromium, Firefox, WebKit respectively.
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  // Vite's CSS preload helper (desktop renderer).
  /unable to preload css/i,
];

function readErrorField(error: unknown, field: "name" | "message" | "cause"): unknown {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  return (error as Record<string, unknown>)[field];
}

/**
 * Recognises chunk / dynamic-import load failures across the bundlers and
 * browsers Cesium runs in. Walks `error.cause` because Turbopack wraps the
 * underlying network error.
 */
export function isChunkLoadError(error: unknown, depth = 0): boolean {
  if (depth > 4 || error === null || error === undefined) {
    return false;
  }
  if (typeof error === "string") {
    return CHUNK_ERROR_MESSAGE_PATTERNS.some((pattern) => pattern.test(error));
  }
  const name = readErrorField(error, "name");
  if (name === "ChunkLoadError") {
    return true;
  }
  const message = readErrorField(error, "message");
  if (
    typeof message === "string" &&
    CHUNK_ERROR_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
  ) {
    return true;
  }
  return isChunkLoadError(readErrorField(error, "cause"), depth + 1);
}

function resolveStorage(deps: ChunkRecoveryDeps): StorageLike | null {
  if (deps.storage !== undefined) {
    return deps.storage;
  }
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.sessionStorage;
  } catch {
    // Storage access can throw under strict privacy settings.
    return null;
  }
}

function readLastReloadAt(storage: StorageLike | null): number | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CHUNK_RELOAD_STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Whether {@link reloadForStaleChunks} would reload right now. Side-effect
 * free, so it is safe to call from a render or a state initialiser.
 */
export function canReloadForStaleChunks(deps: ChunkRecoveryDeps = {}): boolean {
  if (typeof window === "undefined" && deps.reload === undefined) {
    return false;
  }
  const now = deps.now ? deps.now() : Date.now();
  const lastReloadAt = readLastReloadAt(resolveStorage(deps));
  if (lastReloadAt === null) {
    return true;
  }
  // Absolute value so a stamp from the future (clock jump) is still treated as
  // "recent" until the cooldown has passed in either direction.
  return Math.abs(now - lastReloadAt) >= CHUNK_RELOAD_COOLDOWN_MS;
}

/**
 * Reloads the page to pick up the current deployment, at most once per
 * cooldown window per tab. Returns `true` when a reload was triggered.
 */
export function reloadForStaleChunks(deps: ChunkRecoveryDeps = {}): boolean {
  if (!canReloadForStaleChunks(deps)) {
    return false;
  }
  const now = deps.now ? deps.now() : Date.now();
  const storage = resolveStorage(deps);
  if (storage) {
    try {
      storage.setItem(CHUNK_RELOAD_STORAGE_KEY, String(now));
    } catch {
      // Best effort: without a stamp we still reload once, we just cannot
      // guard the next attempt.
    }
  }
  if (deps.reload) {
    deps.reload();
  } else if (typeof window !== "undefined") {
    window.location.reload();
  } else {
    return false;
  }
  return true;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps a dynamic `import()` so that chunk-load failures retry once and then
 * fall back to a guarded page reload instead of throwing into React.
 *
 * While the reload is pending the returned promise stays unsettled so the
 * `Suspense` fallback keeps rendering; it rejects with the original error after
 * {@link CHUNK_RELOAD_GRACE_MS} in case the navigation never happened.
 */
export async function loadChunkWithRecovery<T>(
  loader: () => Promise<T>,
  deps: ChunkRecoveryDeps = {}
): Promise<T> {
  const sleep = deps.sleep ?? defaultSleep;
  try {
    return await loader();
  } catch (error) {
    if (!isChunkLoadError(error)) {
      throw error;
    }
    await sleep(CHUNK_RETRY_DELAY_MS);
    try {
      return await loader();
    } catch (retryError) {
      if (isChunkLoadError(retryError) && reloadForStaleChunks(deps)) {
        await sleep(CHUNK_RELOAD_GRACE_MS);
      }
      throw retryError;
    }
  }
}
