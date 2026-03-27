"use client";

import { useEffect, useRef } from "react";
import { MessageThreadContent } from "./MessageThreadContent";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import type { ChatMessage } from "@/lib/types";

interface MessageListProps {
  messages: ChatMessage[];
  scrollTop?: number;
  onScrollTopChange?: (scrollTop: number) => void;
}

export function MessageList({
  messages,
  scrollTop = 0,
  onScrollTopChange,
}: MessageListProps) {
  const { openSubagentTranscript } = useOpenInEditor();
  const scrollRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root) return;
    root.scrollTop = scrollTop;
  }, [scrollTop]);

  return (
    <div
      ref={scrollRootRef}
      data-chat-scroll-root
      className="absolute inset-0 overflow-y-auto overflow-x-hidden overscroll-y-contain px-[10px] pt-[10px] pb-[clamp(220px,38vh,340px)] [-webkit-overflow-scrolling:touch] hide-scrollbar-y"
      onScroll={(event) => onScrollTopChange?.(event.currentTarget.scrollTop)}
    >
      <MessageThreadContent
        messages={messages}
        stickyUserHeader
        scrollRootRef={scrollRootRef}
        onOpenSubagent={(title, transcript) =>
          openSubagentTranscript({ title, messages: transcript })
        }
      />
    </div>
  );
}
