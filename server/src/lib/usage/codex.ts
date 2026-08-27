import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  asNumber,
  asRecord,
  asString,
  listFilesRecursive,
  pathExists,
  readJsonLines,
  toEpochMs,
} from "../agents/import/reader-utils.js";
import {
  UsageAggregator,
  fileTouchedSince,
  unavailableReport,
} from "./helpers.js";
import type {
  ProviderUsageReport,
  UsageLimitSnapshotPoint,
  UsageLimitWindow,
} from "./types.js";

/**
 * Codex CLI usage: rollout files under ~/.codex/sessions carry `token_count`
 * event_msg records with cumulative + per-request token usage and - on
 * ChatGPT-plan accounts - point-in-time `rate_limits` snapshots (primary =
 * 5h window, secondary = weekly window). This is exactly what Codex Meter
 * reads; we fold it into the shared report shape.
 */

const BASE = { id: "codex", label: "Codex", vendor: "OpenAI" } as const;

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

type TokenUsage = {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
};

function parseTokenUsage(value: unknown): TokenUsage | null {
  const rec = asRecord(value);
  if (!rec) {
    return null;
  }
  const input = asNumber(rec.input_tokens) ?? 0;
  const cached = asNumber(rec.cached_input_tokens) ?? 0;
  const cacheWrite = asNumber(rec.cache_write_input_tokens) ?? 0;
  const output = asNumber(rec.output_tokens) ?? 0;
  const reasoning = asNumber(rec.reasoning_output_tokens) ?? 0;
  const total = asNumber(rec.total_tokens) ?? input + output;
  if (input === 0 && output === 0 && total === 0) {
    return null;
  }
  return { input, cached, cacheWrite, output, reasoning, total };
}

type RateLimitSnapshot = {
  capturedAtMs: number;
  windows: UsageLimitWindow[];
};

function windowLabel(windowMinutes: number | null, fallback: string): string {
  if (windowMinutes === null) {
    return fallback;
  }
  const hours = windowMinutes / 60;
  if (hours <= 36) {
    return `${Math.round(hours)}h window`;
  }
  const days = hours / 24;
  if (Math.round(days) === 7) {
    return "Weekly window";
  }
  return `${Math.round(days)}d window`;
}

function parseRateLimitWindow(
  value: unknown,
  id: string,
  fallbackLabel: string,
  capturedAtMs: number
): UsageLimitWindow | null {
  const rec = asRecord(value);
  if (!rec) {
    return null;
  }
  const usedPercent = asNumber(rec.used_percent);
  if (usedPercent === undefined) {
    return null;
  }
  const windowMinutes = asNumber(rec.window_minutes) ?? null;
  const resetsInSeconds = asNumber(rec.resets_in_seconds);
  // Newer Codex builds ship `resets_at` (ISO or epoch seconds) instead.
  const resetsAtRaw = rec.resets_at;
  let resetsAtMs: number | null = null;
  if (resetsInSeconds !== undefined) {
    resetsAtMs = capturedAtMs + resetsInSeconds * 1000;
  } else if (typeof resetsAtRaw === "number" && Number.isFinite(resetsAtRaw)) {
    resetsAtMs = resetsAtRaw > 10_000_000_000 ? resetsAtRaw : resetsAtRaw * 1000;
  } else if (typeof resetsAtRaw === "string") {
    resetsAtMs = toEpochMs(resetsAtRaw);
  }
  return {
    id,
    label: windowLabel(windowMinutes, fallbackLabel),
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    windowMinutes,
    resetsAt: resetsAtMs !== null ? new Date(resetsAtMs).toISOString() : null,
    capturedAt: new Date(capturedAtMs).toISOString(),
    detail: null,
  };
}

/** Best-effort ChatGPT plan from the cached auth id_token (no verification). */
async function readCodexPlan(home: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(home, "auth.json"), "utf8");
    const parsed = asRecord(JSON.parse(raw));
    const idToken = asString(asRecord(parsed?.tokens)?.id_token);
    if (!idToken) {
      return null;
    }
    const payloadPart = idToken.split(".")[1];
    if (!payloadPart) {
      return null;
    }
    const payload = asRecord(
      JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"))
    );
    const authClaim = asRecord(payload?.["https://api.openai.com/auth"]);
    const plan = asString(authClaim?.chatgpt_plan_type);
    if (!plan) {
      return null;
    }
    return plan.charAt(0).toUpperCase() + plan.slice(1);
  } catch {
    return null;
  }
}

