import { ListTodo } from "lucide-react";

interface TodoStatusCardProps {
  content: string;
  /** When true, stacks flush under the user bubble: square top corners, no top border (user bubble supplies the seam). */
  meldUserAbove?: boolean;
}

export function TodoStatusCard({ content, meldUserAbove }: TodoStatusCardProps) {
  return (
    <div
      className={`mx-[12px] flex items-center gap-[8px] border border-[var(--border-card)] bg-[var(--bg-card)] px-[10px] py-[7px] overflow-hidden ${meldUserAbove ? "rounded-b-[var(--radius-card)] rounded-t-none border-t-0" : "rounded-[var(--radius-card)]"}`}
    >
      <ListTodo className="size-[14px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.5} />
      <p className="font-sans text-[14px] font-normal text-[var(--text-secondary)]">
        {content}
      </p>
    </div>
  );
}
