import { memo } from "react";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { AssistantMessage } from "./AssistantMessage";

const levelStyles = {
  warning: {
    label: "Warning",
    Icon: TriangleAlert,
    container:
      "border-[color-mix(in_srgb,var(--status-warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--status-warning)_7%,transparent)]",
    badge: "text-[var(--status-warning)]",
  },
  error: {
    label: "Error",
    Icon: CircleAlert,
    container:
      "border-[color-mix(in_srgb,var(--status-error)_30%,transparent)] bg-[color-mix(in_srgb,var(--status-error)_7%,transparent)]",
    badge: "text-[var(--status-error)]",
  },
} as const;

interface SystemNoticeMessageProps {
  level: keyof typeof levelStyles;
  content: string;
  composerDraftId?: string | null;
}

/** Runtime `system` warning/error, badged so it never reads as the agent's own reply. */
export const SystemNoticeMessage = memo(function SystemNoticeMessage({
  level,
  content,
  composerDraftId,
}: SystemNoticeMessageProps) {
  const style = levelStyles[level];
  return (
    <div
      role={level === "error" ? "alert" : "status"}
      className={`flex min-w-0 flex-col gap-[4px] rounded-[8px] border px-[10px] py-[8px] ${style.container}`}
    >
      <span
        className={`inline-flex items-center gap-[5px] font-sans text-[10px] font-medium uppercase tracking-[0.08em] ${style.badge}`}
      >
        <style.Icon className="size-[12px] shrink-0" strokeWidth={1.75} aria-hidden />
        {style.label}
      </span>
      <AssistantMessage content={content} composerDraftId={composerDraftId} />
    </div>
  );
});
