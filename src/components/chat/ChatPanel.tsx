"use client";

import { useMemo, useState } from "react";
import { ChatTabs } from "./ChatTabs";
import { MessageList } from "./MessageList";
import { ChatComposer } from "./ChatComposer";
import { chatTabs as initialTabs, chatMessages, currentModel } from "@/lib/mock-data";
import { AskQuestionCard } from "./AskQuestionCard";
import { askStepsFromMessage } from "@/lib/ask-question-utils";
import type { ChatMessage, EditorMode, ModelInfo } from "@/lib/types";

function partitionMessagesForDock(messages: ChatMessage[]): {
  scrollMessages: ChatMessage[];
  dockedAsk: ChatMessage | null;
} {
  const last = messages[messages.length - 1];
  if (last?.type === "ask-question") {
    return {
      scrollMessages: messages.slice(0, -1),
      dockedAsk: last,
    };
  }
  return { scrollMessages: messages, dockedAsk: null };
}

export function ChatPanel() {
  const [tabs, setTabs] = useState(initialTabs);
  const [mode, setMode] = useState<EditorMode>("agent");
  const [model, setModel] = useState<ModelInfo>(currentModel);

  const { scrollMessages, dockedAsk } = partitionMessagesForDock(chatMessages);

  const dockedAskSteps = useMemo(
    () => (dockedAsk ? askStepsFromMessage(dockedAsk) : []),
    [dockedAsk]
  );

  function handleSelectTab(id: string) {
    setTabs((prev) =>
      prev.map((t) => ({ ...t, active: t.id === id }))
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-panel)]">
      <div className="shrink-0">
        <ChatTabs tabs={tabs} onSelectTab={handleSelectTab} />
      </div>
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <MessageList messages={scrollMessages} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30">
          <div className="pointer-events-auto chat-bottom-dock">
            {dockedAskSteps.length > 0 ? (
              <div className="px-[10px] pt-[8px]">
                <AskQuestionCard steps={dockedAskSteps} dockAboveComposer />
              </div>
            ) : null}
            <ChatComposer
              mode={mode}
              onModeChange={setMode}
              model={model}
              onModelChange={setModel}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
