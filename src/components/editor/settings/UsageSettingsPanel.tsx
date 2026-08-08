"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Gauge, RefreshCw } from "lucide-react";
import {
  fetchUsageOverview,
  type ProviderUsageReport,
  type UsageDailyBucket,
  type UsageLimitWindow,
  type UsageOverviewResponse,
} from "@/lib/server-api";
import {
  PageIntro,
  SettingsBlock,
  SettingsCallout,
  SettingsEmptyState,
  SettingsSection,
  SettingsSubsectionHeading,
  rowButtonClass,
  tagClass,
} from "@/components/editor/settings-ui";
import { selectClass } from "./shared";

const LOOKBACK_OPTIONS = [7, 30, 90] as const;

/* ----------------------------- formatting ----------------------------- */

function formatTokens(value: number): string {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 10_000) {
    return `${Math.round(value / 1_000)}K`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return String(value);
}

function formatCost(value: number): string {
  return value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`;
}

function formatRelativeTime(iso: string): string {
  const deltaMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(deltaMs)) {
    return "—";
  }
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatResetCountdown(iso: string): string {
  const deltaMs = Date.parse(iso) - Date.now();
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    return "resetting now";
  }
  const totalMinutes = Math.round(deltaMs / 60_000);
  if (totalMinutes < 60) {
    return `resets in ${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 48) {
    const minutes = totalMinutes % 60;
    return `resets in ${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  }
  return `resets in ${Math.round(hours / 24)}d`;
}

function formatDayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Meter color by pressure: calm → warning → critical. */
function meterColor(usedPercent: number): string {
  if (usedPercent >= 85) return "#dc2626";
  if (usedPercent >= 60) return "#d97706";
  return "#16a34a";
}

/* ------------------------------- charts ------------------------------- */

/** Continuous local-day series over the lookback so gaps render as gaps. */
function buildDaySeries(
  days: UsageDailyBucket[],
  lookbackDays: number
): UsageDailyBucket[] {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const out: UsageDailyBucket[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - (lookbackDays - 1));
  for (let i = 0; i < lookbackDays; i += 1) {
    const month = String(cursor.getMonth() + 1).padStart(2, "0");
    const dayOfMonth = String(cursor.getDate()).padStart(2, "0");
    const key = `${cursor.getFullYear()}-${month}-${dayOfMonth}`;
    out.push(
      byDate.get(key) ?? {
        date: key,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        costUsd: null,
        requests: 0,
      }
    );
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function DailyActivityChart({
  days,
  lookbackDays,
}: {
  days: UsageDailyBucket[];
  lookbackDays: number;
}) {
  const series = useMemo(() => buildDaySeries(days, lookbackDays), [days, lookbackDays]);
  const max = Math.max(1, ...series.map((day) => day.totalTokens));
  return (
    <div>
      <div className="flex h-[72px] items-end gap-[2px]" role="img" aria-label="Daily token usage">
        {series.map((day) => {
          const heightPercent = (day.totalTokens / max) * 100;
          return (
            <div
              key={day.date}
              className="group relative flex-1"
              title={`${formatDayLabel(day.date)} — ${day.totalTokens.toLocaleString()} tokens · ${day.requests} requests${day.costUsd !== null ? ` · ${formatCost(day.costUsd)}` : ""}`}
            >
              <div
                className="w-full rounded-t-[2px] transition-colors"
                style={{
                  height: day.totalTokens > 0 ? `max(${heightPercent.toFixed(2)}%, 3px)` : "1px",
                  backgroundColor:
                    day.totalTokens > 0 ? "var(--accent-strong)" : "var(--border-subtle)",
                  opacity: day.totalTokens > 0 ? 0.9 : 1,
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-[6px] flex justify-between font-sans text-[10px] text-[var(--text-disabled)]">
        <span>{formatDayLabel(series[0]!.date)}</span>
        <span>{formatDayLabel(series[series.length - 1]!.date)}</span>
      </div>
    </div>
  );
}

function LimitWindowMeter({ window }: { window: UsageLimitWindow }) {
  return (
    <div className="flex flex-col gap-[6px]">
      <div className="flex flex-wrap items-baseline justify-between gap-[8px]">
        <span className="font-sans text-[12px] font-medium text-[var(--text-primary)]">
          {window.label}
        </span>
        <span className="font-sans text-[11px] tabular-nums text-[var(--text-secondary)]">
          {window.usedPercent !== null ? `${window.usedPercent.toFixed(1)}% used` : null}
          {window.usedPercent !== null && window.resetsAt ? " · " : null}
          {window.resetsAt ? formatResetCountdown(window.resetsAt) : null}
        </span>
      </div>
      {window.usedPercent !== null ? (
        <div className="h-[6px] w-full overflow-hidden rounded-full bg-[var(--border-subtle)]">
          <div
            className="h-full rounded-full transition-[width]"
            style={{
              width: `${Math.max(1, Math.min(100, window.usedPercent))}%`,
              backgroundColor: meterColor(window.usedPercent),
            }}
          />
        </div>
      ) : null}
      {window.detail ? (
        <p className="font-sans text-[11px] text-[var(--text-secondary)]">{window.detail}</p>
      ) : null}
    </div>
  );
}

function ModelBreakdownRows({ report }: { report: ProviderUsageReport }) {
  const top = report.models.slice(0, 6);
  const max = Math.max(1, ...top.map((model) => model.totalTokens));
  return (
    <div className="flex flex-col gap-[8px]">
      {top.map((model) => (
        <div key={model.model} className="flex items-center gap-[10px]">
          <span
            className="w-[38%] min-w-0 truncate font-mono text-[11px] text-[var(--text-primary)]"
            title={model.model}
          >
            {model.model}
          </span>
          <div className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--border-subtle)]">
            <div
              className="h-full rounded-full bg-[var(--accent-strong)] opacity-80"
              style={{ width: `${Math.max(2, (model.totalTokens / max) * 100)}%` }}
            />
          </div>
          <span className="w-[64px] shrink-0 text-right font-sans text-[11px] tabular-nums text-[var(--text-secondary)]">
            {formatTokens(model.totalTokens)}
          </span>
          <span className="hidden w-[76px] shrink-0 text-right font-sans text-[11px] tabular-nums text-[var(--text-disabled)] sm:block">
            {model.costUsd !== null ? formatCost(model.costUsd) : `${model.requests} req`}
          </span>
        </div>
      ))}
    </div>
  );
}

function TokenSplitLegend({ report }: { report: ProviderUsageReport }) {
  const { totals } = report;
  const parts: Array<{ label: string; value: number }> = [
    { label: "Input", value: totals.inputTokens },
    { label: "Output", value: totals.outputTokens },
    { label: "Cache read", value: totals.cacheReadTokens },
    { label: "Cache write", value: totals.cacheWriteTokens },
    { label: "Reasoning", value: totals.reasoningTokens },
  ].filter((part) => part.value > 0);
  if (parts.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-x-[16px] gap-y-[4px]">
      {parts.map((part) => (
        <span key={part.label} className="font-sans text-[11px] text-[var(--text-secondary)]">
          {part.label}{" "}
          <span className="font-medium tabular-nums text-[var(--text-primary)]">
            {formatTokens(part.value)}
          </span>
        </span>
      ))}
    </div>
  );
}

/* ------------------------------ sections ------------------------------ */

function SummaryStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-[2px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[14px] py-[12px]">
      <span className="font-sans text-[11px] font-medium uppercase tracking-wide text-[var(--text-disabled)]">
        {label}
      </span>
      <span className="font-sans text-[20px] font-semibold tabular-nums tracking-tight text-[var(--text-primary)]">
        {value}
      </span>
      {hint ? (
        <span className="font-sans text-[11px] text-[var(--text-secondary)]">{hint}</span>
      ) : null}
    </div>
  );
}

function ProviderUsageCard({
  report,
  lookbackDays,
}: {
  report: ProviderUsageReport;
  lookbackDays: number;
}) {
  const hasActivity = report.totals.totalTokens > 0 || report.totals.requests > 0;
  return (
    <SettingsSection
      title={report.label}
      action={
        <div className="flex flex-wrap items-center gap-[6px]">
          {report.plan ? <span className={tagClass}>{report.plan} plan</span> : null}
          {report.estimated ? (
            <span className={tagClass} title="Token counts are estimated (chars/4), not provider-reported.">
              estimated
            </span>
          ) : null}
          <span className={tagClass}>{report.vendor}</span>
        </div>
      }
    >
      {report.limitWindows.length > 0 ? (
        <SettingsBlock searchId={`usage-limits-${report.id}`}>
          <SettingsSubsectionHeading>Subscription limits</SettingsSubsectionHeading>
          <div className="flex flex-col gap-[14px]">
            {report.limitWindows.map((window) => (
              <LimitWindowMeter key={window.id} window={window} />
            ))}
          </div>
        </SettingsBlock>
      ) : null}
      <SettingsBlock searchId={`usage-activity-${report.id}`}>
        <div className="mb-[10px] flex flex-wrap items-baseline justify-between gap-[8px]">
          <SettingsSubsectionHeading>
            Daily activity · last {lookbackDays} days
          </SettingsSubsectionHeading>
          <span className="font-sans text-[12px] tabular-nums text-[var(--text-secondary)]">
            {formatTokens(report.totals.totalTokens)} tokens · {report.totals.requests}{" "}
            requests
            {report.totals.costUsd !== null ? ` · ${formatCost(report.totals.costUsd)}` : ""}
          </span>
        </div>
        {hasActivity ? (
          <>
            <DailyActivityChart days={report.days} lookbackDays={lookbackDays} />
            <div className="mt-[10px]">
              <TokenSplitLegend report={report} />
            </div>
          </>
        ) : (
          <p className="font-sans text-[12px] text-[var(--text-disabled)]">
            No activity recorded in this window.
          </p>
        )}
      </SettingsBlock>
      {report.models.length > 0 ? (
        <SettingsBlock searchId={`usage-models-${report.id}`}>
          <SettingsSubsectionHeading>By model</SettingsSubsectionHeading>
          <ModelBreakdownRows report={report} />
        </SettingsBlock>
      ) : null}
      <SettingsBlock className="py-[10px]">
        <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[4px] font-sans text-[11px] text-[var(--text-disabled)]">
          <span>{report.totals.sessions} sessions</span>
          {report.lastActivityAt ? (
            <span>last activity {formatRelativeTime(report.lastActivityAt)}</span>
          ) : null}
          {report.storageRoot ? (
            <span className="min-w-0 truncate font-mono" title={report.storageRoot}>
              {report.storageRoot}
            </span>
          ) : null}
        </div>
      </SettingsBlock>
    </SettingsSection>
  );
}

/* -------------------------------- panel -------------------------------- */

export function UsageSettingsPanel() {
  const [days, setDays] = useState<number>(30);
  const [overview, setOverview] = useState<UsageOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (lookbackDays: number, refresh: boolean) => {
    setLoading(true);
    try {
      const payload = await fetchUsageOverview({ days: lookbackDays, refresh });
      setOverview(payload);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(days, false);
  }, [days, load]);

  const active = useMemo(
    () =>
      (overview?.providers ?? [])
        .filter((provider) => provider.available)
        .sort(
          (a, b) =>
            b.totals.totalTokens - a.totals.totalTokens ||
            b.totals.requests - a.totals.requests ||
            a.label.localeCompare(b.label)
        ),
    [overview]
  );
  const inactive = useMemo(
    () => (overview?.providers ?? []).filter((provider) => !provider.available),
    [overview]
  );

  const summary = useMemo(() => {
    let tokens = 0;
    let requests = 0;
    let cost: number | null = null;
    let tracked = 0;
    for (const provider of active) {
      tokens += provider.totals.totalTokens;
      requests += provider.totals.requests;
      if (provider.totals.costUsd !== null) {
        cost = (cost ?? 0) + provider.totals.costUsd;
      }
      if (provider.totals.totalTokens > 0 || provider.totals.requests > 0) {
        tracked += 1;
      }
    }
    return { tokens, requests, cost, tracked };
  }, [active]);

  return (
    <>
      <PageIntro title="Usage" />
      <div
        className="mb-[16px] flex flex-wrap items-center justify-between gap-[10px]"
        data-settings-search-id="usage-controls"
      >
        <p className="min-w-0 flex-1 font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
          Subscription meters and token analytics across every coding-agent harness on
          this machine, read locally from each CLI&apos;s own session data. Nothing
          leaves your device.
        </p>
        <div className="flex shrink-0 items-center gap-[8px]">
          <select
            className={selectClass}
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
            aria-label="Usage lookback window"
          >
            {LOOKBACK_OPTIONS.map((option) => (
              <option key={option} value={option}>
                Last {option} days
              </option>
            ))}
          </select>
          <button
            type="button"
            className={rowButtonClass}
            onClick={() => void load(days, true)}
            disabled={loading}
          >
            <RefreshCw
              className={`size-[14px] ${loading ? "animate-spin" : ""}`}
              strokeWidth={1.5}
              aria-hidden
            />
            Refresh
          </button>
        </div>
      </div>

      {error ? (
        <SettingsSection bordered={false}>
          <SettingsCallout tone="danger">Usage unavailable: {error}</SettingsCallout>
        </SettingsSection>
      ) : null}

      {!overview && loading ? (
        <SettingsSection>
          <SettingsEmptyState>Scanning local harness data…</SettingsEmptyState>
        </SettingsSection>
      ) : null}

      {overview ? (
        <>
          <div className="mb-[20px] grid grid-cols-2 gap-[10px] lg:grid-cols-4">
            <SummaryStat
              label="Total tokens"
              value={formatTokens(summary.tokens)}
              hint={`last ${overview.lookbackDays} days`}
            />
            <SummaryStat
              label="Requests"
              value={summary.requests.toLocaleString()}
              hint="assistant turns"
            />
            <SummaryStat
              label="Known spend"
              value={summary.cost !== null ? formatCost(summary.cost) : "—"}
              hint="where harnesses record cost"
            />
            <SummaryStat
              label="Harnesses tracked"
              value={String(summary.tracked)}
              hint={`${active.length} detected on disk`}
            />
          </div>

          {active.length === 0 ? (
            <SettingsSection>
              <SettingsEmptyState>
                No local harness usage data found. Install and use Codex, Claude Code,
                Gemini CLI / Antigravity, OpenCode, or Pi and their sessions will show
                up here.
              </SettingsEmptyState>
            </SettingsSection>
          ) : (
            active.map((provider) => (
              <ProviderUsageCard
                key={provider.id}
                report={provider}
                lookbackDays={overview.lookbackDays}
              />
            ))
          )}

          {inactive.length > 0 ? (
            <SettingsSection title="No usage data">
              {inactive.map((provider, index) => (
                <div
                  key={provider.id}
                  className={`flex items-start justify-between gap-[16px] px-[16px] py-[12px] ${
                    index < inactive.length - 1
                      ? "border-b border-[var(--border-subtle)]"
                      : ""
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
                      {provider.label}
                    </p>
                    <p className="mt-[4px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
                      {provider.reason}
                    </p>
                  </div>
                  <span className={`${tagClass} shrink-0`}>{provider.vendor}</span>
                </div>
              ))}
            </SettingsSection>
          ) : null}

          <p className="mb-[20px] flex items-center gap-[6px] font-sans text-[11px] text-[var(--text-disabled)]">
            <Gauge className="size-[12px]" strokeWidth={1.5} aria-hidden />
            Generated {formatRelativeTime(overview.generatedAt)} · cached for 60s ·
            counts marked “estimated” use a chars/4 heuristic.
          </p>
        </>
      ) : null}
    </>
  );
}
