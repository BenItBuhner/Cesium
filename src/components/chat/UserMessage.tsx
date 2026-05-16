import { useEffect, useRef, useState, type MouseEvent } from "react";
import { AtSign, CornerUpLeft, GitFork, LayoutTemplate, MousePointerSquareDashed } from "lucide-react";
import type { ImageAttachment, UserMessageSegment } from "@/lib/types";
import { ImageCarousel } from "./ImageCarousel";
import { MessageTextSelectionCite } from "./MessageTextSelectionCite";

interface UserMessageProps {
  content?: string;
  segments?: UserMessageSegment[];
  attachments?: ImageAttachment[];
  showReplyCue?: boolean;
  highlight?: boolean;
  /** When set, selected text in the bubble can be cited into this composer draft. */
  composerDraftId?: string | null;
  displayOnly?: boolean;
  onFork?: () => void;
  onRedo?: () => void;
}

export function UserMessage({
  content,
  segments,
  attachments,
  showReplyCue,
  highlight,
  composerDraftId,
  displayOnly = false,
  onFork,
  onRedo,
}: UserMessageProps) {
  const hasSegments = segments && segments.length > 0;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [singleLineOrLess, setSingleLineOrLess] = useState(true);

  useEffect(() => {
    setExpanded(false);
  }, [content, segments]);

  useEffect(() => {
    const node = bodyRef.current;
    if (!node) {
      setOverflowing(false);
      return;
    }
    const collapsedMaxHeight = 100;
    const measure = () => {
      const style = window.getComputedStyle(node);
      const lineHeight = Number.parseFloat(style.lineHeight);
      const oneLineHeight = Number.isFinite(lineHeight) ? lineHeight : 20;
      setOverflowing(node.scrollHeight > collapsedMaxHeight + 4);
      setSingleLineOrLess(node.scrollHeight <= oneLineHeight + 6);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [content, segments]);

  const toggleExpand = () => {
    if (overflowing) {
      setExpanded((current) => !current);
    }
  };
  const compactSingleLine = !attachments?.length && singleLineOrLess;
  const handleForkClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onFork?.();
  };
  const handleRedoClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onRedo?.();
  };

  return (
    <div
      className={`group relative overflow-hidden rounded-[var(--agent-card-radius)] border border-[var(--agent-border)] bg-[var(--agent-card-bg)] p-[10px] ${highlight ? "ring-2 ring-[var(--accent)] ring-opacity-50" : ""}`}
    >
      {attachments && attachments.length > 0 && (
        <div className="mb-[10px]">
        <ImageCarousel
          images={attachments.map((a, i) => ({ ...a, localId: `display-${i}` }))}
          readOnly
        />
        </div>
      )}
      <div
        ref={bodyRef}
        tabIndex={!displayOnly && overflowing ? 0 : undefined}
        aria-expanded={!displayOnly && overflowing ? expanded : undefined}
        onClick={displayOnly ? undefined : toggleExpand}
        onKeyDown={(event) => {
          if (displayOnly || !overflowing) {
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleExpand();
          }
        }}
        className={`relative text-left ${
          expanded ? "" : "overflow-hidden"
        } ${compactSingleLine ? "flex min-h-[22px] items-center pr-[44px]" : ""} ${
          !displayOnly && overflowing ? "cursor-pointer" : ""
        }`}
        style={expanded ? undefined : { maxHeight: 100 }}
      >
        <MessageTextSelectionCite
          composerDraftId={composerDraftId}
          className={`min-w-0 select-text ${compactSingleLine ? "flex-1" : ""}`}
        >
        {hasSegments ? (
          <div className="block font-sans text-[14px] font-normal leading-normal text-[var(--text-primary)]">
            {segments!.map((s, i) => {
              if (s.type === "text") {
                return (
                  <span key={i} className="break-words whitespace-pre-wrap">
                    {s.text}
                  </span>
                );
              }
              if (s.type === "design") {
                const title = s.captureSnippet
                  ? `${s.text}\n\n${s.captureSnippet.slice(0, 600)}${
                      s.captureSnippet.length > 600 ? "…" : ""
                    }`
                  : s.text;
                return (
                  <span
                    key={i}
                    title={title}
                    onClick={(event) => event.stopPropagation()}
                    className="mx-[2px] inline-flex max-w-full items-center gap-[5px] rounded-[6px] border border-[var(--border-subtle)] bg-[var(--file-tag-bg)] px-[7px] py-[2px] align-baseline font-sans text-[13px] font-medium text-[var(--file-tag-text)]"
                    data-design-capture-id={s.captureId ?? ""}
                  >
                    <MousePointerSquareDashed
                      className="size-[12px] shrink-0 text-[var(--file-tag-icon)]"
                      strokeWidth={1.75}
                      aria-hidden
                    />
                    <span className="max-w-[260px] truncate">{s.text || "element"}</span>
                  </span>
                );
              }
              return (
                <span
                  key={i}
                  onClick={(event) => event.stopPropagation()}
                  className="mx-[2px] inline-flex max-w-full items-center gap-[5px] rounded-[6px] bg-[var(--file-tag-bg)] px-[7px] py-[2px] align-baseline font-sans text-[13px] font-medium text-[var(--file-tag-text)]"
                >
                  {s.type === "context" ? (
                    <AtSign
                      className="size-[12px] shrink-0 text-[var(--file-tag-icon)]"
                      strokeWidth={1.75}
                      aria-hidden
                    />
                  ) : (
                    <LayoutTemplate
                      className="size-[12px] shrink-0 text-[var(--file-tag-icon)]"
                      strokeWidth={1.75}
                      aria-hidden
                    />
                  )}
                  <span className="truncate">{s.text}</span>
                </span>
              );
            })}
          </div>
        ) : (
          <p className="whitespace-pre-wrap font-sans text-[14px] font-normal leading-normal text-[var(--text-primary)]">
            {content ?? ""}
          </p>
        )}
        </MessageTextSelectionCite>

        {!expanded && overflowing ? (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-[28px] bg-gradient-to-b from-transparent to-[var(--bg-card)]"
            aria-hidden
          />
        ) : null}
      </div>

      {!displayOnly && onFork ? (
        <button
          type="button"
          onClick={handleForkClick}
          className="pointer-events-none absolute bottom-[4px] right-[28px] z-20 rounded-[6px] bg-[var(--bg-card)]/85 p-[4px] text-[var(--text-secondary)] opacity-0 transition-[opacity,background-color,color] duration-200 group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)] focus-visible:pointer-events-auto focus-visible:opacity-100"
          aria-label="Fork chat from here"
        >
          <GitFork className="size-[14px]" strokeWidth={1.75} aria-hidden />
        </button>
      ) : null}
      {!displayOnly && showReplyCue !== false && onRedo ? (
        <button
          type="button"
          onClick={handleRedoClick}
          className="pointer-events-none absolute bottom-[4px] right-[6px] z-20 rounded-[6px] bg-[var(--bg-card)]/85 p-[4px] text-[var(--text-secondary)] opacity-0 transition-[opacity,background-color,color] duration-200 group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)] focus-visible:pointer-events-auto focus-visible:opacity-100"
          aria-label="Redo message from here"
        >
          <CornerUpLeft className="size-[14px]" strokeWidth={1.75} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
