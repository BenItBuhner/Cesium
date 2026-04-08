import { useEffect, useRef, useState } from "react";
import { AtSign, CornerUpLeft, LayoutTemplate } from "lucide-react";
import type { ImageAttachment, UserMessageSegment } from "@/lib/types";
import { ImageCarousel } from "./ImageCarousel";

interface UserMessageProps {
  content?: string;
  segments?: UserMessageSegment[];
  attachments?: ImageAttachment[];
  showReplyCue?: boolean;
}

export function UserMessage({
  content,
  segments,
  attachments,
  showReplyCue,
}: UserMessageProps) {
  const hasSegments = segments && segments.length > 0;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

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
      setOverflowing(node.scrollHeight > collapsedMaxHeight + 4);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [content, segments]);

  return (
    <div
      className={`relative overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[10px] ${showReplyCue ? "pr-[36px]" : ""} ${overflowing ? "pb-[34px]" : ""}`}
    >
      {attachments && attachments.length > 0 && (
        <div className="mb-[10px]">
          <ImageCarousel
            images={attachments.map((a, i) => ({ ...a, localId: `display-${i}` }))}
            onRemove={() => {}}
          />
        </div>
      )}
      <div
        ref={bodyRef}
        className={`relative ${expanded ? "" : "overflow-hidden"}`}
        style={expanded ? undefined : { maxHeight: 100 }}
      >
        {hasSegments ? (
          <div className="block font-sans text-[14px] font-normal leading-normal text-[var(--text-primary)]">
            {segments!.map((s, i) =>
              s.type === "text" ? (
                <span key={i} className="break-words whitespace-pre-wrap">
                  {s.text}
                </span>
              ) : (
                <span
                  key={i}
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
              )
            )}
          </div>
        ) : (
          <p className="whitespace-pre-wrap font-sans text-[14px] font-normal leading-normal text-[var(--text-primary)]">
            {content ?? ""}
          </p>
        )}

        {!expanded && overflowing ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[34px] bg-gradient-to-b from-transparent to-[var(--bg-card)]" />
        ) : null}
      </div>

      {overflowing ? (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="absolute bottom-[8px] left-[10px] rounded-[6px] px-[6px] py-[3px] font-sans text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)]"
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      ) : null}

      {showReplyCue ? (
        <button
          type="button"
          className="absolute bottom-[8px] right-[8px] rounded-[6px] p-[4px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)]"
          aria-label="Reply or edit message"
        >
          <CornerUpLeft className="size-[14px]" strokeWidth={1.75} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
