"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MessageThreadContent } from "@/components/chat/MessageThreadContent";
import { projectOpenCodeExportToChatMessages } from "@/lib/opencode-export-transcript";
import type { ChatMessage } from "@/lib/types";
import { useWorkspace } from "@/contexts/WorkspaceContext";

function inferTranscriptSessionId(messages: ChatMessage[]): string | undefined {
  for (const message of messages) {
    const match = message.id.match(/(ses_[A-Za-z0-9]+)/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

export function AgentTranscriptView({
  messages,
  sessionId,
}: {
  messages: ChatMessage[];
  sessionId?: string;
}) {
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const [liveMessages, setLiveMessages] = useState<ChatMessage[] | null>(null);
  const resolvedSessionId = sessionId ?? inferTranscriptSessionId(messages);
  const { activeWorkspaceId } = useWorkspace();

  useEffect(() => {
    setLiveMessages(null);
  }, [sessionId, messages]);

  useEffect(() => {
    if (!resolvedSessionId || !activeWorkspaceId || typeof window === "undefined") {
      return;
    }
    let cancelled = false;
    let timer: number | null = null;

    const tick = async () => {
      try {
        const subagentUrl = new URL(
          `/api/agents/subagents/${encodeURIComponent(resolvedSessionId)}`,
          `${window.location.protocol}//${window.location.hostname}:9100`
        );
        const response = await fetch(subagentUrl.toString(), {
          headers: {
            "x-opencursor-workspace-id": activeWorkspaceId,
          },
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(`Subagent session fetch failed with status ${response.status}`);
        }
        const result = (await response.json()) as { session: unknown };
        if (cancelled) {
          return;
        }
        const projected = projectOpenCodeExportToChatMessages(result.session);
        setLiveMessages((current) => {
          const next = projected.messages;
          if (JSON.stringify(current) === JSON.stringify(next)) {
            return current;
          }
          return next;
        });
        if (!projected.complete) {
          timer = window.setTimeout(tick, 2000);
        }
      } catch {
        timer = window.setTimeout(tick, 4000);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer != null) {
        window.clearTimeout(timer);
      }
    };
  }, [activeWorkspaceId, resolvedSessionId]);

  const renderedMessages = useMemo(
    () => (liveMessages && liveMessages.length > 0 ? liveMessages : messages),
    [liveMessages, messages]
  );

  return (
    <div
      ref={scrollRootRef}
      className="h-full min-h-0 overflow-y-auto overflow-x-hidden hide-scrollbar-y bg-[var(--bg-main)] [-webkit-overflow-scrolling:touch]"
    >
      <div className="mx-auto w-full max-w-[min(920px,calc(100%-24px))] px-[clamp(20px,5vw,56px)] py-[clamp(16px,3vh,28px)]">
        <MessageThreadContent
          messages={renderedMessages}
          stickyUserHeader
          scrollRootRef={scrollRootRef}
          workedSessionSurface="editor"
        />
      </div>
    </div>
  );
}
