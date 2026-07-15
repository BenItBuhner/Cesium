"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import {
  formatContextTokenCount,
  formatContextUsagePair,
} from "@/lib/composer-status-bar";
import type { AgentContextUsageSnapshot } from "@/lib/agent-types";
import { ContextUsageRing } from "./ContextUsageRing";
import { dockedComposerCardFrame } from "./docked-card";

const COLOR_BY_KEY: Record<string, string> = {
  system: "var(--context-usage-system)",
  tools: "var(--context-usage-tools)",
  mcp: "var(--context-usage-mcp)",
  summarized: "var(--context-usage-summarized)",
  conversation: "var(--context-usage-conversation)",
};

interface ContextBreakdownDockProps {
  usage: AgentContextUsageSnapshot | null;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
}

export function ContextBreakdownDock({
  usage,
  loading = false,
  error = null,
  onClose,
}: ContextBreakdownDockProps) {
  const supported = usage?.supported ?? false;
  const usedTokens = usage?.usedTokens ?? 0;
  const limitTokens = usage?.limitTokens ?? 0;
  const percent = usage?.percentFull ?? 0;
  const categories = usage?.categories ?? [];

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

  return (
    <div className={dockedComposerCardFrame} data-context-breakdown-dock role="region" aria-label="Context usage breakdown">
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
        <button
          type="button"
          onClick={onClose}
          className="flex size-[24px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
          aria-label="Close context breakdown"
        >
          <X className="size-[14px]" strokeWidth={1.75} aria-hidden />
        </button>
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
      ) : (
        <>
          {usedTokens > 0 ? (
            <div className="mb-[8px] flex h-[6px] w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--border-card)_80%,transparent)]">
              {categories.map((row) => (
                <div
                  key={row.id}
                  title={`${row.label}: ${formatContextTokenCount(row.tokens)}`}
                  style={{
                    flex: row.tokens,
                    background: COLOR_BY_KEY[row.colorKey] ?? "var(--text-secondary)",
                    minWidth: row.tokens > 0 ? 2 : 0,
                  }}
                />
              ))}
            </div>
          ) : null}
          <ul className="flex list-none flex-col gap-[6px]">
            {categories.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-[10px] font-sans text-[11.5px]"
              >
                <span className="flex min-w-0 items-center gap-[8px] text-[var(--text-primary)]">
                  <span
                    className="size-[10px] shrink-0 rounded-[2px]"
                    style={{
                      background: COLOR_BY_KEY[row.colorKey] ?? "var(--text-secondary)",
                    }}
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
          {usage?.approximate ? (
            <p className="mt-[8px] border-t border-[var(--border-card)] pt-[8px] font-sans text-[10.5px] leading-snug text-[var(--text-disabled)]">
              Approximate token counts (character-based estimate).
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
