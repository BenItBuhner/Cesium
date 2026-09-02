"use client";

import { useEffect, useState } from "react";
import {
  canReloadForStaleChunks,
  isChunkLoadError,
  reloadForStaleChunks,
} from "@/lib/chunk-load-recovery";

export type RouteErrorFallbackProps = {
  error: Error & { digest?: string };
  /** Next passes `reset` to `error.tsx`; `global-error.tsx` gets it too. */
  reset?: () => void;
};

type Phase = "reloading" | "manual";

/**
 * Shared body for `app/error.tsx` and `app/global-error.tsx`.
 *
 * Chunk-load failures (a tab that outlived a deploy) reload themselves once;
 * everything else, or a chunk failure that already burned its one automatic
 * reload, gets an explicit Reload / Try again pair instead of Next's stock
 * "Application error: a client-side exception has occurred" dead end.
 */
export function RouteErrorFallback({ error, reset }: RouteErrorFallbackProps) {
  const staleChunk = isChunkLoadError(error);
  const [phase, setPhase] = useState<Phase>(() =>
    staleChunk && canReloadForStaleChunks() ? "reloading" : "manual"
  );

  useEffect(() => {
    console.error("[route-error]", error);
  }, [error]);

  useEffect(() => {
    if (phase !== "reloading") return;
    if (!reloadForStaleChunks()) {
      setPhase("manual");
    }
  }, [phase]);

  const handleReload = () => {
    window.location.reload();
  };

  if (phase === "reloading") {
    return (
      <Shell
        title="Updating Cesium"
        body="A newer version of Cesium was deployed while this tab was open. Reloading to pick it up."
      />
    );
  }

  return (
    <Shell
      title={staleChunk ? "Cesium needs a reload" : "Something went wrong"}
      body={
        staleChunk
          ? "This tab is running an older build and could not load part of the app. Reload to get the latest version."
          : "An unexpected error interrupted this view. You can try again or reload the page."
      }
    >
      <div className="flex flex-wrap items-center justify-center gap-[8px]">
        <button
          type="button"
          onClick={handleReload}
          className="rounded-[var(--radius-tab)] border border-[var(--accent)] bg-[var(--accent)] px-[14px] py-[7px] font-sans text-[12px] font-medium text-[var(--bg-main)] transition-opacity hover:opacity-90 dark:text-[var(--bg-panel)]"
        >
          Reload
        </button>
        {reset && !staleChunk ? (
          <button
            type="button"
            onClick={reset}
            className="rounded-[var(--radius-tab)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-[14px] py-[7px] font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]"
          >
            Try again
          </button>
        ) : null}
      </div>
      {error.message ? (
        <details className="w-full max-w-[520px] text-left">
          <summary className="cursor-pointer font-sans text-[11px] text-[var(--text-disabled)]">
            Technical details
          </summary>
          <pre className="mt-[6px] max-h-[160px] overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-card)] px-[10px] py-[8px] font-mono text-[11px] text-[var(--text-secondary)]">
            {error.message}
            {error.digest ? `\n\ndigest: ${error.digest}` : ""}
          </pre>
        </details>
      ) : null}
    </Shell>
  );
}

function Shell({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      role="alert"
      className="flex min-h-dvh flex-col items-center justify-center gap-[14px] bg-[var(--bg-main)] px-6 text-center text-[var(--text-primary)]"
    >
      <h1 className="font-sans text-[16px] font-semibold tracking-tight">{title}</h1>
      <p className="max-w-[420px] font-sans text-[13px] text-[var(--text-secondary)]">{body}</p>
      {children}
    </div>
  );
}
