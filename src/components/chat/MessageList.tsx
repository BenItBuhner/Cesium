"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { MessageThreadContent } from "./MessageThreadContent";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
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

/** Start loading the previous page before the user hits the top edge. */
const OLDER_PREFETCH_SCROLL_TOP_PX = 420;
/** After a history page finishes, auto-chain another fetch if we are still pinned near the top. */
const OLDER_CHAIN_SCROLL_TOP_PX = 96;
/** Release the one-shot load gate after the user scrolls away from the top band. */
const OLDER_GATE_RELEASE_SCROLL_TOP_PX = 200;

interface MessageListProps {
  messages: ChatMessage[];
  initialScrollTop?: number;
  onScrollTopSettled?: (scrollTop: number) => void;
  onResolvePermission?: (requestId: string, optionId: string) => void;
  onCancelPermission?: (requestId: string) => void;
  bottomDockVisible?: boolean;
  surface?: "panel" | "editor";
  contentClassName?: string;
  conversationId?: string;
  conversationBusy?: boolean;
  /** Paginated history: request older events when user scrolls near the top. */
  onRequestOlderHistory?: () => void;
  hasOlderHistory?: boolean;
  loadingOlderHistory?: boolean;
}

export function MessageList({
  messages,
  initialScrollTop = 0,
  onScrollTopSettled,
  onResolvePermission,
  onCancelPermission,
  bottomDockVisible = true,
  surface = "panel",
  contentClassName,
  conversationId,
  conversationBusy = false,
  onRequestOlderHistory,
  hasOlderHistory = false,
  loadingOlderHistory = false,
}: MessageListProps) {
  const { openSubagentTranscript } = useOpenInEditor();
  const { workspaceSession, updateWorkspaceSession } = useWorkspace();
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const initialScrollTopRef = useRef(initialScrollTop);
  const persistTimerRef = useRef<number | null>(null);
  const pendingScrollTopRef = useRef(initialScrollTop);
  const persistedScrollTopRef = useRef<number | null>(null);
  const olderLoadGateRef = useRef(false);
  /** Last measured scrollport geometry; kept fresh in `onScroll` so prepends can anchor correctly. */
  const scrollSnapshotRef = useRef({ sh: 0, st: 0 });
  const prevFirstMessageIdRef = useRef<string | undefined>(undefined);
  const prevMessageLenRef = useRef(0);
  const prevLoadingOlderRef = useRef(false);
  const prevConversationIdRef = useRef<string | undefined>(undefined);
  const wasLoadingOlderHistoryRef = useRef(false);

  const useVirtualThread = useMemo(() => messages.length >= 40, [messages.length]);
  const stickyUserHeaderEffective = !useVirtualThread;

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
    scrollSnapshotRef.current = { sh: root.scrollHeight, st: root.scrollTop };
  }, []);

  useLayoutEffect(() => {
    const root = scrollRootRef.current;
    if (!root) return;

    if (prevConversationIdRef.current !== conversationId) {
      prevConversationIdRef.current = conversationId;
      prevFirstMessageIdRef.current = messages[0]?.id;
      prevMessageLenRef.current = messages.length;
      prevLoadingOlderRef.current = loadingOlderHistory;
      scrollSnapshotRef.current = { sh: root.scrollHeight, st: root.scrollTop };
      return;
    }

    let snapshot = scrollSnapshotRef.current;
    if (snapshot.sh <= 0 && root.scrollHeight > 0) {
      scrollSnapshotRef.current = { sh: root.scrollHeight, st: root.scrollTop };
      prevFirstMessageIdRef.current = messages[0]?.id;
      prevMessageLenRef.current = messages.length;
      prevLoadingOlderRef.current = loadingOlderHistory;
      return;
    }
    snapshot = scrollSnapshotRef.current;
    const firstId = messages[0]?.id;
    const len = messages.length;
    const prevFirst = prevFirstMessageIdRef.current;
    const prevLen = prevMessageLenRef.current;
    const prevLoading = prevLoadingOlderRef.current;

    const prepended =
      prevLen > 0 && firstId !== undefined && firstId !== prevFirst;
    const loaderAppeared = loadingOlderHistory && !prevLoading;
    const loaderRemoved = !loadingOlderHistory && prevLoading;

    let anchorTopDelta = false;
    if (!stickToBottomRef.current) {
      if (prepended || loaderAppeared) {
        anchorTopDelta = true;
      } else if (loaderRemoved && !prepended) {
        anchorTopDelta = true;
      }
    }

    if (anchorTopDelta) {
      const delta = root.scrollHeight - snapshot.sh;
      if (Math.abs(delta) > 0.5) {
        root.scrollTop = snapshot.st + delta;
        pendingScrollTopRef.current = Math.round(root.scrollTop);
      }
    }

    prevFirstMessageIdRef.current = firstId;
    prevMessageLenRef.current = len;
    prevLoadingOlderRef.current = loadingOlderHistory;
    scrollSnapshotRef.current = { sh: root.scrollHeight, st: root.scrollTop };
  }, [messages, loadingOlderHistory, conversationId]);

  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root || !stickToBottomRef.current) {
      return;
    }
    root.scrollTop = root.scrollHeight;
  }, [messages]);

  useEffect(() => {
    wasLoadingOlderHistoryRef.current = false;
    olderLoadGateRef.current = false;
  }, [conversationId]);

  useEffect(() => {
    if (loadingOlderHistory) {
      wasLoadingOlderHistoryRef.current = true;
      return;
    }

    olderLoadGateRef.current = false;

    if (!wasLoadingOlderHistoryRef.current) {
      return;
    }
    wasLoadingOlderHistoryRef.current = false;

    if (!onRequestOlderHistory || !hasOlderHistory) {
      return;
    }

    const root = scrollRootRef.current;
    if (!root) {
      return;
    }

    let raf1 = 0;
    let raf2 = 0;
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        scrollSnapshotRef.current = { sh: root.scrollHeight, st: root.scrollTop };
        if (stickToBottomRef.current) {
          return;
        }
        if (root.scrollTop <= OLDER_CHAIN_SCROLL_TOP_PX) {
          onRequestOlderHistory();
        }
      });
    });

    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [loadingOlderHistory, hasOlderHistory, onRequestOlderHistory]);

  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) {
        root.scrollTop = root.scrollHeight;
      }
      scrollSnapshotRef.current = { sh: root.scrollHeight, st: root.scrollTop };
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

  const workedMap = workspaceSession.chat.workedSessionOpenByScopedId ?? {};
  const setWorkedOpen = useCallback(
    (scopedKey: string, open: boolean) => {
      updateWorkspaceSession((current) => {
        const prev = current.chat.workedSessionOpenByScopedId ?? {};
        if (prev[scopedKey] === open) {
          return current;
        }
        return {
          ...current,
          chat: {
            ...current.chat,
            workedSessionOpenByScopedId: {
              ...prev,
              [scopedKey]: open,
            },
          },
        };
      });
    },
    [updateWorkspaceSession]
  );

  const thread = (
    <MessageThreadContent
      messages={messages}
      stickyUserHeader={stickyUserHeaderEffective}
      scrollRootRef={scrollRootRef}
      workedSessionSurface={surface}
      virtualize={useVirtualThread}
      onResolvePermission={onResolvePermission}
      onCancelPermission={onCancelPermission}
      conversationId={conversationId}
      conversationBusy={conversationBusy}
      workedSessionOpenByScopedId={conversationId ? workedMap : undefined}
      onWorkedSessionOpenChange={conversationId ? setWorkedOpen : undefined}
      onOpenSubagent={({ title, transcript, sessionId }) =>
        openSubagentTranscript({
          title,
          messages: transcript,
          sessionId: sessionId ?? inferTranscriptSessionId(transcript),
        })
      }
    />
  );

  /** Top padding lives here, not on the scroll root, so `position: sticky` + `top` is not
   *  stacked with scroll-container padding (which reads ~20px low in Blink/WebKit). */
  const innerClass =
    contentClassName && contentClassName.length > 0
      ? `pt-[10px] ${contentClassName}`
      : "pt-[10px]";

  /**
   * With a centered content column: no extra scroll inset on narrow viewports (avoids double
   * gutter with `max-w`); from `sm` up, restore the legacy `10px` scroll inset for wide layouts.
   */
  const scrollPadX =
    contentClassName && contentClassName.length > 0
      ? "pl-[max(0px,env(safe-area-inset-left,0px))] pr-[max(0px,env(safe-area-inset-right,0px))] sm:pl-[max(10px,env(safe-area-inset-left,0px))] sm:pr-[max(10px,env(safe-area-inset-right,0px))]"
      : "px-[10px]";

  return (
    <div
      ref={scrollRootRef}
      data-chat-scroll-root
      className={`absolute inset-0 overflow-y-auto overflow-x-hidden overscroll-y-contain ${scrollPadX} [-webkit-overflow-scrolling:touch] hide-scrollbar-y ${
        bottomDockVisible ? "pb-[clamp(220px,38vh,340px)]" : "pb-[14px]"
      }`}
      onScroll={(event) => {
        const root = event.currentTarget;
        const scrollTop = root.scrollTop;
        stickToBottomRef.current = isNearBottom(root);
        pendingScrollTopRef.current = Math.round(scrollTop);
        scrollSnapshotRef.current = { sh: root.scrollHeight, st: scrollTop };
        schedulePersistedScrollTop();

        if (
          onRequestOlderHistory &&
          hasOlderHistory &&
          !loadingOlderHistory &&
          scrollTop < OLDER_PREFETCH_SCROLL_TOP_PX
        ) {
          if (!olderLoadGateRef.current) {
            olderLoadGateRef.current = true;
            onRequestOlderHistory();
          }
        } else if (scrollTop > OLDER_GATE_RELEASE_SCROLL_TOP_PX) {
          olderLoadGateRef.current = false;
        }
      }}
    >
      <div className={innerClass}>
        {loadingOlderHistory ? (
          <div className="mb-[10px] rounded-[var(--radius-tab)] bg-[var(--bg-card)] px-[10px] py-[6px] font-sans text-[12px] text-[var(--text-secondary)]">
            Loading older messages…
          </div>
        ) : null}
        {thread}
      </div>
    </div>
  );
}
