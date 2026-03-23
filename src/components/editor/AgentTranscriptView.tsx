"use client";

import { MessageThreadContent } from "@/components/chat/MessageThreadContent";
import type { ChatMessage } from "@/lib/types";

export function AgentTranscriptView({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden hide-scrollbar-y bg-[var(--bg-main)] [-webkit-overflow-scrolling:touch]">
      <div className="mx-auto w-full max-w-[min(920px,calc(100%-24px))] px-[clamp(20px,5vw,56px)] py-[clamp(16px,3vh,28px)]">
        <MessageThreadContent messages={messages} stickyUserHeader={false} />
      </div>
    </div>
  );
}