export async function collectCodexUsage(sinceMs: number): Promise<ProviderUsageReport> {
  const home = codexHome();
  const roots = [path.join(home, "sessions"), path.join(home, "archived_sessions")];
  if (!(await pathExists(roots[0]!)) && !(await pathExists(roots[1]!))) {
    return unavailableReport(
      BASE,
      "No Codex sessions found (~/.codex/sessions does not exist).",
      roots[0]!
    );
  }

  const files: string[] = [];
  for (const root of roots) {
    files.push(
      ...(await listFilesRecursive(root)).filter(
        (file) =>
          path.basename(file).startsWith("rollout-") && file.endsWith(".jsonl")
      )
    );
  }

  const aggregator = new UsageAggregator();
  let latestSnapshot: RateLimitSnapshot | null = null;
  let planFromRollouts: string | null = null;
  const snapshotHistory: UsageLimitSnapshotPoint[] = [];

  for (const file of files) {
    if (!(await fileTouchedSince(file, sinceMs))) {
      continue;
    }
    let records: Record<string, unknown>[];
    try {
      records = (await readJsonLines(file)) as Record<string, unknown>[];
    } catch {
      continue;
    }
    let model = "unknown";
    let prevTotal: TokenUsage | null = null;
    let counted = false;
    for (const record of records) {
      const payload = asRecord(record.payload);
      if (!payload) {
        continue;
      }
      const recordType = asString(record.type);
      if (recordType === "session_meta" || recordType === "turn_context") {
        model = asString(payload.model) ?? model;
        continue;
      }
      if (recordType !== "event_msg" || payload.type !== "token_count") {
        continue;
      }
      const ts = toEpochMs(record.timestamp) ?? Date.now();

      const rateLimits = asRecord(payload.rate_limits);
      const planType = asString(rateLimits?.plan_type);
      if (planType) {
        planFromRollouts = planType.charAt(0).toUpperCase() + planType.slice(1);
      }
      if (rateLimits) {
        const windows = [
          parseRateLimitWindow(rateLimits.primary, "primary", "Primary window", ts),
          parseRateLimitWindow(rateLimits.secondary, "secondary", "Secondary window", ts),
        ].filter((window): window is UsageLimitWindow => window !== null);
        if (windows.length > 0) {
          if (!latestSnapshot || ts >= latestSnapshot.capturedAtMs) {
            latestSnapshot = { capturedAtMs: ts, windows };
          }
          if (ts >= sinceMs) {
            snapshotHistory.push({
              ts,
              windows: windows.map((window) => ({
                id: window.id,
                usedPercent: window.usedPercent ?? 0,
              })),
            });
          }
        }
      }

      const info = asRecord(payload.info);
      if (!info) {
        continue;
      }
      const total = parseTokenUsage(info.total_token_usage);
      const last = parseTokenUsage(info.last_token_usage);
      // Per-request usage: prefer the explicit last_token_usage, otherwise
      // diff cumulative totals against the previous token_count record.
      let delta: TokenUsage | null = last;
      if (!delta && total) {
        delta = prevTotal
          ? {
              input: Math.max(0, total.input - prevTotal.input),
              cached: Math.max(0, total.cached - prevTotal.cached),
              cacheWrite: Math.max(0, total.cacheWrite - prevTotal.cacheWrite),
              output: Math.max(0, total.output - prevTotal.output),
              reasoning: Math.max(0, total.reasoning - prevTotal.reasoning),
              total: Math.max(0, total.total - prevTotal.total),
            }
          : total;
      }
      if (total) {
        prevTotal = total;
      }
      if (!delta || (delta.input === 0 && delta.output === 0 && delta.total === 0)) {
        continue;
      }
      if (ts < sinceMs) {
        continue;
      }
      counted = true;
      aggregator.add(ts, model, {
        // Codex's input_tokens includes the cached portion; split it out so
        // the columns never double count.
        inputTokens: Math.max(0, delta.input - delta.cached),
        cacheReadTokens: delta.cached,
        cacheWriteTokens: delta.cacheWrite,
        outputTokens: delta.output,
        reasoningTokens: delta.reasoning,
        totalTokens: delta.total,
      });
    }
    if (counted) {
      aggregator.addSession(file);
    }
  }

  // Snapshot history feeds the consumption-over-time charts; keep it ordered
  // and bounded so a giant archive cannot bloat the payload.
  snapshotHistory.sort((a, b) => a.ts - b.ts);
  const MAX_SNAPSHOTS = 1000;
  const thinned =
    snapshotHistory.length > MAX_SNAPSHOTS
      ? snapshotHistory.filter(
          (_, index) =>
            index % Math.ceil(snapshotHistory.length / MAX_SNAPSHOTS) === 0 ||
            index === snapshotHistory.length - 1
        )
      : snapshotHistory;

  const { totals, days, series, models, lastActivityAt } = aggregator.finish();
  return {
    ...BASE,
    available: true,
    reason: null,
    storageRoot: path.join(home, "sessions"),
    plan: (await readCodexPlan(home)) ?? planFromRollouts,
    limitWindows: latestSnapshot?.windows ?? [],
    limitSnapshots: thinned,
    totals,
    days,
    series,
    models,
    estimated: false,
    lastActivityAt,
  };
}
