"use client";

import { useCallback, useMemo, useState } from "react";
import { ChatTabs } from "./ChatTabs";
import { MessageList } from "./MessageList";
import { ChatComposer } from "./ChatComposer";
import { chatTabs as initialTabs, chatMessages, currentModel } from "@/lib/mock-data";
import { AskQuestionCard } from "./AskQuestionCard";
import { askStepsFromMessage } from "@/lib/ask-question-utils";
import type { ChatMessage, ChatTab, EditorMode, ModelInfo } from "@/lib/types";

/** Demo thread lives on this tab id from mock-data. */
const MAIN_CHAT_TAB_ID = "planning";

function buildInitialThreads(tabs: ChatTab[]): Record<string, ChatMessage[]> {
  const m: Record<string, ChatMessage[]> = {};
  for (const t of tabs) {
    m[t.id] = t.id === MAIN_CHAT_TAB_ID ? chatMessages : [];
  }
  return m;
}

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
  const [messagesByTabId, setMessagesByTabId] = useState<
    Record<string, ChatMessage[]>
  >(() => buildInitialThreads(initialTabs));
  const [mode, setMode] = useState<EditorMode>("agent");
  const [model, setModel] = useState<ModelInfo>(currentModel);

  const activeTabId = useMemo(
    () => tabs.find((t) => t.active)?.id ?? tabs[0]?.id ?? "",
    [tabs]
  );

  const threadMessages = messagesByTabId[activeTabId] ?? [];
  const isEmptyThread = threadMessages.length === 0;

  const { scrollMessages, dockedAsk } =
    partitionMessagesForDock(threadMessages);

  const dockedAskSteps = useMemo(
    () => (dockedAsk ? askStepsFromMessage(dockedAsk) : []),
    [dockedAsk]
  );

  const handleSelectTab = useCallback((id: string) => {
    setTabs((prev) => prev.map((t) => ({ ...t, active: t.id === id })));
  }, []);

  const handleNewChat = useCallback(() => {
    const id = `chat-${Date.now()}`;
    setTabs((prev) => [
      ...prev.map((t) => ({ ...t, active: false })),
      { id, title: "New chat", active: true },
    ]);
    setMessagesByTabId((prev) => ({ ...prev, [id]: [] }));
  }, []);

  const composer = (
    <ChatComposer
      key={activeTabId}
      mode={mode}
      onModeChange={setMode}
      model={model}
      onModelChange={setModel}
      layout={isEmptyThread ? "empty-top" : "docked-bottom"}
    />
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-panel)]">
      <div className="shrink-0">
        <ChatTabs
          tabs={tabs}
          onSelectTab={handleSelectTab}
          onNewChat={handleNewChat}
        />
      </div>

      {isEmptyThread ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="shrink-0">{composer}</div>
          <div
            className="min-h-0 flex-1 bg-[var(--bg-panel)]"
            aria-hidden
          />
        </div>
      ) : (
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <MessageList messages={scrollMessages} />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30">
            <div className="pointer-events-auto chat-bottom-dock">
              {dockedAskSteps.length > 0 ? (
                <div className="px-[10px] pt-[8px]">
                  <AskQuestionCard steps={dockedAskSteps} dockAboveComposer />
                </div>
              ) : null}
              {composer}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
