import { useEffect, useRef, useState, type MouseEvent } from "react";
import { AtSign, CornerUpLeft, FileText, LayoutTemplate, MessageSquare, MousePointerSquareDashed } from "lucide-react";
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
  onRedo,
}: UserMessageProps) {
  const hasSegments = segments && segments.length > 0;
  const bodyRef = useRef<HTMLDivElement>(null);
  // Measurement target: the text content element (<p> or segments <div>), NOT
  // bodyRef. bodyRef's classes change with `singleLineOrLess` (flex/min-h-[24px]),
  // so measuring bodyRef feeds the state back into its own input — when the
  // one-line threshold lands between the natural text height and 24px (e.g.
  // WebView font scaling), the boolean turns bistable and flips every
  // ResizeObserver tick, shaking the whole thread. The text element's geometry
  // is invariant under the compact/expanded wrapper styling.
  const textRef = useRef<HTMLElement | null>(null);
  const setTextRef = (el: HTMLElement | null) => {
    textRef.current = el;
  };
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [singleLineOrLess, setSingleLineOrLess] = useState(true);

  useEffect(() => {
    setExpanded(false);
  }, [content, segments]);

  useEffect(() => {
    const textEl = textRef.current;
    if (!textEl) {
      setOverflowing(false);
      return;
    }
    const collapsedMaxHeight = 100;
    const measure = () => {
      // line-height comes from the SAME node whose height is measured
      // (text-[14px] leading-normal), so scaled fonts can't desync the two.
      const style = window.getComputedStyle(textEl);
      const lineHeight = Number.parseFloat(style.lineHeight);
      const oneLineHeight = Number.isFinite(lineHeight) ? lineHeight : 20;
      const textHeight = textEl.getBoundingClientRect().height;
      setOverflowing(textHeight > collapsedMaxHeight + 4);
      setSingleLineOrLess(textHeight <= oneLineHeight + 6);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(textEl);
    return () => observer.disconnect();
  }, [content, segments]);

  const toggleExpand = () => {
    if (overflowing) {
      setExpanded((current) => !current);
    }
  };
  // Compact styling must never change the measured node's content width.
  // It used to add `pr-[30px]`, which made boundary-width text bistable:
  // padding on -> wraps to two lines -> "not single line" -> padding off ->
  // fits one line -> "single line" -> padding on... flipping the bubble's
  // height every ResizeObserver tick and shaking the whole thread.
  const compactSingleLine = !attachments?.length && singleLineOrLess;
  const handleRedoClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onRedo?.();
  };

  return (
    <div
      data-electron-no-drag
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
        } ${compactSingleLine ? "flex min-h-[24px] items-center" : ""} ${
          !displayOnly && overflowing ? "cursor-pointer" : ""
        }`}
        style={expanded ? undefined : { maxHeight: 100 }}
      >
        <MessageTextSelectionCite
          composerDraftId={composerDraftId}
          className={`min-w-0 select-text ${compactSingleLine ? "flex-1" : ""}`}
        >
        {hasSegments ? (
          <div
            ref={setTextRef}
            className="block font-sans text-[14px] font-normal leading-normal text-[var(--text-primary)]"
          >
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
              if (s.type === "conversation") {
                const title = s.conversationWorkspaceName
                  ? `${s.text}\nChat in ${s.conversationWorkspaceName}`
                  : s.text;
                return (
                  <span
                    key={i}
                    title={title}
                    onClick={(event) => event.stopPropagation()}
                    className="mx-[2px] inline-flex max-w-full items-center gap-[5px] rounded-[6px] border border-[var(--border-subtle)] bg-[var(--file-tag-bg)] px-[7px] py-[2px] align-baseline font-sans text-[13px] font-medium text-[var(--file-tag-text)]"
                    data-conversation-reference-id={s.conversationId ?? ""}
                  >
                    <MessageSquare
                      className="size-[12px] shrink-0 text-[var(--file-tag-icon)]"
                      strokeWidth={1.75}
                      aria-hidden
                    />
                    <span className="max-w-[260px] truncate">{s.text || "conversation"}</span>
                  </span>
                );
              }
              if (s.type === "text-reference") {
                const charCount = s.referenceCharCount ?? s.referenceText?.length ?? 0;
                const title = s.referenceText
                  ? `${s.text}\n${charCount.toLocaleString()} characters\n\n${s.referenceText.slice(0, 600)}${
                      s.referenceText.length > 600 ? "…" : ""
                    }`
                  : s.text;
                return (
                  <span
                    key={i}
                    title={title}
                    onClick={(event) => event.stopPropagation()}
                    className="mx-[2px] inline-flex max-w-full items-center gap-[5px] rounded-[6px] border border-[var(--border-subtle)] bg-[var(--file-tag-bg)] px-[7px] py-[2px] align-baseline font-sans text-[13px] font-medium text-[var(--file-tag-text)]"
                    data-text-reference-id={s.referenceId ?? ""}
                  >
                    <FileText
                      className="size-[12px] shrink-0 text-[var(--file-tag-icon)]"
                      strokeWidth={1.75}
                      aria-hidden
                    />
                    <span className="max-w-[260px] truncate">{s.text || "pasted text"}</span>
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
          <p
            ref={setTextRef}
            className="whitespace-pre-wrap font-sans text-[14px] font-normal leading-normal text-[var(--text-primary)]"
          >
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

      {!displayOnly && showReplyCue !== false && onRedo ? (
        <button
          type="button"
          onClick={handleRedoClick}
          className="pointer-events-none absolute bottom-[6px] right-[8px] z-20 rounded-[6px] bg-[var(--bg-card)]/85 p-[4px] text-[var(--text-secondary)] opacity-0 transition-[opacity,background-color,color] duration-200 group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)] focus-visible:pointer-events-auto focus-visible:opacity-100"
          aria-label="Redo message from here"
        >
          <CornerUpLeft className="size-[14px]" strokeWidth={1.75} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
