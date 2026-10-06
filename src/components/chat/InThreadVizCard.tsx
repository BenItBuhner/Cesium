"use client";

import { useMemo, useState } from "react";
import { ChartLine, FileCode2, Maximize2, Minimize2, TriangleAlert } from "lucide-react";
import { getServerBaseUrl } from "@/lib/server-api";
import {
  buildChartVizSrcdoc,
  buildHtmlVizSrcdoc,
  chartRuntimeUrl,
  inThreadVizTitle,
  isInThreadVizOversized,
  parseChartFenceContent,
  type InThreadVizKind,
} from "@/lib/in-thread-viz";

const COLLAPSED_HEIGHT = 360;
const EXPANDED_HEIGHT = 620;

const VIZ_SANDBOX = "allow-scripts";

type InThreadVizCardProps = {
  kind: InThreadVizKind;
  language?: string;
  content: string;
};

function VizKindIcon({ kind }: { kind: InThreadVizKind }) {
  const className = "size-[15px] shrink-0 text-[var(--text-secondary)]";
  if (kind === "chart") {
    return <ChartLine className={className} strokeWidth={1.7} aria-hidden />;
  }
  return <FileCode2 className={className} strokeWidth={1.7} aria-hidden />;
}

/**
 * Sandboxed live canvas for a closed ```html / ```chart fence.
 * Scripts run; the iframe is a unique origin (no allow-same-origin).
 */
export function InThreadVizCard({ kind, language, content }: InThreadVizCardProps) {
  const [expanded, setExpanded] = useState(false);
  const title = inThreadVizTitle(language, kind);

  const prepared = useMemo(() => {
    if (isInThreadVizOversized(content)) {
      return { error: "This canvas is too large to render inline." };
    }
    if (kind === "chart") {
      const parsed = parseChartFenceContent(content);
      if (!parsed.ok) {
        return { error: parsed.error };
      }
      return {
        srcdoc: buildChartVizSrcdoc(title, parsed.json, chartRuntimeUrl(getServerBaseUrl())),
      };
    }
    return { srcdoc: buildHtmlVizSrcdoc(title, content) };
  }, [content, kind, title]);

  const iconButtonClass =
    "flex size-[26px] items-center justify-center rounded-[7px] text-[var(--text-secondary)] transition-colors hover:bg-[color-mix(in_srgb,var(--bg-card)_60%,transparent)] hover:text-[var(--text-primary)]";

  return (
    <div className="overflow-hidden rounded-[12px] border border-[var(--border-card)] bg-[color-mix(in_srgb,var(--bg-card)_70%,transparent)]">
      <div className="flex items-center gap-[8px] border-b border-[var(--border-card)] px-[10px] py-[6px]">
        <VizKindIcon kind={kind} />
        <div className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]">
          {title}
        </div>
        <span className="shrink-0 rounded-full border border-[var(--border-card)] px-[8px] py-[1px] font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--text-secondary)]">
          {kind === "chart" ? "chart" : "live"}
        </span>
        <button
          type="button"
          className={iconButtonClass}
          title={expanded ? "Collapse" : "Expand"}
          aria-label={expanded ? "Collapse canvas" : "Expand canvas"}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <Minimize2 className="size-[14px]" strokeWidth={1.7} aria-hidden />
          ) : (
            <Maximize2 className="size-[14px]" strokeWidth={1.7} aria-hidden />
          )}
        </button>
      </div>
      {"error" in prepared ? (
        <div className="flex items-center gap-[8px] px-[12px] py-[14px] text-[12px] text-[var(--text-secondary)]">
          <TriangleAlert className="size-[15px] shrink-0 text-[#f59e0b]" strokeWidth={1.7} aria-hidden />
          <span className="min-w-0 flex-1">{prepared.error}</span>
        </div>
      ) : (
        <div
          className="relative w-full bg-[var(--bg-card)] transition-[height] duration-200 ease-out"
          style={{ height: expanded ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT }}
        >
          <iframe
            title={title}
            srcDoc={prepared.srcdoc}
            className="size-full border-0"
            sandbox={VIZ_SANDBOX}
          />
        </div>
      )}
    </div>
  );
}
