"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { RefreshCw } from "lucide-react";
import {
  fetchUsageOverview,
  type ProviderUsageReport,
  type UsageLimitWindow,
  type UsageOverviewResponse,
  type UsageSeriesPoint,
} from "@/lib/server-api";
import {
  PageIntro,
  SettingsNestedBreadcrumbs,
  SettingsBlock,
  SettingsCallout,
  SettingsEmptyState,
  SettingsSection,
  tagClass,
} from "@/components/editor/settings-ui";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const POLL_INTERVAL_MS = 60_000;
/** Always fetch the maximum lookback; ranges are filtered client-side. */
const FETCH_DAYS = 90;

type RangeKey = "24h" | "7d" | "30d" | "90d";
type Granularity = "hour" | "day" | "week";
type ViewMode = "rate" | "cumulative";
type MetricKey = "tokens" | "requests" | "cost";

const RANGE_MS: Record<RangeKey, number> = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "90d": 90 * DAY_MS,
};
const RANGE_GRANULARITIES: Record<RangeKey, Granularity[]> = {
  "24h": ["hour"],
  "7d": ["hour", "day"],
  "30d": ["hour", "day"],
  "90d": ["day", "week"],
};
const DEFAULT_GRANULARITY: Record<RangeKey, Granularity> = {
  "24h": "hour",
  "7d": "hour",
  "30d": "day",
  "90d": "day",
};

const PROVIDER_SHORT_LABELS: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  gemini: "Antigravity",
  opencode: "OpenCode",
  pi: "Pi",
  "cesium-agent": "Cesium",
};

/* ------------------------------ formatting ------------------------------ */

