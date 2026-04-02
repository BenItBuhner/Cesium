import { Loader, Check } from "lucide-react";

interface SubagentCardProps {
  title: string;
  meta?: string;
  recentActivity?: string;
  /** false = in progress (spinner); true/omitted = finished (checkmark). */
  complete?: boolean;
  /** When set with onOpen, card opens subagent transcript in the editor. */
  interactive?: boolean;
  onOpen?: () => void;
}

export function SubagentCard({
  title,
  meta,
  recentActivity,
  complete = true,
  interactive,
  onOpen,
}: SubagentCardProps) {
  const body = (
    <>
      <div className="flex items-center gap-[6px]">
        {complete ? (
          <Check
            className="size-[18px] shrink-0 text-[var(--text-secondary)]"
            strokeWidth={1.5}
            aria-hidden
          />
        ) : (
          <Loader
            className="size-[18px] shrink-0 text-[var(--text-secondary)] animate-spin"
            strokeWidth={1.5}
            aria-hidden
          />
        )}
        <span className="font-sans text-[14px] font-normal text-[var(--text-primary)]">
          {title}
        </span>
      </div>
      {meta && (
        <span className="pl-[24px] font-sans text-[11.9px] font-normal text-[var(--text-secondary)]">
          {meta}
        </span>
      )}
      {recentActivity && (
        <span className="pl-[24px] font-sans text-[11.9px] font-normal italic text-[var(--text-tertiary)] truncate">
          Recent: {recentActivity}
        </span>
      )}
    </>
  );

  const shell =
    "flex w-full flex-col gap-[2px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[10px] text-left overflow-hidden transition-colors";

  if (interactive && onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className={`${shell} cursor-pointer hover:border-[var(--border-card)] hover:bg-[var(--bg-card-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]`}
        aria-label={`Open subagent transcript: ${title}`}
      >
        {body}
      </button>
    );
  }

  return <div className={shell}>{body}</div>;
}
