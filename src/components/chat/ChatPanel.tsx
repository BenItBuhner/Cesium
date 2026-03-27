"use client";

import {
  useCallback,
  useMemo,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { ChatTabs } from "./ChatTabs";
import { MessageList } from "./MessageList";
import { ChatComposer } from "./ChatComposer";
import { chatTabs as initialTabs, chatMessages, currentModel } from "@/lib/mock-data";
import { AskQuestionCard } from "./AskQuestionCard";
import { askStepsFromMessage } from "@/lib/ask-question-utils";
import { useWorkbenchContextMenu } from "@/components/ide/WorkbenchContextMenuProvider";
import type { WorkbenchMenuItem } from "@/components/ide/workbench-context-menu-types";
import { VSCodeQuickInputShell } from "@/components/ide/VSCodeQuickInputShell";
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
  const { openAt } = useWorkbenchContextMenu();
  const [tabs, setTabs] = useState(initialTabs);
  const [messagesByTabId, setMessagesByTabId] = useState<
    Record<string, ChatMessage[]>
  >(() => buildInitialThreads(initialTabs));
  const [mode, setMode] = useState<EditorMode>("agent");
  const [model, setModel] = useState<ModelInfo>(currentModel);
  const [renameTarget, setRenameTarget] = useState<{
    tabId: string;
    draft: string;
  } | null>(null);

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

  const closeChatTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const removed = prev.filter((t) => t.id !== tabId);
      if (removed.length === 0) {
        const id = `chat-${Date.now()}`;
        queueMicrotask(() => setMessagesByTabId({ [id]: [] }));
        return [{ id, title: "New chat", active: true }];
      }
      const wasClosingActive = prev.find((t) => t.id === tabId)?.active;
      if (!wasClosingActive) {
        return removed;
      }
      const nextActive = removed[0]!;
      return removed.map((t) => ({ ...t, active: t.id === nextActive.id }));
    });
    setMessagesByTabId((prev) => {
      if (!(tabId in prev)) return prev;
      if (Object.keys(prev).length === 1) {
        return prev;
      }
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
  }, []);

  const closeOtherChatTabs = useCallback((tabId: string) => {
    setTabs((prev) => {
      const keep = prev.find((t) => t.id === tabId);
      if (!keep) return prev;
      return [{ ...keep, active: true }];
    });
    setMessagesByTabId((prev) =>
      tabId in prev ? { [tabId]: prev[tabId] ?? [] } : { [tabId]: [] }
    );
  }, []);

  const closeAllChatTabs = useCallback(() => {
    const id = `chat-${Date.now()}`;
    setTabs([{ id, title: "New chat", active: true }]);
    setMessagesByTabId({ [id]: [] });
  }, []);

  const clearThreadMessages = useCallback((tabId: string) => {
    setMessagesByTabId((prev) => ({ ...prev, [tabId]: [] }));
  }, []);

  const submitChatRename = useCallback(() => {
    setRenameTarget((prev) => {
      if (!prev) return null;
      const title = prev.draft.trim();
      if (!title) return null;
      const id = prev.tabId;
      setTabs((tabsPrev) =>
        tabsPrev.map((t) => (t.id === id ? { ...t, title } : t))
      );
      return null;
    });
  }, []);

  const handleChatTabContextMenu = useCallback(
    (e: MouseEvent, tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      const othersOpen = tabs.length > 1;
      const items: WorkbenchMenuItem[] = [
        {
          type: "item",
          id: "close",
          label: "Close",
          onSelect: () => closeChatTab(tabId),
        },
        {
          type: "item",
          id: "close-others",
          label: "Close Others",
          disabled: !othersOpen,
          onSelect: () => closeOtherChatTabs(tabId),
        },
        { type: "sep" },
        {
          type: "item",
          id: "rename",
          label: "Rename",
          onSelect: () => {
            if (tab) {
              setRenameTarget({ tabId, draft: tab.title });
            }
          },
        },
        {
          type: "item",
          id: "clear",
          label: "Clear Messages",
          onSelect: () => clearThreadMessages(tabId),
        },
      ];
      openAt(e, items);
    },
    [tabs, openAt, closeChatTab, closeOtherChatTabs, clearThreadMessages]
  );

  const handleChatStripContextMenu = useCallback(
    (e: MouseEvent) => {
      openAt(e, [
        {
          type: "item",
          id: "close-all",
          label: "Close All",
          onSelect: () => closeAllChatTabs(),
        },
        { type: "sep" },
        {
          type: "item",
          id: "new-chat",
          label: "New Chat",
          onSelect: () => handleNewChat(),
        },
      ]);
    },
    [openAt, closeAllChatTabs, handleNewChat]
  );

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
      <VSCodeQuickInputShell
        open={renameTarget !== null}
        screenReaderTitle="Rename chat"
        inputLabel="Chat title"
        placeholder="Chat title"
        value={renameTarget?.draft ?? ""}
        onChange={(v) =>
          setRenameTarget((prev) => (prev ? { ...prev, draft: v } : prev))
        }
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setRenameTarget(null);
          }
          if (e.key === "Enter") {
            e.preventDefault();
            submitChatRename();
          }
        }}
      >
        <div className="border-t border-[var(--palette-divider)] px-[10px] py-[8px] font-sans text-[12px] text-[var(--palette-footer-text)]">
          Renames this chat tab locally.
        </div>
      </VSCodeQuickInputShell>

      <div className="shrink-0">
        <ChatTabs
          tabs={tabs}
          onSelectTab={handleSelectTab}
          onNewChat={handleNewChat}
          onTabContextMenu={handleChatTabContextMenu}
          onStripContextMenu={handleChatStripContextMenu}
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
