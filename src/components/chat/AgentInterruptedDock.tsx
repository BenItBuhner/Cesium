"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CirclePause, Play } from "lucide-react";
import type { AgentConversationRecord, AgentStoredEvent } from "@/lib/agent-types";
import { dockedComposerCardMx } from "./docked-card";

const btnPrimary =
  "inline-flex min-h-[32px] shrink-0 items-center justify-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--plan-accent)] bg-[var(--plan-accent)] px-[14px] py-[6px] font-sans text-[11px] font-medium leading-none text-[var(--bg-card)] outline-none ring-0 transition-opacity duration-150 ease-out hover:opacity-90 focus-visible:outline-none focus-visible:ring-0 disabled:opacity-60 motion-reduce:transition-none";

type AgentInterruptedDockProps = {
  conversation: AgentConversationRecord | null | undefined;
  events: AgentStoredEvent[] | undefined;
  /** Resolves to an error message when the run could not be continued. */
  onContinue: (conversationId: string) => Promise<string | null>;
  /** Another docked card (e.g. a question still answerable) takes precedence. */
  suppressed?: boolean;
  dockAboveComposer?: boolean;
  insetClassName?: string;
  contentClassName?: string;
};

export function isContinuableInterruption(
  conversation: AgentConversationRecord | null | undefined
): boolean {
  return conversation?.status === "interrupted" && conversation.config.backendId === "cesium-agent";
}

function latestInterruptionDetail(events: AgentStoredEvent[] | undefined): string | null {
  if (!events) {
    return null;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === "status" && event.status === "interrupted") {
      return event.detail?.trim() || null;
    }
  }
  return null;
}

/** Offers to pick an interrupted Cesium run back up from where it stopped. */
export function AgentInterruptedDock({
  conversation,
  events,
  onContinue,
  suppressed = false,
  dockAboveComposer = true,
  insetClassName,
  contentClassName,
}: AgentInterruptedDockProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversationId = conversation?.id ?? null;
  const detail = useMemo(() => latestInterruptionDetail(events), [events]);
  const visible = isContinuableInterruption(conversation) && !suppressed;

  useEffect(() => {
    setError(null);
  }, [conversationId, conversation?.status]);

  const handleContinue = useCallback(async () => {
    if (!conversationId) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setError(await onContinue(conversationId));
    } finally {
      setBusy(false);
    }
  }, [conversationId, onContinue]);

  if (!visible) {
    return null;
  }

  const frame = dockAboveComposer
    ? `aurora-glass ${dockedComposerCardMx} flex flex-col overflow-hidden rounded-t-[var(--agent-composer-radius)] rounded-b-none border-x border-t border-[var(--border-card)] bg-[var(--bg-card)] p-[10px]`
    : "aurora-glass flex flex-col overflow-hidden rounded-[var(--agent-composer-radius)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[10px]";
  const card = (
    <div className={frame} data-agent-interrupted-card>
      <div className="flex min-w-0 items-start gap-[6px] pb-[6px]">
        <CirclePause
          className="mt-[2px] size-[14px] shrink-0 text-[var(--plan-accent)]"
          strokeWidth={1.5}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="font-sans text-[13px] font-normal text-[var(--plan-accent-label-strong)]">
            Run interrupted
          </p>
          <p className="mt-[4px] font-sans text-[11.5px] font-normal leading-snug text-[var(--text-secondary)]">
            {detail ?? "This run stopped before it finished. Continue to pick up where it left off."}
          </p>
          {error ? (
            <p
              className="mt-[4px] font-sans text-[11px] font-normal leading-snug text-[var(--text-secondary)]"
              data-agent-interrupted-error
            >
              {error}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-[6px] border-t border-[var(--border-card)] pt-[8px]">
        <button
          type="button"
          className={btnPrimary}
          disabled={busy}
          onClick={() => void handleContinue()}
          data-agent-interrupted-continue
        >
          <Play className="size-[12px]" strokeWidth={1.75} aria-hidden />
          {busy ? "Continuing…" : "Continue"}
        </button>
      </div>
    </div>
  );

  const wrapperClass =
    insetClassName ?? (dockAboveComposer ? "pt-[8px]" : "px-[10px] pb-[8px] pt-[8px]");
  return (
    <div className={wrapperClass} data-agent-interrupted-dock>
      {contentClassName ? <div className={contentClassName}>{card}</div> : card}
    </div>
  );
}
