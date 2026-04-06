"use client";

import { useCallback, useEffect, useRef } from "react";
import { MessageThreadContent } from "./MessageThreadContent";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import type { ChatMessage } from "@/lib/types";

function inferTranscriptSessionId(messages: ChatMessage[]): string | undefined {
  for (const message of messages) {
    const match = message.id.match(/(ses_[A-Za-z0-9]+)/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

interface MessageListProps {
  messages: ChatMessage[];
  initialScrollTop?: number;
  onScrollTopSettled?: (scrollTop: number) => void;
  onResolvePermission?: (requestId: string, optionId: string) => void;
  bottomDockVisible?: boolean;
}

export function MessageList({
  messages,
  initialScrollTop = 0,
  onScrollTopSettled,
  onResolvePermission,
  bottomDockVisible = true,
}: MessageListProps) {
  const { openSubagentTranscript } = useOpenInEditor();
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const initialScrollTopRef = useRef(initialScrollTop);
  const persistTimerRef = useRef<number | null>(null);
  const pendingScrollTopRef = useRef(initialScrollTop);
  const persistedScrollTopRef = useRef<number | null>(null);

  const isNearBottom = (root: HTMLDivElement) =>
    root.scrollHeight - (root.scrollTop + root.clientHeight) <= 48;

  const flushPersistedScrollTop = useCallback(() => {
    if (!onScrollTopSettled) {
      return;
    }
    const nextScrollTop = pendingScrollTopRef.current;
    if (persistedScrollTopRef.current === nextScrollTop) {
      return;
    }
    persistedScrollTopRef.current = nextScrollTop;
    onScrollTopSettled(nextScrollTop);
  }, [onScrollTopSettled]);

  const schedulePersistedScrollTop = useCallback(() => {
    if (!onScrollTopSettled) {
      return;
    }
    if (persistTimerRef.current != null) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      flushPersistedScrollTop();
    }, 180);
  }, [flushPersistedScrollTop, onScrollTopSettled]);

  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root) return;
    root.scrollTop = initialScrollTopRef.current;
    pendingScrollTopRef.current = initialScrollTopRef.current;
    persistedScrollTopRef.current = initialScrollTopRef.current;
    stickToBottomRef.current = isNearBottom(root);
  }, []);

  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root || !stickToBottomRef.current) {
      return;
    }
    root.scrollTop = root.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) {
        root.scrollTop = root.scrollHeight;
      }
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const flushOnPageHide = () => {
      flushPersistedScrollTop();
    };
    const flushOnHidden = () => {
      if (document.visibilityState === "hidden") {
        flushPersistedScrollTop();
      }
    };
    window.addEventListener("pagehide", flushOnPageHide);
    window.addEventListener("beforeunload", flushOnPageHide);
    document.addEventListener("visibilitychange", flushOnHidden);
    return () => {
      window.removeEventListener("pagehide", flushOnPageHide);
      window.removeEventListener("beforeunload", flushOnPageHide);
      document.removeEventListener("visibilitychange", flushOnHidden);
      if (persistTimerRef.current != null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      flushPersistedScrollTop();
    };
  }, [flushPersistedScrollTop]);

  return (
    <div
      ref={scrollRootRef}
      data-chat-scroll-root
      className={`absolute inset-0 overflow-y-auto overflow-x-hidden overscroll-y-contain px-[10px] pt-[10px] [-webkit-overflow-scrolling:touch] hide-scrollbar-y ${
        bottomDockVisible ? "pb-[clamp(220px,38vh,340px)]" : "pb-[14px]"
      }`}
      onScroll={(event) => {
        stickToBottomRef.current = isNearBottom(event.currentTarget);
        pendingScrollTopRef.current = Math.round(event.currentTarget.scrollTop);
        schedulePersistedScrollTop();
      }}
    >
        <MessageThreadContent
          messages={messages}
          stickyUserHeader
          scrollRootRef={scrollRootRef}
          onResolvePermission={onResolvePermission}
          onOpenSubagent={({ title, transcript, sessionId }) =>
            openSubagentTranscript({
              title,
              messages: transcript,
              sessionId: sessionId ?? inferTranscriptSessionId(transcript),
            })
          }
        />
      </div>
  );
}
