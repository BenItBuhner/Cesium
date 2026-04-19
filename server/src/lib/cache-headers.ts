import type { Context } from "hono";

/**
 * Browser HTTP caching hints for stable-ish GET endpoints.
 *
 * `private` — never shared by a proxy (authenticated data).
 * `max-age=N` — browser can serve from cache for N seconds with no round-trip.
 * `stale-while-revalidate=M` — for another M seconds, return the stale entry
 * instantly and revalidate in the background.
 *
 * Combined with the fact that the client subscribes to change events over
 * WebSocket, this is safe: a user-visible list can lag by a few seconds on a
 * cold reload and the WS push updates it anyway.
 */
export function setShortCache(
  c: Context,
  { maxAgeSec = 15, swr = 60 }: { maxAgeSec?: number; swr?: number } = {}
): void {
  c.header(
    "Cache-Control",
    `private, max-age=${maxAgeSec}, stale-while-revalidate=${swr}`
  );
  // Vary on workspace + session so two tabs with different workspaces don't
  // poison each other's cache entries.
  c.header("Vary", "x-opencursor-workspace-id, x-opencursor-session-token, Cookie");
}

export function setNoCache(c: Context): void {
  c.header("Cache-Control", "no-store, max-age=0");
}
