"use client";

import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { LoaderCircle, Plus, X } from "lucide-react";
import { setMinimalTabDragImage } from "@/components/editor/tab-drag-image";
import { CHAT_TAB_DND_MIME, parseChatTabDragPayload } from "@/lib/chat-tab-dnd";
import { useTabStripWheel } from "@/hooks/useTabStripWheel";
import type { AgentTabIndicatorByConversationId, ChatTab } from "@/lib/types";

interface ChatTabsProps {
  tabs: ChatTab[];
  /** Running / permission-pending UI; keyed by tab id (= conversation id). */
  agentTabIndicators?: AgentTabIndicatorByConversationId;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewChat: () => void;
  onTabContextMenu?: (e: MouseEvent, tabId: string) => void;
  onStripContextMenu?: (e: MouseEvent) => void;
  onReorderTabs?: (tabId: string, toIndex: number) => void;
  onRenameTab?: (tabId: string, title: string) => void;
  /** When set, opens inline rename for that tab once, then calls consume. */
  externalRenameTabId?: string | null;
  onExternalRenameConsumed?: () => void;
}

function getChatTabDropIndex(strip: HTMLElement, clientX: number): number {
  const nodes = strip.querySelectorAll("[data-chat-tab-id]");
  for (let i = 0; i < nodes.length; i++) {
    const r = nodes[i].getBoundingClientRect();
    if (clientX < r.left + r.width / 2) {
      return i;
    }
  }
  return nodes.length;
}

