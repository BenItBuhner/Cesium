"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useComposerEditorScrollFade } from "./composer-editor-scroll-fade";
import { MessageThreadContent } from "./MessageThreadContent";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import type { ChatMessage } from "@/lib/types";
import type { ChatScrollAnchor } from "@/lib/workspace-session";

export type MessageListScrollPersistMeta = {
  pinnedToBottom: boolean;
  anchor?: { messageId: string; delta: number };
};

function inferTranscriptSessionId(messages: ChatMessage[]): string | undefined {
  for (const message of messages) {
    const match = message.id.match(/(ses_[A-Za-z0-9]+)/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

/** Fallback scrollport height when `clientHeight` is not yet measured. */
const OLDER_SCROLLPORT_FALLBACK_PX = 900;

function olderPrefetchScrollTopPx(root: HTMLDivElement): number {
  const ch = root.clientHeight > 0 ? root.clientHeight : OLDER_SCROLLPORT_FALLBACK_PX;
  return Math.max(760, Math.min(3600, Math.floor(ch * 1.5)));
}

function olderChainScrollTopPx(root: HTMLDivElement): number {
  const ch = root.clientHeight > 0 ? root.clientHeight : OLDER_SCROLLPORT_FALLBACK_PX;
  return Math.max(320, Math.min(2200, Math.floor(ch * 0.42)));
}

function olderGateReleaseScrollTopPx(prefetchPx: number): number {
  return Math.max(380, prefetchPx - 480);
}

/** Max automatic "fill the viewport" history rounds per conversation (burst prefetch at bottom). */
const OLDER_AUTO_FILL_MAX_ROUNDS = 28;
/** Minimum excess scroll height (beyond viewport) before we stop auto-prefetching at the bottom. */
function olderMinBottomSlackPx(root: HTMLDivElement): number {
  const ch = root.clientHeight > 0 ? root.clientHeight : OLDER_SCROLLPORT_FALLBACK_PX;
  return Math.max(960, Math.floor(ch * 1.2));
}

interface MessageListProps {
  messages: ChatMessage[];
  initialScrollTop?: number;
  initialScrollAnchor?: ChatScrollAnchor;
  onScrollTopSettled?: (
    scrollTop: number,
    meta: MessageListScrollPersistMeta
  ) => void;
  onResolvePermission?: (requestId: string, optionId: string) => void;
  onCancelPermission?: (requestId: string) => void;
  onForkMessage?: (messageId: string) => void;
  onRedoMessage?: (message: ChatMessage) => void;
  renderUserMessageEditor?: (message: ChatMessage) => ReactNode;
  editingUserMessageId?: string | null;
  bottomDockVisible?: boolean;
  surface?: "panel" | "editor";
  contentClassName?: string;
  conversationId?: string;
  conversationBusy?: boolean;
  /** Bound to the active conversation composer draft for cite-from-selection. */
  composerDraftId?: string | null;
  /** Paginated history: request older events when user scrolls near the top. */
  onRequestOlderHistory?: () => void;
  hasOlderHistory?: boolean;
  loadingOlderHistory?: boolean;
}

export function MessageList({
  messages,
  initialScrollTop = 0,
  initialScrollAnchor: _initialScrollAnchor,
  onScrollTopSettled,
  onResolvePermission,
  onCancelPermission,
  onForkMessage,
  onRedoMessage,
  renderUserMessageEditor,
  editingUserMessageId,
  bottomDockVisible = true,
  surface = "panel",
  contentClassName,
  conversationId,
  conversationBusy = false,
  composerDraftId,
  onRequestOlderHistory,
  hasOlderHistory = false,
  loadingOlderHistory = false,
}: MessageListProps) {
  const { openSubagentTranscript } = useOpenInEditor();
  const { workspaceSession, updateWorkspaceSession, workspaceInfo } = useWorkspace();
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
  const autoHistoryFillRoundsRef = useRef(0);

  const useVirtualThread = useMemo(() => messages.length >= 16, [messages.length]);

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
    onScrollTopSettled(nextScrollTop, {
      pinnedToBottom: Boolean(stickToBottomRef.current),
    });
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
    autoHistoryFillRoundsRef.current = 0;
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
        const chainPx = olderChainScrollTopPx(root);
        if (root.scrollTop <= chainPx) {
          onRequestOlderHistory();
        }
      });
    });

    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [loadingOlderHistory, hasOlderHistory, onRequestOlderHistory]);

  /**
   * While the user stays pinned to the bottom, keep requesting older pages until the transcript
   * is taller than the viewport (or we hit a safety cap). Preloaded history is invisible until
   * they scroll up, but avoids a long train of manual pagination after opening a chat.
   */
  useEffect(() => {
    if (!onRequestOlderHistory || !hasOlderHistory || loadingOlderHistory) {
      return;
    }
    const root = scrollRootRef.current;
    if (!root || root.clientHeight < 80) {
      return;
    }
    if (!stickToBottomRef.current) {
      return;
    }
    if (autoHistoryFillRoundsRef.current >= OLDER_AUTO_FILL_MAX_ROUNDS) {
      return;
    }
    const slack = root.scrollHeight - root.clientHeight;
    if (slack >= olderMinBottomSlackPx(root)) {
      return;
    }
    let raf = 0;
    raf = window.requestAnimationFrame(() => {
      if (
        !onRequestOlderHistory ||
        !hasOlderHistory ||
        loadingOlderHistory ||
        !stickToBottomRef.current
      ) {
        return;
      }
      const r = scrollRootRef.current;
      if (!r || r.clientHeight < 80) {
        return;
      }
      if (r.scrollHeight - r.clientHeight >= olderMinBottomSlackPx(r)) {
        return;
      }
      autoHistoryFillRoundsRef.current += 1;
      onRequestOlderHistory();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [
    conversationId,
    hasOlderHistory,
    loadingOlderHistory,
    messages.length,
    onRequestOlderHistory,
  ]);

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
      stickyUserHeader
      scrollRootRef={scrollRootRef}
      workedSessionSurface={surface}
      virtualize={useVirtualThread}
      onResolvePermission={onResolvePermission}
      onForkMessage={onForkMessage}
      onRedoMessage={onRedoMessage}
      renderUserMessageEditor={renderUserMessageEditor}
      editingUserMessageId={editingUserMessageId}
      composerDraftId={composerDraftId}
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
      workspaceRoot={workspaceInfo?.root ?? null}
    />
  );

  /** Top padding lives here, not on the scroll root, so `position: sticky` + `top` is not
   *  stacked with scroll-container padding (which reads ~20px low in Blink/WebKit). */
  const innerClass =
    contentClassName && contentClassName.length > 0
      ? `pt-[10px] ${contentClassName}`
      : "pt-[10px]";

  const fadeMeasureKey = `${messages.length}:${bottomDockVisible ? 1 : 0}:${loadingOlderHistory ? 1 : 0}`;
  const { fade, onScroll: updateScrollFade } = useComposerEditorScrollFade(
    scrollRootRef,
    fadeMeasureKey
  );
  const scrollFadeEdgeVar = surface === "editor" ? "var(--bg-main)" : "var(--bg-panel)";
  const scrollFadeGradTop = `linear-gradient(to bottom, ${scrollFadeEdgeVar}, transparent)`;
  const scrollFadeGradBottom = `linear-gradient(to top, ${scrollFadeEdgeVar}, transparent)`;

  /**
   * Horizontal scroll inset follows the **pane** width (`@container`), not the viewport.
   * Uses **481px** so normal split/center panes keep the legacy 10px strip; `AGENT_CENTER_CONTENT_CLASS`
   * separately drops the centered `max-w` gutter only when the pane is **≤640px** so you don’t stack both.
   */
  const scrollPadX =
    contentClassName && contentClassName.length > 0
      ? "pl-[max(0px,env(safe-area-inset-left,0px))] pr-[max(0px,env(safe-area-inset-right,0px))] @min-[481px]:pl-[max(10px,env(safe-area-inset-left,0px))] @min-[481px]:pr-[max(10px,env(safe-area-inset-right,0px))]"
      : "pl-[max(0px,env(safe-area-inset-left,0px))] pr-[max(0px,env(safe-area-inset-right,0px))] @min-[481px]:px-[10px]";

  return (
    <div className="@container relative h-full min-w-0 w-full">
      <div
        ref={scrollRootRef}
        data-chat-scroll-root
        className={`absolute inset-0 overflow-y-auto overflow-x-hidden overscroll-y-contain ${scrollPadX} [-webkit-overflow-scrolling:touch] hide-scrollbar-y ${
          bottomDockVisible ? "pb-[clamp(160px,24vh,240px)]" : "pb-[14px]"
        }`}
        onScroll={(event) => {
          const root = event.currentTarget;
          updateScrollFade();
          const scrollTop = root.scrollTop;
          stickToBottomRef.current = isNearBottom(root);
          pendingScrollTopRef.current = Math.round(scrollTop);
          scrollSnapshotRef.current = { sh: root.scrollHeight, st: scrollTop };
          schedulePersistedScrollTop();

          const prefetchPx = olderPrefetchScrollTopPx(root);
          const releasePx = olderGateReleaseScrollTopPx(prefetchPx);
          if (
            onRequestOlderHistory &&
            hasOlderHistory &&
            !loadingOlderHistory &&
            scrollTop < prefetchPx
          ) {
            if (!olderLoadGateRef.current) {
              olderLoadGateRef.current = true;
              onRequestOlderHistory();
            }
          } else if (scrollTop > releasePx) {
            olderLoadGateRef.current = false;
          }
        }}
      >
        {fade.top ? (
          <div
            className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-[28px]"
            style={{ backgroundImage: scrollFadeGradTop }}
            aria-hidden
          />
        ) : null}
        {fade.bottom ? (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-[28px]"
            style={{ backgroundImage: scrollFadeGradBottom }}
            aria-hidden
          />
        ) : null}
        <div className={`relative z-[2] ${innerClass}`}>
          {loadingOlderHistory ? (
            <div className="mb-[10px] rounded-[var(--radius-tab)] bg-[var(--bg-card)] px-[10px] py-[6px] font-sans text-[12px] text-[var(--text-secondary)]">
              Loading older messages…
            </div>
          ) : null}
          {thread}
        </div>
      </div>
    </div>
  );
}
