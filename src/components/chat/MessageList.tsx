"use client";

import { useRef } from "react";
import { MessageThreadContent } from "./MessageThreadContent";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import type { ChatMessage } from "@/lib/types";

interface MessageListProps {
  messages: ChatMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  const { openSubagentTranscript } = useOpenInEditor();
  const scrollRootRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={scrollRootRef}
      data-chat-scroll-root
      className="absolute inset-0 overflow-y-auto overflow-x-hidden overscroll-y-contain px-[10px] pt-[10px] pb-[clamp(220px,38vh,340px)] [-webkit-overflow-scrolling:touch] hide-scrollbar-y"
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
