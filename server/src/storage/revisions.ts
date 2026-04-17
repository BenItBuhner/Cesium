/**
 * In-memory revision registry used by the settings/session HTTP routes to
 * surface weak ETags and enforce `If-Match` semantics on PUT.
 *
 * Why in-memory?
 *   * The legacy JSON driver has no real versioning (every write returns
 *     `{ revision: 0 }`).
 *   * The pg driver tracks revisions at the row level but its read-side API
 *     does not yet expose them, so the route layer has no cheap way to surface
 *     them without a second query.
 *   * For single-process deployments (the default today) a monotonic
 *     per-process counter is sufficient to detect concurrent writers from a
 *     different browser tab / keepalive PUT and reject with 412.
 *
 * The registry resets on process restart — clients simply re-fetch and pick up
 * the fresh ETag. When the driver's read side eventually exposes row
 * revisions, we swap the backing store for driver-sourced reads without
 * touching the routes.
 *
 * The returned ETag shape is a weak tag (`W/"<rev>"`) since we only compare
 * revision numbers — not byte-exact payloads.
 */

const revisions = new Map<string, number>();

export type RevisionParseResult = {
  raw: string;
  value: number;
};

/**
 * Returns the current revision for a key, initializing it to 0 if absent.
 * Callers that just want to read without creating a slot should use
 * {@link peekRevision} instead.
 */
export function getRevision(key: string): number {
  const existing = revisions.get(key);
  if (existing === undefined) {
    revisions.set(key, 0);
    return 0;
  }
  return existing;
}

/** Non-creating read. Returns `null` when the key has never been seen. */
export function peekRevision(key: string): number | null {
  const existing = revisions.get(key);
  return existing === undefined ? null : existing;
}

/**
 * Bumps the revision for a key and returns the new value. Accepts an optional
 * `to` override — used when the driver returned an authoritative revision
 * (e.g. pg driver returning row `revision + 1`) so the registry stays in sync
 * with any externally-sourced values.
 */
export function bumpRevision(key: string, to?: number): number {
  const current = revisions.get(key) ?? 0;
  const next =
    typeof to === "number" && Number.isFinite(to) && to > current
      ? Math.floor(to)
      : current + 1;
  revisions.set(key, next);
  return next;
}

/** Sets the revision for a key to a specific value — test helper. */
export function setRevisionForTesting(key: string, value: number): void {
  revisions.set(key, Math.max(0, Math.floor(value)));
}

/** Clears all tracked revisions — test helper. */
export function resetRevisionsForTesting(): void {
  revisions.clear();
}

/**
 * Parses an ETag or `If-Match` header value. Accepts:
 *   * `W/"123"`
 *   * `"123"`
 *   * `123`
 *
 * Anything else (including `*`, which is a wildcard in the RFC but is not
 * a meaningful revision signal for us) is rejected.
 */
export function parseRevisionHeader(
  value: string | null | undefined
): RevisionParseResult | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "*") return null;
  const match = trimmed.match(/^(?:W\/)?"?(\d+)"?$/);
  if (!match) return null;
  const numeric = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return { raw: trimmed, value: numeric };
}

/** Formats a revision number as a weak ETag header value. */
export function formatEtag(revision: number): string {
  return `W/"${Math.max(0, Math.floor(revision))}"`;
}
