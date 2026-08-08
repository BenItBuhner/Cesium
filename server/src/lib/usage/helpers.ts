import { promises as fs } from "node:fs";
import type {
  ProviderUsageReport,
  UsageDailyBucket,
  UsageModelBreakdown,
  UsageTokenTotals,
  UsageTotals,
} from "./types.js";

export function emptyTokenTotals(): UsageTokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

export function emptyTotals(): UsageTotals {
  return { ...emptyTokenTotals(), costUsd: null, sessions: 0, requests: 0 };
}

export type UsageSample = Partial<UsageTokenTotals> & {
  costUsd?: number;
};

/** Local calendar day (YYYY-MM-DD) for an epoch-ms timestamp. */
export function dayKey(epochMs: number): string {
  const d = new Date(epochMs);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * Incremental aggregator shared by all collectors: feeds per-request token
 * samples into totals, per-day buckets, and per-model breakdowns.
 */
export class UsageAggregator {
  private readonly byDay = new Map<string, UsageDailyBucket>();
  private readonly byModel = new Map<string, UsageModelBreakdown>();
  readonly totals: UsageTotals = emptyTotals();
  lastActivityMs: number | null = null;
  private readonly sessionIds = new Set<string>();

  addSession(id: string): void {
    this.sessionIds.add(id);
  }

  add(
    epochMs: number,
    model: string,
    sample: UsageSample,
    opts?: { countRequest?: boolean }
  ): void {
    const countRequest = opts?.countRequest !== false;
    const input = sample.inputTokens ?? 0;
    const output = sample.outputTokens ?? 0;
    const cacheRead = sample.cacheReadTokens ?? 0;
    const cacheWrite = sample.cacheWriteTokens ?? 0;
    const reasoning = sample.reasoningTokens ?? 0;
    const total =
      sample.totalTokens ?? input + output + cacheRead + cacheWrite;
    const cost = sample.costUsd;

    const apply = (target: UsageTokenTotals) => {
      target.inputTokens += input;
      target.outputTokens += output;
      target.cacheReadTokens += cacheRead;
      target.cacheWriteTokens += cacheWrite;
      target.reasoningTokens += reasoning;
      target.totalTokens += total;
    };

    apply(this.totals);
    if (countRequest) {
      this.totals.requests += 1;
    }
    if (cost !== undefined && Number.isFinite(cost)) {
      this.totals.costUsd = (this.totals.costUsd ?? 0) + cost;
    }
    if (this.lastActivityMs === null || epochMs > this.lastActivityMs) {
      this.lastActivityMs = epochMs;
    }

    const key = dayKey(epochMs);
    let day = this.byDay.get(key);
    if (!day) {
      day = { date: key, ...emptyTokenTotals(), costUsd: null, requests: 0 };
      this.byDay.set(key, day);
    }
    apply(day);
    if (countRequest) {
      day.requests += 1;
    }
    if (cost !== undefined && Number.isFinite(cost)) {
      day.costUsd = (day.costUsd ?? 0) + cost;
    }

    const modelKey = model || "unknown";
    let modelRow = this.byModel.get(modelKey);
    if (!modelRow) {
      modelRow = {
        model: modelKey,
        ...emptyTokenTotals(),
        costUsd: null,
        requests: 0,
      };
      this.byModel.set(modelKey, modelRow);
    }
    apply(modelRow);
    if (countRequest) {
      modelRow.requests += 1;
    }
    if (cost !== undefined && Number.isFinite(cost)) {
      modelRow.costUsd = (modelRow.costUsd ?? 0) + cost;
    }
  }

  finish(): {
    totals: UsageTotals;
    days: UsageDailyBucket[];
    models: UsageModelBreakdown[];
    lastActivityAt: string | null;
  } {
    this.totals.sessions = this.sessionIds.size;
    return {
      totals: this.totals,
      days: [...this.byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
      models: [...this.byModel.values()].sort(
        (a, b) => b.totalTokens - a.totalTokens
      ),
      lastActivityAt:
        this.lastActivityMs !== null
          ? new Date(this.lastActivityMs).toISOString()
          : null,
    };
  }
}

/** Standard "harness not detected" report so every collector reads the same. */
export function unavailableReport(
  base: Pick<ProviderUsageReport, "id" | "label" | "vendor">,
  reason: string,
  storageRoot: string | null
): ProviderUsageReport {
  return {
    ...base,
    available: false,
    reason,
    storageRoot,
    plan: null,
    limitWindows: [],
    totals: emptyTotals(),
    days: [],
    models: [],
    estimated: false,
    lastActivityAt: null,
  };
}

/** Rough chars/4 token estimate, matching cesium-context-usage heuristics. */
export function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * mtime-based prefilter: any file whose events overlap the lookback window
 * must have been written during (or after) it.
 */
export async function fileTouchedSince(
  file: string,
  sinceMs: number
): Promise<boolean> {
  try {
    return (await fs.stat(file)).mtimeMs >= sinceMs;
  } catch {
    return false;
  }
}