export function ChatTabs({
  tabs,
  agentTabIndicators,
  onSelectTab,
  onCloseTab,
  onNewChat,
  onTabContextMenu,
  onStripContextMenu,
  onReorderTabs,
  onRenameTab,
  externalRenameTabId,
  onExternalRenameConsumed,
}: ChatTabsProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const dragScrollLastTs = useRef(0);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  useTabStripWheel(stripRef, { speed: 2.1 });

  useEffect(() => {
    if (!externalRenameTabId) {
      return;
    }
    const tab = tabs.find((t) => t.id === externalRenameTabId);
    if (tab) {
      setEditingTabId(tab.id);
      setEditValue(tab.title);
    }
    onExternalRenameConsumed?.();
  }, [externalRenameTabId, onExternalRenameConsumed, tabs]);

  useEffect(() => {
    if (!editingTabId) {
      return;
    }
    const t = requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
    return () => cancelAnimationFrame(t);
  }, [editingTabId]);

  function handleStripContextMenu(e: MouseEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    onStripContextMenu?.(e);
  }

  function commitRename() {
    if (!editingTabId) {
      return;
    }
    const tab = tabs.find((t) => t.id === editingTabId);
    const next = editValue.trim();
    setEditingTabId(null);
    if (tab && next && next !== tab.title) {
      onRenameTab?.(editingTabId, next);
    }
  }

  function cancelRename() {
    setEditingTabId(null);
  }

  function handleStripDragOver(e: DragEvent<HTMLDivElement>) {
    const types = [...e.dataTransfer.types];
    if (!types.includes(CHAT_TAB_DND_MIME) || !onReorderTabs) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    const scroller = stripRef.current;
    if (!scroller || scroller.scrollWidth <= scroller.clientWidth + 1) {
      return;
    }
    const now = performance.now();
    if (now - dragScrollLastTs.current < 14) {
      return;
    }
    dragScrollLastTs.current = now;
    const rect = scroller.getBoundingClientRect();
    const x = e.clientX;
    const zone = 64;
    const maxDelta = 56;
    if (x < rect.left + zone) {
      const t = (rect.left + zone - x) / zone;
      scroller.scrollLeft -= maxDelta * t;
    } else if (x > rect.right - zone) {
      const t = (x - (rect.right - zone)) / zone;
      scroller.scrollLeft += maxDelta * t;
    }
  }

  function handleStripDrop(e: DragEvent<HTMLDivElement>) {
    if (!onReorderTabs || !stripRef.current) {
      return;
    }
    const payload = parseChatTabDragPayload(
      e.dataTransfer.getData(CHAT_TAB_DND_MIME)
    );
    if (!payload) {
      return;
    }
    e.preventDefault();
    const toIndex = getChatTabDropIndex(stripRef.current, e.clientX);
    const fromIndex = tabs.findIndex((t) => t.id === payload.tabId);
    if (fromIndex < 0 || toIndex < 0 || toIndex > tabs.length) {
      return;
    }
    if (fromIndex === toIndex) {
      return;
    }
    onReorderTabs(payload.tabId, toIndex);
  }

  function handleTabDragStart(e: DragEvent, tabId: string) {
    if (!onReorderTabs) {
      return;
    }
    e.dataTransfer.setData(CHAT_TAB_DND_MIME, JSON.stringify({ tabId }));
    e.dataTransfer.effectAllowed = "move";
    setMinimalTabDragImage(e.dataTransfer);
  }

  return (
    <div className="flex h-[var(--tab-height)] min-w-0 items-center overflow-hidden">
      <div
        ref={stripRef}
        role="tablist"
        onDragOver={handleStripDragOver}
        onDrop={handleStripDrop}
        onContextMenu={handleStripContextMenu}
        className="hide-scrollbar-x flex min-w-0 flex-1 items-center gap-0 p-[2px]"
      >
        {tabs.map((tab) => {
          const ind = agentTabIndicators?.[tab.id];
          const needsAttention = Boolean(ind?.needsAttention);
          const running = Boolean(ind?.running) && !needsAttention;
          const unreadCompletion =
            Boolean(ind?.unreadCompletion) && !needsAttention && !running;
          const ariaSuffix = needsAttention
            ? ", approval needed"
            : running
              ? ", in progress"
              : unreadCompletion
                ? ", new response"
                : "";
          const showAgentIndicator = needsAttention || running || unreadCompletion;
          const titleMarginClass = showAgentIndicator ? "ml-[4px]" : "ml-[9px]";
          return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            draggable={Boolean(onReorderTabs)}
            onDragStart={(e) => handleTabDragStart(e, tab.id)}
            data-chat-tab-id={tab.id}
            aria-selected={tab.active}
            aria-label={`${tab.title}${ariaSuffix}`}
            onClick={() => onSelectTab(tab.id)}
            onContextMenu={(e) => {
              e.stopPropagation();
              onTabContextMenu?.(e, tab.id);
            }}
            className={`group relative inline-flex h-[36px] max-w-[220px] shrink-0 items-center overflow-hidden rounded-[var(--radius-tab)] transition-colors ${onReorderTabs ? "cursor-grab active:cursor-grabbing" : ""}`}
            style={{
              background: tab.active ? "var(--bg-tab-active)" : "transparent",
            }}
          >
            {showAgentIndicator ? (
              <span className="ml-[6px] flex w-[18px] shrink-0 flex-col items-center justify-center">
                {needsAttention ? (
                  <span
                    className="size-[7px] shrink-0 rounded-full bg-[var(--tab-agent-attention-dot)]"
                    title="Approval or permission needed"
                    aria-hidden
                  />
                ) : unreadCompletion ? (
                  <span
                    className="size-[7px] shrink-0 rounded-full bg-[var(--tab-unread-completion-dot)]"
                    title="New response ready"
                    aria-hidden
                  />
                ) : (
                  <LoaderCircle
                    className="size-[14px] shrink-0 text-[var(--text-secondary)] animate-spin"
                    strokeWidth={1.5}
                    aria-hidden
                  />
                )}
              </span>
            ) : null}
            {editingTabId === tab.id ? (
              <input
                ref={renameInputRef}
                value={editValue}
                aria-label="Tab name"
                className={`${titleMarginClass} min-w-0 flex-1 bg-transparent font-sans text-[14px] font-normal text-[var(--text-secondary)] outline-none`}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={() => commitRename()}
                onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitRename();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
              />
            ) : (
              <span
                className={`${titleMarginClass} min-w-0 flex-1 truncate text-left font-sans text-[14px] font-normal text-[var(--text-secondary)]`}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (!onRenameTab) {
                    return;
                  }
                  setEditingTabId(tab.id);
                  setEditValue(tab.title);
                }}
              >
                {tab.title}
              </span>
            )}
            <div className="relative mr-[6px] flex size-[22px] shrink-0 items-center justify-center">
              <span
                role="button"
                tabIndex={0}
                draggable={false}
                onDragStart={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }
                }}
                className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] opacity-0 transition-opacity hover:text-[var(--text-primary)] group-hover:pointer-events-auto group-hover:opacity-100"
                aria-label={`Close ${tab.title}`}
              >
                <X className="size-[18px]" strokeWidth={1.5} />
              </span>
            </div>
          </button>
        );
        })}
      </div>
      <button
        type="button"
        onClick={onNewChat}
        className="mr-[9px] shrink-0 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        aria-label="New chat"
      >
        <Plus className="size-[18px]" strokeWidth={1.5} />
      </button>
    </div>
  );
}
