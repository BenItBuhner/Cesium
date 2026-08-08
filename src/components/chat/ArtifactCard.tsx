"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChartLine,
  ExternalLink,
  FileCode2,
  FolderKanban,
  LoaderCircle,
  Maximize2,
  Minimize2,
  PanelRight,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import {
  buildArtifactViewUrl,
  fetchWorkspaceArtifact,
  type ArtifactSummary,
} from "@/lib/server-api";

const COLLAPSED_HEIGHT = 360;
const EXPANDED_HEIGHT = 620;
const NOT_FOUND_RETRY_MS = 2_000;
const MAX_NOT_FOUND_RETRIES = 3;

/** Session-scoped meta cache so streaming re-renders don't refetch per token. */
const metaCache = new Map<string, ArtifactSummary>();

function cacheKey(workspaceId: string, artifactId: string): string {
  return `${workspaceId}:${artifactId}`;
}

function ArtifactKindIcon({ kind }: { kind: ArtifactSummary["kind"] | undefined }) {
  const className = "size-[15px] shrink-0 text-[var(--text-secondary)]";
  if (kind === "chart") {
    return <ChartLine className={className} strokeWidth={1.7} aria-hidden />;
  }
  if (kind === "project") {
    return <FolderKanban className={className} strokeWidth={1.7} aria-hidden />;
  }
  return <FileCode2 className={className} strokeWidth={1.7} aria-hidden />;
}

/**
 * Inline interactive preview for a `[[artifact:<id>]]` tag in assistant text.
 * Renders the artifact (chart / HTML page / mini project) in a live iframe
 * with expand, refresh, open-in-editor-tab, and open-in-window actions.
 */
export function ArtifactCard({ artifactId }: { artifactId: string }) {
  const { activeWorkspaceId } = useWorkspace();
  const { openBrowserUrl } = useOpenInEditor();
  const key = activeWorkspaceId ? cacheKey(activeWorkspaceId, artifactId) : null;
  const [meta, setMeta] = useState<ArtifactSummary | null>(
    key ? metaCache.get(key) ?? null : null
  );
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!activeWorkspaceId || !key) {
      return;
    }
    if (metaCache.has(key)) {
      setMeta(metaCache.get(key) ?? null);
      return;
    }
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const summary = await fetchWorkspaceArtifact(activeWorkspaceId, artifactId);
        if (cancelled) return;
        metaCache.set(key, summary);
        setMeta(summary);
        setError(null);
      } catch (loadError) {
        if (cancelled) return;
        attempts += 1;
        // The tag can land a beat before the artifact metadata is readable
        // (e.g. replaying a streamed message) — retry briefly before failing.
        if (attempts <= MAX_NOT_FOUND_RETRIES) {
          timer = setTimeout(() => void load(), NOT_FOUND_RETRY_MS);
          return;
        }
        setError(
          loadError instanceof Error ? loadError.message : "Failed to load artifact."
        );
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeWorkspaceId, artifactId, key, reloadToken]);

  const viewUrl = useMemo(
    () => (activeWorkspaceId ? buildArtifactViewUrl(activeWorkspaceId, artifactId) : null),
    [activeWorkspaceId, artifactId]
  );

  const refresh = useCallback(() => {
    if (key) {
      metaCache.delete(key);
    }
    setError(null);
    setReloadToken((token) => token + 1);
  }, [key]);

  const openInEditor = useCallback(() => {
    if (!viewUrl) return;
    openBrowserUrl({ url: viewUrl, title: meta?.title ?? "Artifact", group: "right" });
  }, [meta?.title, openBrowserUrl, viewUrl]);

  const openInWindow = useCallback(() => {
    if (!viewUrl) return;
    window.open(viewUrl, "_blank", "noopener,noreferrer");
  }, [viewUrl]);

  if (!activeWorkspaceId || !viewUrl) {
    return (
      <div className="rounded-[10px] border border-[var(--border-card)] bg-[color-mix(in_srgb,var(--bg-card)_70%,transparent)] px-[12px] py-[8px] font-mono text-[12px] text-[var(--text-secondary)]">
        Artifact {artifactId}
      </div>
    );
  }

  const iconButtonClass =
    "flex size-[26px] items-center justify-center rounded-[7px] text-[var(--text-secondary)] transition-colors hover:bg-[color-mix(in_srgb,var(--bg-card)_60%,transparent)] hover:text-[var(--text-primary)]";

  return (
    <div className="overflow-hidden rounded-[12px] border border-[var(--border-card)] bg-[color-mix(in_srgb,var(--bg-card)_70%,transparent)]">
      <div className="flex items-center gap-[8px] border-b border-[var(--border-card)] px-[10px] py-[6px]">
        <ArtifactKindIcon kind={meta?.kind} />
        <div className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]">
          {meta?.title ?? artifactId}
        </div>
        {meta ? (
          <span className="shrink-0 rounded-full border border-[var(--border-card)] px-[8px] py-[1px] font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--text-secondary)]">
            {meta.kind}
          </span>
        ) : null}
        <button
          type="button"
          className={iconButtonClass}
          title="Reload artifact"
          aria-label="Reload artifact"
          onClick={refresh}
        >
          <RotateCw className="size-[14px]" strokeWidth={1.7} aria-hidden />
        </button>
        <button
          type="button"
          className={iconButtonClass}
          title={expanded ? "Collapse" : "Expand"}
          aria-label={expanded ? "Collapse artifact" : "Expand artifact"}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <Minimize2 className="size-[14px]" strokeWidth={1.7} aria-hidden />
          ) : (
            <Maximize2 className="size-[14px]" strokeWidth={1.7} aria-hidden />
          )}
        </button>
        <button
          type="button"
          className={iconButtonClass}
          title="Open in editor tab"
          aria-label="Open artifact in editor tab"
          onClick={openInEditor}
        >
          <PanelRight className="size-[14px]" strokeWidth={1.7} aria-hidden />
        </button>
        <button
          type="button"
          className={iconButtonClass}
          title="Open in new window"
          aria-label="Open artifact in new window"
          onClick={openInWindow}
        >
          <ExternalLink className="size-[14px]" strokeWidth={1.7} aria-hidden />
        </button>
      </div>
      {error ? (
        <div className="flex items-center gap-[8px] px-[12px] py-[14px] text-[12px] text-[var(--text-secondary)]">
          <TriangleAlert className="size-[15px] shrink-0 text-[#f59e0b]" strokeWidth={1.7} aria-hidden />
          <span className="min-w-0 flex-1">
            Artifact <span className="font-mono">{artifactId}</span> is unavailable: {error}
          </span>
          <button
            type="button"
            className="shrink-0 rounded-[7px] border border-[var(--border-card)] px-[8px] py-[3px] text-[12px] text-[var(--text-primary)] hover:bg-[color-mix(in_srgb,var(--bg-card)_60%,transparent)]"
            onClick={refresh}
          >
            Retry
          </button>
        </div>
      ) : (
        <div
          className="relative w-full bg-[var(--bg-card)] transition-[height] duration-200 ease-out"
          style={{ height: expanded ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT }}
        >
          {!meta ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center gap-[8px] text-[12px] text-[var(--text-secondary)]">
              <LoaderCircle className="size-[15px] animate-spin" strokeWidth={1.7} aria-hidden />
              Loading artifact…
            </div>
          ) : null}
          <iframe
            key={`${artifactId}-${reloadToken}`}
            src={viewUrl}
            title={meta?.title ?? `Artifact ${artifactId}`}
            className="size-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
            loading="lazy"
          />
        </div>
      )}
    </div>
  );
}
