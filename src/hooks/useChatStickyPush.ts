import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { ChatMessage } from "@/lib/types";
import { CHAT_STICKY_RAIL_INSET_PX } from "@/components/chat/chat-sticky-rail";

/** How far (px) before the anchor the previous user header begins sliding up. Larger = more gradual. */
const PUSH_ZONE_PX = 220;

function supportsAnimatedStickyPush(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function clearPushByOrder(
  setPushByOrder: Dispatch<SetStateAction<Record<number, number>>>
): void {
  setPushByOrder((prev) => (Object.keys(prev).length === 0 ? prev : {}));
}

function countUserTurns(messages: ChatMessage[]): number {
  let c = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].type !== "user") continue;
    c++;
    if (messages[i + 1]?.type === "todo-status") i++;
  }
  return c;
}

function smoothstep01(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * While user N scrolls toward the top rail, progressively move user N−1’s sticky header up
 * (negative `top`) so the handoff reads like a push instead of painting on top.
 */
export function useChatStickyPush(
  scrollRootRef: RefObject<HTMLElement | null> | undefined,
  stickyRefs: RefObject<Map<number, HTMLElement>>,
  messages: ChatMessage[],
  enabled: boolean
): (order: number) => number {
  const userTurnCount = useMemo(() => countUserTurns(messages), [messages]);
  const [pushByOrder, setPushByOrder] = useState<Record<number, number>>({});
  const [allowAnimatedPush, setAllowAnimatedPush] = useState(supportsAnimatedStickyPush);
  const rafRef = useRef<number | null>(null);
  const animatedPushEnabled = enabled && allowAnimatedPush;

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      setAllowAnimatedPush(!mediaQuery.matches);
    };
    sync();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", sync);
      return () => mediaQuery.removeEventListener("change", sync);
    }
    mediaQuery.addListener(sync);
    return () => mediaQuery.removeListener(sync);
  }, []);

  const flush = useCallback(() => {
    const root = scrollRootRef?.current;
    const map = stickyRefs.current;
    if (!root || !animatedPushEnabled || userTurnCount < 2) {
      clearPushByOrder(setPushByOrder);
      return;
    }

    const rootRect = root.getBoundingClientRect();
    // Sticky `top` is relative to the scrollport (padding box), not the content box after padding-top.
    const anchorY = rootRect.top + root.clientTop + CHAT_STICKY_RAIL_INSET_PX;

    const next: Record<number, number> = {};
    for (let o = 1; o < userTurnCount; o++) {
      const prevEl = map.get(o - 1);
      const currEl = map.get(o);
      if (!prevEl || !currEl) continue;

      const prevH = prevEl.offsetHeight;
      if (prevH <= 0) continue;

      const dist = currEl.getBoundingClientRect().top - anchorY;
      let push = 0;
      if (dist >= PUSH_ZONE_PX) {
        push = 0;
      } else if (dist <= 0) {
        push = prevH;
      } else {
        const rawT = (PUSH_ZONE_PX - dist) / PUSH_ZONE_PX;
        push = smoothstep01(rawT) * prevH;
      }
      next[o - 1] = Math.round(push);
    }

    setPushByOrder((prev) => {
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(next);
      if (prevKeys.length !== nextKeys.length) return next;
      for (const k of nextKeys) {
        const n = Number(k);
        if ((prev[n] ?? 0) !== (next[n] ?? 0)) return next;
      }
      return prev;
    });
  }, [animatedPushEnabled, scrollRootRef, stickyRefs, userTurnCount]);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      flush();
    });
  }, [flush]);

  useLayoutEffect(() => {
    if (!animatedPushEnabled) {
      return;
    }
    scheduleFlush();
  }, [animatedPushEnabled, messages, scheduleFlush]);

  useEffect(() => {
    if (!scrollRootRef || !animatedPushEnabled || userTurnCount < 2) {
      clearPushByOrder(setPushByOrder);
      return;
    }

    const root = scrollRootRef.current;
    if (!root) return;

    scheduleFlush();
    root.addEventListener("scroll", scheduleFlush, { passive: true });
    window.addEventListener("resize", scheduleFlush);

    return () => {
      root.removeEventListener("scroll", scheduleFlush);
      window.removeEventListener("resize", scheduleFlush);
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [animatedPushEnabled, scrollRootRef, userTurnCount, scheduleFlush]);

  const wired = animatedPushEnabled && !!scrollRootRef;

  const getter = useCallback(
    (order: number) => (wired ? pushByOrder[order] ?? 0 : 0),
    [wired, pushByOrder]
  );

  return getter;
}