function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}K`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function formatCost(value: number): string {
  if (value >= 100) return `$${Math.round(value)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(3)}`;
}

function formatMetric(value: number, metric: MetricKey): string {
  if (metric === "cost") return formatCost(value);
  if (metric === "requests") return Math.round(value).toLocaleString();
  return formatTokens(value);
}

function formatPercent(value: number): string {
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)}%`;
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDateShort(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatRelativeTime(iso: string, nowMs: number): string {
  const deltaMs = nowMs - Date.parse(iso);
  if (!Number.isFinite(deltaMs)) return "—";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatCountdown(targetMs: number, nowMs: number): string {
  const deltaMs = targetMs - nowMs;
  if (deltaMs <= 0) return "now";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.round(hours / 24)}d`;
}

function meterColor(usedPercent: number): string {
  if (usedPercent >= 85) return "#dc2626";
  if (usedPercent >= 60) return "#d97706";
  return "#16a34a";
}

/* --------------------------- series utilities --------------------------- */

type ChartDatum = { ts: number; value: number };

function metricValue(point: UsageSeriesPoint, metric: MetricKey): number {
  if (metric === "requests") return point.requests;
  if (metric === "cost") return point.costUsd ?? 0;
  return point.totalTokens;
}

/** Bucket start timestamps (ascending) covering the range at a granularity. */
function bucketStarts(nowMs: number, range: RangeKey, granularity: Granularity): number[] {
  const out: number[] = [];
  if (granularity === "hour") {
    const end = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    const count = Math.round(RANGE_MS[range] / HOUR_MS);
    for (let i = count - 1; i >= 0; i -= 1) {
      out.push(end - i * HOUR_MS);
    }
    return out;
  }
  const stepDays = granularity === "week" ? 7 : 1;
  const totalDays = Math.round(RANGE_MS[range] / DAY_MS);
  const count = Math.ceil(totalDays / stepDays);
  const cursor = new Date(nowMs);
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - (count - 1) * stepDays);
  for (let i = 0; i < count; i += 1) {
    out.push(cursor.getTime());
    cursor.setDate(cursor.getDate() + stepDays);
  }
  return out;
}

/** Fold sparse 30-min series points into dense chart buckets. */
function aggregateSeries(
  points: UsageSeriesPoint[],
  starts: number[],
  metric: MetricKey
): ChartDatum[] {
  const data: ChartDatum[] = starts.map((ts) => ({ ts, value: 0 }));
  if (starts.length === 0) return data;
  let bucketIndex = 0;
  for (const point of points) {
    if (point.ts < starts[0]!) continue;
    while (bucketIndex < starts.length - 1 && point.ts >= starts[bucketIndex + 1]!) {
      bucketIndex += 1;
    }
    // Points are sorted; a point older than the current bucket means we
    // advanced past it while scanning an earlier point — rewind linearly.
    while (bucketIndex > 0 && point.ts < starts[bucketIndex]!) {
      bucketIndex -= 1;
    }
    data[bucketIndex]!.value += metricValue(point, metric);
  }
  return data;
}

function toCumulative(data: ChartDatum[]): ChartDatum[] {
  let running = 0;
  return data.map((d) => {
    running += d.value;
    return { ts: d.ts, value: running };
  });
}

function sumSince(points: UsageSeriesPoint[], sinceMs: number, metric: MetricKey): number {
  let total = 0;
  for (const point of points) {
    if (point.ts >= sinceMs) total += metricValue(point, metric);
  }
  return total;
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * power >= value) return m * power;
  }
  return 10 * power;
}

/** Linear projection from the recent slope of observed values. */
function linearProjection(
  points: ChartDatum[],
  nowMs: number,
  targetTs: number,
  tailMs: number
): { slopePerHour: number; projected: number; hitAt: (limit: number) => number | null } | null {
  const tail = points.filter((p) => p.ts >= nowMs - tailMs);
  const usable = tail.length >= 2 ? tail : points.slice(-2);
  if (usable.length < 2) return null;
  const first = usable[0]!;
  const last = usable[usable.length - 1]!;
  const dt = last.ts - first.ts;
  if (dt < 5 * 60_000) return null;
  const slope = (last.value - first.value) / dt;
  return {
    slopePerHour: slope * HOUR_MS,
    projected: last.value + slope * Math.max(0, targetTs - last.ts),
    hitAt: (limit: number) =>
      slope > 0 && last.value < limit ? last.ts + (limit - last.value) / slope : null,
  };
}

/* ------------------------------- UI atoms ------------------------------- */

const chipBase =
  "rounded-[6px] border px-[10px] py-[5px] font-sans text-[12px] leading-none transition-colors";
const chipIdle =
  "border-[var(--border-card)] bg-[var(--bg-panel)] text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]";
const chipSelected =
  "border-[var(--text-primary)] bg-[var(--text-primary)] font-medium text-[var(--bg-main)]";

function ChipGroup<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex flex-wrap gap-[5px]">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={`${chipBase} ${selected ? chipSelected : chipIdle} ${
              option.disabled ? "cursor-not-allowed opacity-40" : ""
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      setWidth((prev) => (Math.abs(prev - next) > 0.5 ? next : prev));
    });
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/* --------------------------------- chart -------------------------------- */

type TimeSeriesChartProps = {
  data: ChartDatum[];
  kind: "bars" | "area";
  height?: number;
  /** Fixed y max (e.g. 100 for percent charts); otherwise derived. */
  yMax?: number;
  /** Series color; defaults to the accent token. */
  color?: string;
  formatValue: (value: number) => string;
  formatTime: (ts: number) => string;
  /** Extra tooltip lines below the headline value. */
  tooltipExtra?: (ts: number) => ReactNode;
  /** Dashed projection segment from the last datum. */
  projection?: { toTs: number; toValue: number } | null;
  emptyLabel?: string;
  ariaLabel: string;
};

const CHART_MARGIN = { top: 10, right: 10, bottom: 20, left: 42 };

function TimeSeriesChart({
  data,
  kind,
  height = 168,
  yMax,
  color = "var(--accent)",
  formatValue,
  formatTime,
  tooltipExtra,
  projection,
  emptyLabel = "No activity in this window.",
  ariaLabel,
}: TimeSeriesChartProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const plotW = Math.max(0, width - CHART_MARGIN.left - CHART_MARGIN.right);
  const plotH = height - CHART_MARGIN.top - CHART_MARGIN.bottom;

  const dataMax = Math.max(0, ...data.map((d) => d.value), projection?.toValue ?? 0);
  const yTop = yMax ?? niceMax(dataMax);
  const isEmpty = dataMax <= 0;

  const domainStart = data[0]?.ts ?? 0;
  const domainEnd = Math.max(data[data.length - 1]?.ts ?? 1, projection?.toTs ?? 0);
  const domainSpan = Math.max(1, domainEnd - domainStart);

  const xForTs = useCallback(
    (ts: number) => CHART_MARGIN.left + ((ts - domainStart) / domainSpan) * plotW,
    [domainStart, domainSpan, plotW]
  );
  const yForValue = useCallback(
    (value: number) =>
      CHART_MARGIN.top + plotH - (Math.min(value, yTop) / yTop) * plotH,
    [plotH, yTop]
  );

  const handleMove = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (data.length === 0 || plotW <= 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      if (kind === "bars") {
        const idx = Math.floor(((mx - CHART_MARGIN.left) / plotW) * data.length);
        setHoverIndex(idx >= 0 && idx < data.length ? idx : null);
        return;
      }
      const targetTs = domainStart + ((mx - CHART_MARGIN.left) / plotW) * domainSpan;
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < data.length; i += 1) {
        const dist = Math.abs(data[i]!.ts - targetTs);
        if (dist < bestDist) {
          best = i;
          bestDist = dist;
        }
      }
      setHoverIndex(best);
    },
    [data, domainSpan, domainStart, kind, plotW]
  );

  const hovered = hoverIndex !== null ? data[hoverIndex] : undefined;

  // ~4 x-axis labels, always including first and last buckets.
  const tickIndexes = useMemo(() => {
    if (data.length <= 1) return data.length === 1 ? [0] : [];
    const count = Math.min(4, data.length);
    const out: number[] = [];
    for (let i = 0; i < count; i += 1) {
      out.push(Math.round((i * (data.length - 1)) / (count - 1)));
    }
    return [...new Set(out)];
  }, [data.length]);

  const yTicks = [0, yTop / 2, yTop];
  const barSlot = data.length > 0 ? plotW / data.length : 0;
  const barWidth = Math.max(1.5, barSlot * 0.68);

  const areaPath = useMemo(() => {
    if (kind !== "area" || data.length === 0) return { line: "", area: "" };
    const pieces = data.map(
      (d, i) => `${i === 0 ? "M" : "L"}${xForTs(d.ts).toFixed(1)},${yForValue(d.value).toFixed(1)}`
    );
    const line = pieces.join("");
    const baseline = CHART_MARGIN.top + plotH;
    const area = `${line}L${xForTs(data[data.length - 1]!.ts).toFixed(1)},${baseline}L${xForTs(
      data[0]!.ts
    ).toFixed(1)},${baseline}Z`;
    return { line, area };
  }, [data, kind, plotH, xForTs, yForValue]);

  const tooltipWidth = 190;
  const tooltipLeft = hovered
    ? Math.min(Math.max(xForTs(hovered.ts) - tooltipWidth / 2, 2), Math.max(2, width - tooltipWidth - 2))
    : 0;

  return (
    <div
      ref={containerRef}
      className="relative w-full select-none"
      style={{ height }}
      role="img"
      aria-label={ariaLabel}
      onMouseMove={handleMove}
      onMouseLeave={() => setHoverIndex(null)}
    >
      {width > 0 ? (
        <svg width={width} height={height} className="block">
          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={CHART_MARGIN.left}
                x2={width - CHART_MARGIN.right}
                y1={yForValue(tick)}
                y2={yForValue(tick)}
                stroke="var(--border-subtle)"
                strokeWidth={1}
              />
              <text
                x={CHART_MARGIN.left - 6}
                y={yForValue(tick) + 3}
                textAnchor="end"
                className="fill-[var(--text-disabled)] font-sans text-[9px]"
              >
                {formatValue(tick)}
              </text>
            </g>
          ))}

          {kind === "bars"
            ? data.map((d, i) => {
                const x = CHART_MARGIN.left + i * barSlot + (barSlot - barWidth) / 2;
                const y = yForValue(d.value);
                const h = CHART_MARGIN.top + plotH - y;
                return (
                  <rect
                    key={d.ts}
                    x={x}
                    y={d.value > 0 ? y : CHART_MARGIN.top + plotH - 1}
                    width={barWidth}
                    height={d.value > 0 ? Math.max(h, 2) : 1}
                    rx={1.5}
                    fill={d.value > 0 ? color : "var(--border-subtle)"}
                    opacity={hoverIndex === null || hoverIndex === i ? 0.92 : 0.45}
                  />
                );
              })
            : null}

          {kind === "area" && areaPath.line ? (
            <>
              <path d={areaPath.area} fill={color} opacity={0.1} />
              <path
                d={areaPath.line}
                fill="none"
                stroke={color}
                strokeWidth={1.6}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </>
          ) : null}

          {projection && data.length > 0 ? (
            <>
              <line
                x1={xForTs(data[data.length - 1]!.ts)}
                y1={yForValue(data[data.length - 1]!.value)}
                x2={xForTs(projection.toTs)}
                y2={yForValue(projection.toValue)}
                stroke="var(--text-disabled)"
                strokeWidth={1.4}
                strokeDasharray="3 4"
              />
              <circle
                cx={xForTs(projection.toTs)}
                cy={yForValue(projection.toValue)}
                r={3}
                fill="var(--bg-panel)"
                stroke="var(--text-disabled)"
                strokeWidth={1.4}
              />
            </>
          ) : null}

          {hovered && hoverIndex !== null ? (
            (() => {
              const hoverX =
                kind === "bars"
                  ? CHART_MARGIN.left + hoverIndex * barSlot + barSlot / 2
                  : xForTs(hovered.ts);
              return (
                <>
                  <line
                    x1={hoverX}
                    x2={hoverX}
                    y1={CHART_MARGIN.top}
                    y2={CHART_MARGIN.top + plotH}
                    stroke="var(--text-disabled)"
                    strokeWidth={1}
                    strokeDasharray="2 3"
                  />
                  {kind === "area" ? (
                    <circle
                      cx={hoverX}
                      cy={yForValue(hovered.value)}
                      r={3.2}
                      fill={color}
                      stroke="var(--bg-panel)"
                      strokeWidth={1.5}
                    />
                  ) : null}
                </>
              );
            })()
          ) : null}

          {tickIndexes.map((i) => (
            <text
              key={`x-${data[i]!.ts}`}
              x={kind === "bars" ? CHART_MARGIN.left + i * barSlot + barSlot / 2 : xForTs(data[i]!.ts)}
              y={height - 5}
              textAnchor={i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"}
              className="fill-[var(--text-disabled)] font-sans text-[9px]"
            >
              {formatTime(data[i]!.ts)}
            </text>
          ))}
        </svg>
      ) : null}

      {isEmpty ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="font-sans text-[11px] text-[var(--text-disabled)]">{emptyLabel}</span>
        </div>
      ) : null}

      {hovered && !isEmpty ? (
        <div
          className="pointer-events-none absolute top-[2px] z-10 rounded-[6px] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[10px] py-[7px] shadow-sm"
          style={{ left: tooltipLeft, width: tooltipWidth }}
        >
          <p className="font-sans text-[10px] text-[var(--text-disabled)]">
            {formatTime(hovered.ts)}
          </p>
          <p className="mt-[2px] font-sans text-[13px] font-semibold tabular-nums text-[var(--text-primary)]">
            {formatValue(hovered.value)}
          </p>
          {tooltipExtra ? (
            <div className="mt-[2px] font-sans text-[10px] leading-[15px] text-[var(--text-secondary)]">
              {tooltipExtra(hovered.ts)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Axis-free mini area chart for overview cards. */
function Sparkline({ points, nowMs }: { points: UsageSeriesPoint[]; nowMs: number }) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const height = 36;
  const data = useMemo(() => {
    const starts = bucketStarts(nowMs, "7d", "hour");
    return aggregateSeries(points, starts, "tokens");
  }, [nowMs, points]);
  const max = Math.max(1, ...data.map((d) => d.value));
  const path = useMemo(() => {
    if (width <= 0 || data.length < 2) return { line: "", area: "" };
    const step = width / (data.length - 1);
    const pieces = data.map(
      (d, i) =>
        `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(height - 3 - (d.value / max) * (height - 8)).toFixed(1)}`
    );
    const line = pieces.join("");
    return {
      line,
      area: `${line}L${width},${height}L0,${height}Z`,
    };
  }, [data, max, width]);
  return (
    <div ref={containerRef} className="h-[36px] w-full" aria-hidden>
      {width > 0 && path.line ? (
        <svg width={width} height={height} className="block">
          <path d={path.area} fill="var(--accent)" opacity={0.1} />
          <path d={path.line} fill="none" stroke="var(--accent)" strokeWidth={1.4} />
        </svg>
      ) : null}
    </div>
  );
}

/* ---------------------------- limit windows ---------------------------- */

function LimitWindowPanel({
  limitWindow,
  report,
  nowMs,
}: {
  limitWindow: UsageLimitWindow;
  report: ProviderUsageReport;
  nowMs: number;
}) {
  const resetsAtMs = limitWindow.resetsAt ? Date.parse(limitWindow.resetsAt) : null;
  const windowMs = limitWindow.windowMinutes !== null ? limitWindow.windowMinutes * 60_000 : null;

  // Percent-based windows chart the harness's own meter observations.
  const percentData = useMemo<ChartDatum[]>(() => {
    if (limitWindow.usedPercent === null) return [];
    const horizon = Math.min(windowMs ?? DAY_MS, 7 * DAY_MS);
    return report.limitSnapshots
      .filter((snap) => snap.ts >= nowMs - horizon)
      .map((snap) => {
        const match = snap.windows.find((w) => w.id === limitWindow.id);
        return match ? { ts: snap.ts, value: match.usedPercent } : null;
      })
      .filter((d): d is ChartDatum => d !== null);
  }, [limitWindow.id, limitWindow.usedPercent, nowMs, report.limitSnapshots, windowMs]);

  // Token windows chart cumulative consumption inside the current window.
  const tokenData = useMemo<ChartDatum[]>(() => {
    if (limitWindow.usedPercent !== null) return [];
    const startMs =
      resetsAtMs !== null && windowMs !== null
        ? resetsAtMs - windowMs
        : nowMs - (windowMs ?? 7 * DAY_MS);
    const inWindow = report.series.filter((p) => p.ts >= startMs);
    let running = 0;
    const out: ChartDatum[] = [{ ts: startMs, value: 0 }];
    for (const point of inWindow) {
      running += point.totalTokens;
      // Anchor each step at the bucket midpoint so the line reads naturally.
      out.push({ ts: point.ts + 15 * 60_000, value: running });
    }
    const lastTs = out[out.length - 1]!.ts;
    if (nowMs > lastTs) {
      out.push({ ts: nowMs, value: running });
    }
    return out;
  }, [limitWindow.usedPercent, nowMs, report.series, resetsAtMs, windowMs]);

  const isPercent = limitWindow.usedPercent !== null;
  const chartData = isPercent ? percentData : tokenData;

  const projection = useMemo(() => {
    if (chartData.length < 2) return null;
    const target = resetsAtMs ?? nowMs + 2 * HOUR_MS;
    if (target <= (chartData[chartData.length - 1]?.ts ?? 0)) return null;
    return linearProjection(chartData, nowMs, target, 2 * HOUR_MS);
  }, [chartData, nowMs, resetsAtMs]);

  const projectionSegment = useMemo(() => {
    if (!projection || projection.slopePerHour <= 0) return null;
    const toTs = resetsAtMs ?? nowMs + 2 * HOUR_MS;
    const toValue = isPercent ? Math.min(100, projection.projected) : projection.projected;
    return { toTs, toValue };
  }, [isPercent, nowMs, projection, resetsAtMs]);

  const projectionText = useMemo(() => {
    if (!projection || projection.slopePerHour <= 0) {
      return null;
    }
    if (isPercent) {
      const hitAt = projection.hitAt(100);
      if (hitAt !== null && resetsAtMs !== null && hitAt < resetsAtMs) {
        return `At the current pace this window hits 100% around ${formatClock(hitAt)} — before it resets.`;
      }
      if (resetsAtMs !== null) {
        return `On pace for ≈${formatPercent(Math.min(100, projection.projected))} by reset (${formatClock(resetsAtMs)}).`;
      }
      return `Climbing ≈${formatPercent(projection.slopePerHour)}/h at the current pace.`;
    }
    const pace = `Burning ≈${formatTokens(projection.slopePerHour)} tokens/h`;
    if (resetsAtMs !== null) {
      return `${pace} — on pace for ≈${formatTokens(projection.projected)} tokens by reset (${formatClock(resetsAtMs)}).`;
    }
    return `${pace} over the current window.`;
  }, [isPercent, projection, resetsAtMs]);

  // The chart *is* the meter: one prominent pressure-colored readout in the
  // header, one chart below — never both a bar and a graph of the same value.
  const windowTokens = !isPercent ? (chartData[chartData.length - 1]?.value ?? 0) : 0;
  const chartColor = isPercent
    ? meterColor(limitWindow.usedPercent ?? 0)
    : "var(--accent)";

  return (
    <div className="flex flex-col gap-[4px]">
      <div className="flex flex-wrap items-baseline justify-between gap-[8px]">
        <span className="font-sans text-[12px] font-medium text-[var(--text-primary)]">
          {limitWindow.label}
        </span>
        <span className="flex items-baseline gap-[8px]">
          <span
            className="font-sans text-[16px] font-semibold tabular-nums tracking-tight"
            style={{ color: isPercent ? chartColor : "var(--text-primary)" }}
          >
            {isPercent ? formatPercent(limitWindow.usedPercent!) : formatTokens(windowTokens)}
          </span>
          {resetsAtMs !== null ? (
            <span className="font-sans text-[11px] tabular-nums text-[var(--text-disabled)]">
              resets in {formatCountdown(resetsAtMs, nowMs)}
            </span>
          ) : null}
        </span>
      </div>

      {chartData.length > 1 ? (
        <TimeSeriesChart
          data={chartData}
          kind="area"
          height={120}
          yMax={isPercent ? 100 : undefined}
          color={chartColor}
          formatValue={(v) => (isPercent ? formatPercent(v) : formatTokens(v))}
          formatTime={(ts) =>
            (windowMs ?? 0) <= DAY_MS ? formatClock(ts) : `${formatDateShort(ts)} ${formatClock(ts)}`
          }
          projection={projectionSegment}
          emptyLabel="No observations yet."
          ariaLabel={`${limitWindow.label} consumption chart`}
        />
      ) : null}

      {projectionText ? (
        <p className="text-right font-sans text-[11px] text-[var(--text-disabled)]">
          {projectionText}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------- overview ------------------------------- */

function SummaryStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-[2px] rounded-[8px] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[14px] py-[12px]">
      <span className="font-sans text-[10px] font-medium uppercase tracking-wide text-[var(--text-disabled)]">
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

function hotPercent(report: ProviderUsageReport): number | null {
  const percents = report.limitWindows
    .map((w) => w.usedPercent)
    .filter((p): p is number => p !== null);
  return percents.length > 0 ? Math.max(...percents) : null;
}

function HarnessOverviewCard({
  report,
  nowMs,
  onOpen,
}: {
  report: ProviderUsageReport;
  nowMs: number;
  onOpen: () => void;
}) {
  const hot = hotPercent(report);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-w-0 flex-col gap-[8px] rounded-[8px] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[14px] py-[12px] text-left transition-colors hover:border-[var(--text-disabled)] hover:bg-[var(--accent-bg)]"
    >
      <div className="flex w-full items-center justify-between gap-[8px]">
        <span className="truncate font-sans text-[13px] font-medium text-[var(--text-primary)]">
          {report.label}
        </span>
        <span className="flex shrink-0 items-center gap-[6px]">
          {hot !== null ? (
            <span
              className="size-[7px] rounded-full"
              style={{ backgroundColor: meterColor(hot) }}
              title={`Hottest limit window: ${formatPercent(hot)} used`}
            />
          ) : null}
          <span className="font-sans text-[10px] text-[var(--text-disabled)]">{report.vendor}</span>
        </span>
      </div>
      <Sparkline points={report.series} nowMs={nowMs} />
      <div className="flex w-full flex-wrap items-baseline justify-between gap-[8px]">
        <span className="font-sans text-[12px] tabular-nums text-[var(--text-primary)]">
          {formatTokens(report.totals.totalTokens)} tok
          <span className="text-[var(--text-disabled)]"> · {report.totals.requests} req</span>
          {report.totals.costUsd !== null ? (
            <span className="text-[var(--text-disabled)]"> · {formatCost(report.totals.costUsd)}</span>
          ) : null}
        </span>
        <span className="font-sans text-[10px] tabular-nums text-[var(--text-disabled)]">
          {report.limitWindows
            .filter((w) => w.usedPercent !== null)
            .map((w) => `${w.label.split(" ")[0]} ${formatPercent(w.usedPercent!)}`)
            .join(" · ") ||
            (report.lastActivityAt ? formatRelativeTime(report.lastActivityAt, nowMs) : "")}
        </span>
      </div>
    </button>
  );
}

/* --------------------------- provider details --------------------------- */

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
              className="h-full rounded-full bg-[var(--accent)] opacity-80"
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

function ProviderDetail({
  report,
  nowMs,
}: {
  report: ProviderUsageReport;
  nowMs: number;
}) {
  const [range, setRange] = useState<RangeKey>("7d");
  const [granularity, setGranularity] = useState<Granularity>(DEFAULT_GRANULARITY["7d"]);
  const [view, setView] = useState<ViewMode>("rate");
  const [metric, setMetric] = useState<MetricKey>("tokens");

  const handleRange = useCallback((next: RangeKey) => {
    setRange(next);
    setGranularity((prev) =>
      RANGE_GRANULARITIES[next].includes(prev) ? prev : DEFAULT_GRANULARITY[next]
    );
  }, []);

  const hasCost = report.totals.costUsd !== null;
  const effectiveMetric = metric === "cost" && !hasCost ? "tokens" : metric;

  const chartData = useMemo(() => {
    const starts = bucketStarts(nowMs, range, granularity);
    const aggregated = aggregateSeries(report.series, starts, effectiveMetric);
    return view === "cumulative" ? toCumulative(aggregated) : aggregated;
  }, [effectiveMetric, granularity, nowMs, range, report.series, view]);

  const rangeTotal = useMemo(
    () => sumSince(report.series, nowMs - RANGE_MS[range], effectiveMetric),
    [effectiveMetric, nowMs, range, report.series]
  );

  const pace = useMemo(() => {
    const lastHour = sumSince(report.series, nowMs - HOUR_MS, "tokens");
    const last24h = sumSince(report.series, nowMs - DAY_MS, "tokens");
    const rangeDays = RANGE_MS[range] / DAY_MS;
    const rangeTokens = sumSince(report.series, nowMs - RANGE_MS[range], "tokens");
    return { lastHour, last24h, perDay: rangeTokens / rangeDays };
  }, [nowMs, range, report.series]);

  const formatBucketTime = useCallback(
    (ts: number) => {
      if (granularity === "hour") {
        return range === "24h" ? formatClock(ts) : `${formatDateShort(ts)} ${formatClock(ts)}`;
      }
      if (granularity === "week") return `wk of ${formatDateShort(ts)}`;
      return formatDateShort(ts);
    },
    [granularity, range]
  );

  return (
    <>
      <p
        className="mb-[14px] font-sans text-[11px] text-[var(--text-disabled)]"
        title={report.storageRoot ?? undefined}
      >
        {[
          report.vendor,
          report.plan ? `${report.plan} plan` : null,
          `${report.totals.sessions} sessions`,
          report.lastActivityAt
            ? `active ${formatRelativeTime(report.lastActivityAt, nowMs)}`
            : null,
          report.estimated ? "estimated counts (chars/4)" : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>

      {report.limitWindows.length > 0 ? (
        <SettingsSection title="Limits">
          {report.limitWindows.map((limitWindow, index) => (
            <SettingsBlock
              key={limitWindow.id}
              searchId={index === 0 ? `usage-limits-${report.id}` : undefined}
            >
              <LimitWindowPanel limitWindow={limitWindow} report={report} nowMs={nowMs} />
            </SettingsBlock>
          ))}
        </SettingsSection>
      ) : null}

      <SettingsSection title="Activity">
        <SettingsBlock searchId={`usage-activity-${report.id}`}>
          <div className="mb-[12px] flex flex-wrap items-center justify-between gap-[10px]">
            <ChipGroup
              value={range}
              onChange={handleRange}
              ariaLabel="Chart range"
              options={[
                { value: "24h", label: "24h" },
                { value: "7d", label: "7d" },
                { value: "30d", label: "30d" },
                { value: "90d", label: "90d" },
              ]}
            />
            <div className="flex flex-wrap items-center gap-[10px]">
              <ChipGroup
                value={granularity}
                onChange={setGranularity}
                ariaLabel="Chart granularity"
                options={(["hour", "day", "week"] as Granularity[]).map((g) => ({
                  value: g,
                  label: g === "hour" ? "Hourly" : g === "day" ? "Daily" : "Weekly",
                  disabled: !RANGE_GRANULARITIES[range].includes(g),
                }))}
              />
              <ChipGroup
                value={view}
                onChange={setView}
                ariaLabel="Chart mode"
                options={[
                  { value: "rate", label: "Rate" },
                  { value: "cumulative", label: "Cumulative" },
                ]}
              />
              <ChipGroup
                value={effectiveMetric}
                onChange={setMetric}
                ariaLabel="Chart metric"
                options={[
                  { value: "tokens", label: "Tokens" },
                  { value: "requests", label: "Requests" },
                  ...(hasCost ? [{ value: "cost" as MetricKey, label: "Cost" }] : []),
                ]}
              />
            </div>
          </div>

          <TimeSeriesChart
            data={chartData}
            kind={granularity === "hour" ? "area" : "bars"}
            height={180}
            formatValue={(v) => formatMetric(v, effectiveMetric)}
            formatTime={formatBucketTime}
            tooltipExtra={(ts) => {
              const bucket = report.series.filter(
                (p) =>
                  p.ts >= ts &&
                  p.ts <
                    ts +
                      (granularity === "hour"
                        ? HOUR_MS
                        : granularity === "day"
                          ? DAY_MS
                          : 7 * DAY_MS)
              );
              const requests = bucket.reduce((acc, p) => acc + p.requests, 0);
              const input = bucket.reduce((acc, p) => acc + p.inputTokens, 0);
              const output = bucket.reduce((acc, p) => acc + p.outputTokens, 0);
              return (
                <>
                  {requests} requests · in {formatTokens(input)} · out {formatTokens(output)}
                </>
              );
            }}
            ariaLabel={`${report.label} ${view} ${effectiveMetric} chart`}
          />

          <div className="mt-[10px] flex flex-wrap items-baseline justify-between gap-[8px]">
            <span className="font-sans text-[12px] tabular-nums text-[var(--text-secondary)]">
              {formatMetric(rangeTotal, effectiveMetric)}{" "}
              {effectiveMetric === "tokens"
                ? "tokens"
                : effectiveMetric === "requests"
                  ? "requests"
                  : "spent"}{" "}
              · {range}
            </span>
            <span className="font-sans text-[11px] tabular-nums text-[var(--text-disabled)]">
              {formatTokens(pace.lastHour)} tok/h now · {formatTokens(pace.last24h)} / 24h · ≈
              {formatTokens(pace.perDay)} / day
            </span>
          </div>
        </SettingsBlock>
      </SettingsSection>

      {report.models.length > 0 ? (
        <SettingsSection title="By model">
          <SettingsBlock searchId={`usage-models-${report.id}`}>
            <ModelBreakdownRows report={report} />
          </SettingsBlock>
        </SettingsSection>
      ) : null}
    </>
  );
}

/* --------------------------------- panel -------------------------------- */

export function UsageSettingsPanel() {
  const [overview, setOverview] = useState<UsageOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState<string>("overview");
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async (background: boolean) => {
    if (!background) setLoading(true);
    try {
      const payload = await fetchUsageOverview({ days: FETCH_DAYS, refresh: true });
      setOverview(payload);
      setError(null);
      setNowMs(Date.now());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    const poll = setInterval(() => void load(true), POLL_INTERVAL_MS);
    // Keep countdowns and "x ago" labels honest between polls.
    const tick = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

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
  const selectedReport = useMemo(
    () => active.find((provider) => provider.id === selectedTab) ?? null,
    [active, selectedTab]
  );

  const summary = useMemo(() => {
    let tokens = 0;
    let requests = 0;
    let cost: number | null = null;
    let tracked = 0;
    const since = nowMs - 30 * DAY_MS;
    for (const provider of active) {
      const t = sumSince(provider.series, since, "tokens");
      tokens += t;
      requests += sumSince(provider.series, since, "requests");
      if (provider.totals.costUsd !== null) {
        cost = (cost ?? 0) + sumSince(provider.series, since, "cost");
      }
      if (t > 0) tracked += 1;
    }
    return { tokens, requests, cost, tracked };
  }, [active, nowMs]);

  return (
    <>
      <SettingsNestedBreadcrumbs parentNav="agents" parentLabel="Agents" label="Usage" />
      <PageIntro title="Usage" />
      <div
        className="mb-[18px] flex flex-wrap items-center justify-between gap-x-[12px] gap-y-[8px]"
        data-settings-search-id="usage-tabs"
      >
        {active.length > 0 ? (
          <div role="tablist" aria-label="Harness" className="flex flex-wrap gap-[6px]">
            {[{ id: "overview", label: "Overview", hot: null as number | null }]
              .concat(
                active.map((provider) => ({
                  id: provider.id,
                  label: PROVIDER_SHORT_LABELS[provider.id] ?? provider.label,
                  hot: hotPercent(provider),
                }))
              )
              .map((tab) => {
                const selected = selectedTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setSelectedTab(tab.id)}
                    className={`${chipBase} inline-flex items-center gap-[7px] px-[13px] py-[7px] text-[12.5px] ${
                      selected ? chipSelected : chipIdle
                    }`}
                  >
                    {tab.label}
                    {tab.hot !== null ? (
                      <span
                        className="size-[6px] rounded-full"
                        style={{
                          backgroundColor: selected ? "var(--bg-main)" : meterColor(tab.hot),
                          opacity: selected ? 0.85 : 1,
                        }}
                        title={`Hottest limit window: ${formatPercent(tab.hot)} used`}
                        aria-hidden
                      />
                    ) : null}
                  </button>
                );
              })}
          </div>
        ) : (
          <span />
        )}
        <div
          className="flex shrink-0 items-center gap-[8px]"
          data-settings-search-id="usage-controls"
        >
          {overview ? (
            <span className="font-sans text-[11px] text-[var(--text-disabled)]">
              updated {formatRelativeTime(overview.generatedAt, nowMs)}
            </span>
          ) : null}
          <button
            type="button"
            className={`${chipBase} ${chipIdle} inline-flex items-center px-[7px] py-[6px]`}
            onClick={() => void load(false)}
            disabled={loading}
            title="Refresh now (auto-refreshes every 60s)"
            aria-label="Refresh usage data"
          >
            <RefreshCw
              className={`size-[13px] ${loading ? "animate-spin" : ""}`}
              strokeWidth={1.5}
              aria-hidden
            />
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

      {overview && selectedTab !== "overview" && selectedReport ? (
        <ProviderDetail report={selectedReport} nowMs={nowMs} />
      ) : null}

      {overview && (selectedTab === "overview" || !selectedReport) ? (
        <>
          <div
            className="mb-[18px] grid grid-cols-2 gap-[10px] lg:grid-cols-4"
            data-settings-search-id="usage-summary"
          >
            <SummaryStat label="Tokens" value={formatTokens(summary.tokens)} hint="30d" />
            <SummaryStat label="Requests" value={summary.requests.toLocaleString()} hint="30d" />
            <SummaryStat
              label="Known spend"
              value={summary.cost !== null ? formatCost(summary.cost) : "—"}
              hint="30d"
            />
            <SummaryStat
              label="Harnesses"
              value={`${summary.tracked}/${active.length}`}
              hint="active / detected"
            />
          </div>

          {active.length === 0 ? (
            <SettingsSection>
              <SettingsEmptyState>
                No local harness usage data found. Install and use Codex, Claude Code, Gemini CLI /
                Antigravity, OpenCode, or Pi and their sessions will show up here.
              </SettingsEmptyState>
            </SettingsSection>
          ) : (
            <div className="mb-[20px] grid grid-cols-1 gap-[10px] sm:grid-cols-2">
              {active.map((provider) => (
                <HarnessOverviewCard
                  key={provider.id}
                  report={provider}
                  nowMs={nowMs}
                  onOpen={() => setSelectedTab(provider.id)}
                />
              ))}
            </div>
          )}

          {inactive.length > 0 ? (
            <SettingsSection title="No usage data">
              {inactive.map((provider, index) => (
                <div
                  key={provider.id}
                  className={`flex items-start justify-between gap-[16px] px-[16px] py-[12px] ${
                    index < inactive.length - 1 ? "border-b border-[var(--border-subtle)]" : ""
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
        </>
      ) : null}

    </>
  );
}
