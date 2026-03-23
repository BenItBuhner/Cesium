import { CornerUpLeft, LayoutTemplate } from "lucide-react";
import type { UserMessageSegment } from "@/lib/types";

interface UserMessageProps {
  content?: string;
  segments?: UserMessageSegment[];
  showReplyCue?: boolean;
}

export function UserMessage({
  content,
  segments,
  showReplyCue,
}: UserMessageProps) {
  const hasSegments = segments && segments.length > 0;

  return (
    <div
      className={`relative overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[10px] ${showReplyCue ? "pr-[36px]" : ""}`}
    >
      {hasSegments ? (
        <div className="flex flex-wrap items-baseline gap-x-[6px] gap-y-[6px] font-sans text-[14px] font-normal leading-normal text-[var(--text-primary)]">
          {segments!.map((s, i) =>
            s.type === "text" ? (
              <span key={i} className="min-w-0 whitespace-pre-wrap">
                {s.text}
              </span>
            ) : (
              <span
                key={i}
                className="inline-flex max-w-full items-center gap-[5px] rounded-[6px] bg-[var(--file-tag-bg)] px-[7px] py-[2px] align-middle font-sans text-[13px] font-medium text-[var(--file-tag-text)]"
              >
                <LayoutTemplate
                  className="size-[12px] shrink-0 text-[var(--file-tag-icon)]"
                  strokeWidth={1.75}
                  aria-hidden
                />
                <span className="truncate">{s.text}</span>
              </span>
            )
          )}
        </div>
      ) : (
        <p className="font-sans text-[14px] font-normal leading-normal text-[var(--text-primary)]">
          {content ?? ""}
        </p>
      )}

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
