/**
 * Cross-harness subscription/usage reporting ("Codex Meter for everything").
 *
 * Each collector reads the on-disk session artifacts a coding-agent CLI leaves
 * behind (rollouts, transcripts, sqlite stores…) and reduces them into one
 * normalized `ProviderUsageReport`. Collectors never talk to remote APIs —
 * everything is local-first and read-only.
 */

export type UsageTokenTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

export type UsageTotals = UsageTokenTotals & {
  /** Known-accurate spend (only harnesses that persist cost report it). */
  costUsd: number | null;
  sessions: number;
  /** Assistant turns / billed requests observed in the window. */
  requests: number;
};

export type UsageDailyBucket = UsageTokenTotals & {
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  costUsd: number | null;
  requests: number;
};

export type UsageModelBreakdown = UsageTokenTotals & {
  model: string;
  costUsd: number | null;
  requests: number;
};

/**
 * Fine-grained time-series bucket (30-minute aligned, UTC epoch ms). Sparse:
 * only buckets with activity are emitted; clients densify for charting.
 */
export type UsageSeriesPoint = UsageTokenTotals & {
  /** Epoch ms of the bucket start. */
  ts: number;
  costUsd: number | null;
  requests: number;
};

/**
 * Point-in-time subscription meter observation (e.g. Codex rate_limits
 * snapshots), used to chart limit consumption over time and project when a
 * window will be exhausted.
 */
export type UsageLimitSnapshotPoint = {
  /** Epoch ms the harness reported this observation. */
  ts: number;
  windows: Array<{ id: string; usedPercent: number }>;
};

/**
 * A subscription rate-limit meter (e.g. Codex 5h / weekly windows) or a
 * rolling-session block for providers that do not expose hard percentages.
 */
export type UsageLimitWindow = {
  id: string;
  label: string;
  /** 0-100 when the harness exposes a real percentage; null when unknown. */
  usedPercent: number | null;
  windowMinutes: number | null;
  resetsAt: string | null;
  /** When the snapshot was observed (rate limits are point-in-time). */
  capturedAt: string | null;
  /** Free-form supplement, e.g. "2.1M tokens this block". */
  detail: string | null;
};

export type ProviderUsageReport = {
  id: string;
  label: string;
  vendor: string;
  available: boolean;
  /** Why no data is available (harness not installed, cloud-only, …). */
  reason: string | null;
  /** Where the data came from, for transparency. */
  storageRoot: string | null;
  /** Subscription plan when discoverable locally (e.g. ChatGPT plan type). */
  plan: string | null;
  limitWindows: UsageLimitWindow[];
  /** Historical meter observations, oldest first (empty when not exposed). */
  limitSnapshots: UsageLimitSnapshotPoint[];
  totals: UsageTotals;
  days: UsageDailyBucket[];
  /** Sparse 30-minute buckets across the lookback, oldest first. */
  series: UsageSeriesPoint[];
  models: UsageModelBreakdown[];
  /** True when token counts are heuristic (chars/4) rather than provider-reported. */
  estimated: boolean;
  lastActivityAt: string | null;
};

export type UsageOverview = {
  generatedAt: string;
  lookbackDays: number;
  providers: ProviderUsageReport[];
};
