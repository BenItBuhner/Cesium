"use client";

import { formatContextTokenCount } from "@/lib/composer-status-bar";

export const CONTEXT_COLOR_BY_KEY: Record<string, string> = {
  system: "var(--context-usage-system)",
  tools: "var(--context-usage-tools)",
  mcp: "var(--context-usage-mcp)",
  summarized: "var(--context-usage-summarized)",
  conversation: "var(--context-usage-conversation)",
};

export function contextColor(colorKey: string): string {
  return CONTEXT_COLOR_BY_KEY[colorKey] ?? "var(--text-secondary)";
}

export type ContextUsageBarSegment = {
  id: string;
  label: string;
  tokens: number;
  colorKey: string;
  detail?: string;
  /** Number of underlying blocks when the segment is a condensed group. */
  count?: number;
};

interface ContextUsageBarProps {
  segments: ContextUsageBarSegment[];
  /**
   * Sequential mode: hairline gaps between blocks so consecutive same-colored
   * blocks stay distinguishable. Pooled mode renders a solid stacked bar.
   */
  separated?: boolean;
  heightClass?: string;
  className?: string;
  hoveredId?: string | null;
  onHover?: (id: string | null) => void;
  selectedId?: string | null;
  /** When set, segments become buttons (inspector: jump to the block). */
  onSelect?: (id: string) => void;
  ariaLabel?: string;
}

function segmentTitle(segment: ContextUsageBarSegment): string {
  const tokens = formatContextTokenCount(segment.tokens);
  const detail = segment.detail ? ` — ${segment.detail}` : "";
  return `${segment.label}: ${tokens}${detail}`;
}

export function ContextUsageBar({
  segments,
  separated = false,
  heightClass = "h-[6px]",
  className = "",
  hoveredId = null,
  onHover,
  selectedId = null,
  onSelect,
  ariaLabel = "Context usage",
}: ContextUsageBarProps) {
  const visible = segments.filter((segment) => segment.tokens > 0);
  const dimOthers = hoveredId != null || selectedId != null;
  return (
    <div
      className={`flex w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--border-card)_80%,transparent)] ${heightClass} ${
        separated ? "gap-[1px]" : ""
      } ${className}`}
      role={onSelect ? "listbox" : "img"}
      aria-label={ariaLabel}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
    >
      {visible.map((segment) => {
        const emphasized = segment.id === hoveredId || segment.id === selectedId;
        const style = {
          flex: `${segment.tokens} 1 0px`,
          background: contextColor(segment.colorKey),
          minWidth: 2,
          opacity: dimOthers && !emphasized ? 0.45 : 1,
          transition: "opacity 120ms ease",
        } as const;
        if (onSelect) {
          return (
            <button
              key={segment.id}
              type="button"
              role="option"
              aria-selected={segment.id === selectedId}
              aria-label={segmentTitle(segment)}
              title={segmentTitle(segment)}
              onClick={() => onSelect(segment.id)}
              onMouseEnter={onHover ? () => onHover(segment.id) : undefined}
              onFocus={onHover ? () => onHover(segment.id) : undefined}
              className="block h-full cursor-pointer border-0 p-0 outline-none focus-visible:ring-1 focus-visible:ring-[var(--text-primary)]"
              style={style}
            />
          );
        }
        return (
          <div
            key={segment.id}
            title={segmentTitle(segment)}
            onMouseEnter={onHover ? () => onHover(segment.id) : undefined}
            style={style}
          />
        );
      })}
    </div>
  );
}
