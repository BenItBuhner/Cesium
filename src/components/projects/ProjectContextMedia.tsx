"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { FileText, ImageOff, LoaderCircle } from "lucide-react";
import type { ProjectContextEmbed } from "@cesium/core";
import { fetchProjectContextBlob } from "@/lib/server-api";

type ProjectContextMediaValue = {
  projectId: string;
  /** Shows a Context file in the Project page's Context tab. */
  openInContext: (path: string) => void;
};

const ProjectContextMediaContext = createContext<ProjectContextMediaValue | null>(null);

/**
 * Lets `context:` references in chat markdown resolve against one Project's
 * Context; with no Project they render as plain text.
 */
export function ProjectContextMediaProvider({
  projectId,
  openInContext,
  children,
}: {
  projectId: string | null;
  openInContext: ((path: string) => void) | null | undefined;
  children: ReactNode;
}) {
  const value = useMemo(
    () => (projectId && openInContext ? { projectId, openInContext } : null),
    [openInContext, projectId]
  );
  return <ProjectContextMediaContext.Provider value={value}>{children}</ProjectContextMediaContext.Provider>;
}

export function useProjectContextMedia(): ProjectContextMediaValue | null {
  return useContext(ProjectContextMediaContext);
}

const OBJECT_URL_CACHE_LIMIT = 60;
const objectUrls = new Map<string, Promise<string>>();

/** Object URLs for Context files, fetched with the engine's auth; the oldest are revoked past the limit. */
export function projectContextObjectUrl(projectId: string, path: string, version = ""): Promise<string> {
  const key = `${projectId}\n${path}\n${version}`;
  const cached = objectUrls.get(key);
  if (cached) {
    return cached;
  }
  const pending = fetchProjectContextBlob(projectId, path).then((blob) => URL.createObjectURL(blob));
  objectUrls.set(key, pending);
  pending.catch(() => objectUrls.delete(key));
  if (objectUrls.size > OBJECT_URL_CACHE_LIMIT) {
    const [oldestKey, oldest] = objectUrls.entries().next().value as [string, Promise<string>];
    objectUrls.delete(oldestKey);
    void oldest.then((url) => URL.revokeObjectURL(url)).catch(() => undefined);
  }
  return pending;
}

export function useProjectContextObjectUrl(
  projectId: string | null,
  path: string | null,
  version = ""
): { url: string | null; error: string | null } {
  const [state, setState] = useState<{ key: string; url: string | null; error: string | null } | null>(null);
  const key = projectId && path ? `${projectId}\n${path}\n${version}` : null;
  useEffect(() => {
    if (!projectId || !path || !key) {
      return;
    }
    let cancelled = false;
    projectContextObjectUrl(projectId, path, version).then(
      (url) => {
        if (!cancelled) {
          setState({ key, url, error: null });
        }
      },
      (caught: unknown) => {
        if (!cancelled) {
          setState({ key, url: null, error: caught instanceof Error ? caught.message : String(caught) });
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [key, path, projectId, version]);
  return state && state.key === key ? { url: state.url, error: state.error } : { url: null, error: null };
}

function MediaUnavailable({ label, error }: { label: string; error: string }) {
  return (
    <span
      className="inline-flex items-center gap-[6px] rounded-[8px] border border-[var(--border-card)] bg-[var(--bg-card)] px-[8px] py-[5px] font-sans text-[12px] text-[var(--text-secondary)]"
      title={error}
    >
      <ImageOff className="size-[13px] shrink-0" strokeWidth={1.7} aria-hidden />
      {label} is not in the Project context
    </span>
  );
}

function MediaLoading({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-[6px] font-sans text-[12px] text-[var(--text-secondary)]">
      <LoaderCircle className="size-[13px] animate-spin" strokeWidth={1.7} aria-hidden />
      Loading {label}…
    </span>
  );
}

function ContextFileChip({ path, label }: { path: string; label: string }) {
  const media = useProjectContextMedia();
  return (
    <button
      type="button"
      onClick={() => media?.openInContext(path)}
      className="inline-flex max-w-full items-center gap-[6px] rounded-[8px] border border-[var(--border-card)] bg-[var(--bg-card)] px-[8px] py-[5px] text-left font-sans text-[12.5px] text-[var(--text-primary)] transition-colors hover:border-[var(--accent)]"
      title={`Open ${path} in the Project context`}
    >
      <FileText className="size-[13px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.7} aria-hidden />
      <span className="truncate">{label}</span>
      <span className="truncate font-mono text-[11px] text-[var(--text-disabled)]">{path}</span>
    </button>
  );
}

/** A whole-line `context:` embed: the image, a video player, or a chip that opens the file. */
export function ProjectContextEmbedView({ embed }: { embed: ProjectContextEmbed }) {
  const media = useProjectContextMedia();
  const wantsBytes = media != null && embed.kind !== "file";
  const { url, error } = useProjectContextObjectUrl(wantsBytes ? media.projectId : null, wantsBytes ? embed.path : null);
  if (!media) {
    return <p className="break-words text-[var(--text-secondary)]">{embed.label} ({embed.path})</p>;
  }
  if (embed.kind === "file") {
    return <ContextFileChip path={embed.path} label={embed.label} />;
  }
  if (error) {
    return <MediaUnavailable label={embed.label} error={error} />;
  }
  if (!url) {
    return <MediaLoading label={embed.label} />;
  }
  return (
    <figure className="m-0 flex flex-col gap-[4px]" data-project-context-media={embed.path}>
      {embed.kind === "image" ? (
        <button
          type="button"
          onClick={() => media.openInContext(embed.path)}
          className="block max-w-full overflow-hidden rounded-[10px] border border-[var(--border-card)] bg-[var(--bg-card)]"
          title={`Open ${embed.path} in the Project context`}
        >
          <img src={url} alt={embed.label} className="block max-h-[420px] max-w-full object-contain" />
        </button>
      ) : (
        <video
          src={url}
          controls
          preload="metadata"
          className="block max-h-[420px] max-w-full rounded-[10px] border border-[var(--border-card)] bg-black"
          aria-label={embed.label}
        />
      )}
      <figcaption className="font-sans text-[11.5px] text-[var(--text-secondary)]">{embed.label}</figcaption>
    </figure>
  );
}

/** An inline `[label](context:path)` link: opens the file in the Context tab. */
export function ProjectContextInlineLink({ path, children }: { path: string; children: ReactNode }) {
  const media = useProjectContextMedia();
  if (!media) {
    return <>{children}</>;
  }
  return (
    <button
      type="button"
      onClick={() => media.openInContext(path)}
      className="inline p-0 text-left text-[var(--accent)] underline decoration-[color-mix(in_srgb,var(--accent)_40%,transparent)] underline-offset-[3px]"
      title={`Open ${path} in the Project context`}
    >
      {children}
    </button>
  );
}
