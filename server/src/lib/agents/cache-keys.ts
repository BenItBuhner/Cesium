/** Central Redis keys for agent list/snapshot/rail so TTL and invalidation stay consistent. */
export const CONV_LIST_CACHE_PREFIX = "agent:conv-list:" as const;
export const CONV_SNAPSHOT_HEAD_CACHE_PREFIX = "agent:snap-head:" as const;
export const RAIL_ALL_FIRST_PAGE_CACHE_KEY = "agent:rail:all:page0";

/** Shorter TTL: hot lists; refreshed by post-write `scheduleAgentCacheRefill` after debounce. */
export const CONV_LIST_CACHE_TTL_SEC = 90;
/** Longer TTL: invalidation + refill on event bursts keeps this fresh without expiry stalls. */
export const CONV_SNAPSHOT_HEAD_CACHE_TTL_SEC = 2 * 60 * 60;
/** First page of the cross-workspace rail; rebuilt on debounced refills. */
export const RAIL_ALL_FIRST_PAGE_CACHE_TTL_SEC = 90;

export function conversationListCacheKey(workspaceId: string): string {
  return `${CONV_LIST_CACHE_PREFIX}${workspaceId}`;
}

export function snapshotHeadCacheKey(
  workspaceId: string,
  conversationId: string
): string {
  return `${CONV_SNAPSHOT_HEAD_CACHE_PREFIX}${workspaceId}:${conversationId}`;
}
