"use client";

import { useEffect, useMemo, useState } from "react";
import { Layers, X } from "lucide-react";
import {
  formatContextTokenCount,
  formatContextUsagePair,
} from "@/lib/composer-status-bar";
import {
  condenseContextTimeline,
  contextTimelineCondenseThreshold,
  largestContextSegments,
  readStoredContextUsageViewMode,
  writeStoredContextUsageViewMode,
  type ContextUsageViewMode,
} from "@/lib/context-usage-timeline";
import type { AgentContextUsageSnapshot } from "@/lib/agent-types";
import { ContextUsageBar, contextColor } from "./ContextUsageBar";
import { ContextUsageRing } from "./ContextUsageRing";
import { dockedComposerCardFrame } from "./docked-card";

interface ContextBreakdownDockProps {
  usage: AgentContextUsageSnapshot | null;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
  /** Opens the Advanced context inspector tab; hidden when absent. */
  onOpenAdvanced?: () => void;
}

const MODE_LABEL: Record<ContextUsageViewMode, string> = {
  pooled: "Pooled",
  sequential: "Sequential",
};

function ContextViewModeToggle({
  mode,
  onChange,
}: {
  mode: ContextUsageViewMode;
  onChange: (mode: ContextUsageViewMode) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Context breakdown view"
      className="flex shrink-0 items-center gap-[2px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] p-[2px]"
    >
      {(["pooled", "sequential"] as const).map((candidate) => {
        const active = candidate === mode;
        return (
          <button
            key={candidate}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(candidate)}
            className={`rounded-[calc(var(--radius-tab)-2px)] px-[7px] py-[2px] font-sans text-[10.5px] font-medium transition-colors ${
              active
                ? "bg-[var(--accent-bg)] text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {MODE_LABEL[candidate]}
          </button>
        );
      })}
    </div>
  );
}

export function useContextUsageViewMode(): [
  ContextUsageViewMode,
  (mode: ContextUsageViewMode) => void,
] {
  const [mode, setMode] = useState<ContextUsageViewMode>(() =>
    readStoredContextUsageViewMode(
      typeof window === "undefined" ? null : window.localStorage
    )
  );
  const update = (next: ContextUsageViewMode) => {
    setMode(next);
    writeStoredContextUsageViewMode(
      typeof window === "undefined" ? null : window.localStorage,
      next
    );
  };
  return [mode, update];
}

export function ContextBreakdownDock({
  usage,
  loading = false,
  error = null,
  onClose,
  onOpenAdvanced,
}: ContextBreakdownDockProps) {
  const supported = usage?.supported ?? false;
  const usedTokens = usage?.usedTokens ?? 0;
  const limitTokens = usage?.limitTokens ?? 0;
  const percent = usage?.percentFull ?? 0;
  const categories = usage?.categories ?? [];
  const timeline = usage?.timeline ?? null;
  const [mode, setMode] = useContextUsageViewMode();
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const sequentialRows = useMemo(
    () =>
      timeline
        ? condenseContextTimeline(timeline, {
            minTokens: contextTimelineCondenseThreshold(limitTokens),
          })
        : [],
    [limitTokens, timeline]
  );
  const largest = useMemo(
    () => (timeline ? largestContextSegments(timeline, 1)[0] ?? null : null),
    [timeline]
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const sequential = mode === "sequential";
  const sequentialAvailable = timeline != null && timeline.length > 0;

  return (
    <div
      className={dockedComposerCardFrame}
      data-context-breakdown-dock
      data-context-view-mode={mode}
      role="region"
      aria-label="Context usage breakdown"
    >
      <div className="flex items-start justify-between gap-[8px] pb-[8px]">
        <div className="flex min-w-0 items-start gap-[6px]">
          <ContextUsageRing
            percent={percent}
            loading={loading && !usage}
            className="mt-[1px]"
          />
          <div className="min-w-0">
            <p className="font-sans text-[13px] font-normal text-[var(--plan-accent-label-strong)]">
              Context
            </p>
            {supported && !error ? (
              <p className="mt-[4px] font-sans text-[11.5px] font-normal leading-snug text-[var(--text-secondary)]">
                <span className="text-[var(--text-primary)]">{percent}%</span> Full ·{" "}
                {formatContextUsagePair(usedTokens, limitTokens)}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-[6px]">
          {supported && !error ? (
            <ContextViewModeToggle mode={mode} onChange={setMode} />
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="flex size-[24px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
            aria-label="Close context breakdown"
          >
            <X className="size-[14px]" strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      </div>

      {loading && !usage ? (
        <p className="font-sans text-[11.5px] leading-snug text-[var(--text-secondary)]">
          Calculating context usage…
        </p>
      ) : error ? (
        <p className="font-sans text-[11.5px] leading-snug text-[var(--text-secondary)]">{error}</p>
      ) : !supported ? (
        <p className="font-sans text-[11.5px] leading-snug text-[var(--text-secondary)]">
          Context usage is not available for this agent yet.
        </p>
      ) : sequential && !sequentialAvailable ? (
        <p className="font-sans text-[11.5px] leading-snug text-[var(--text-secondary)]">
          This agent only reports pooled totals, so the sequential view is unavailable.
        </p>
      ) : sequential ? (
        <>
          {usedTokens > 0 ? (
            <ContextUsageBar
              segments={sequentialRows}
              separated
              className="mb-[8px]"
              hoveredId={hoveredId}
              onHover={setHoveredId}
              ariaLabel="Context blocks in the order the model receives them"
            />
          ) : null}
          <p className="mb-[6px] font-sans text-[10.5px] leading-snug text-[var(--text-disabled)]">
            Blocks in the order they enter the context window.
            {largest ? (
              <>
                {" "}
                Largest:{" "}
                <span className="text-[var(--text-secondary)]">
                  {largest.label} ({formatContextTokenCount(largest.tokens)})
                </span>
                .
              </>
            ) : null}
          </p>
          <ol
            className="flex max-h-[176px] list-none flex-col gap-[4px] overflow-y-auto pr-[2px]"
            aria-label="Context blocks, chronological"
            onMouseLeave={() => setHoveredId(null)}
          >
            {sequentialRows.map((row, index) => {
              const emphasized = hoveredId === row.id;
              return (
                <li
                  key={row.id}
                  data-context-sequence-row
                  onMouseEnter={() => setHoveredId(row.id)}
                  className={`flex items-center justify-between gap-[10px] rounded-[4px] px-[2px] font-sans text-[11.5px] transition-colors ${
                    emphasized ? "bg-[var(--accent-bg)]" : ""
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-[8px] text-[var(--text-primary)]">
                    <span className="w-[18px] shrink-0 text-right tabular-nums text-[10px] text-[var(--text-disabled)]">
                      {index + 1}
                    </span>
                    <span
                      className="size-[10px] shrink-0 rounded-[2px]"
                      style={{ background: contextColor(row.colorKey) }}
                      aria-hidden
                    />
                    <span className="truncate">
                      {row.label}
                      {row.detail ? (
                        <span className="text-[var(--text-secondary)]"> · {row.detail}</span>
                      ) : null}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">
                    {formatContextTokenCount(row.tokens)}
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      ) : (
        <>
          {usedTokens > 0 ? (
            <ContextUsageBar
              segments={categories}
              className="mb-[8px]"
              hoveredId={hoveredId}
              onHover={setHoveredId}
              ariaLabel="Context usage by category"
            />
          ) : null}
          <ul
            className="flex list-none flex-col gap-[6px]"
            onMouseLeave={() => setHoveredId(null)}
          >
            {categories.map((row) => (
              <li
                key={row.id}
                onMouseEnter={() => setHoveredId(row.id)}
                className={`flex items-center justify-between gap-[10px] rounded-[4px] px-[2px] font-sans text-[11.5px] transition-colors ${
                  hoveredId === row.id ? "bg-[var(--accent-bg)]" : ""
                }`}
              >
                <span className="flex min-w-0 items-center gap-[8px] text-[var(--text-primary)]">
                  <span
                    className="size-[10px] shrink-0 rounded-[2px]"
                    style={{ background: contextColor(row.colorKey) }}
                    aria-hidden
                  />
                  <span className="truncate">{row.label}</span>
                </span>
                <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">
                  {formatContextTokenCount(row.tokens)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {supported && !error && (usage?.approximate || onOpenAdvanced) ? (
        <div className="mt-[8px] flex items-center justify-between gap-[8px] border-t border-[var(--border-card)] pt-[8px]">
          <p className="min-w-0 font-sans text-[10.5px] leading-snug text-[var(--text-disabled)]">
            {usage?.approximate ? "Approximate token counts (character-based estimate)." : ""}
          </p>
          {onOpenAdvanced ? (
            <button
              type="button"
              onClick={onOpenAdvanced}
              className="flex shrink-0 items-center gap-[5px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[8px] py-[3px] font-sans text-[10.5px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
              title="Open the full context window - every block verbatim - in an editor tab"
            >
              <Layers className="size-[12px]" strokeWidth={1.75} aria-hidden />
              Advanced
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
