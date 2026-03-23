import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { ChatMessage } from "@/lib/types";

/** How far (px) before the anchor the previous user header begins sliding up. Larger = more gradual. */
const PUSH_ZONE_PX = 220;
/** Offset below the scroll area’s inner top so the next bubble meets the rail with a little air. */
const ANCHOR_INSET_PX = 10;

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
  const rafRef = useRef<number | null>(null);

  const flush = useCallback(() => {
    const root = scrollRootRef?.current;
    const map = stickyRefs.current;
    if (!root || !enabled || userTurnCount < 2) {
      setPushByOrder({});
      return;
    }

    const cs = getComputedStyle(root);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const rootRect = root.getBoundingClientRect();
    const anchorY = rootRect.top + padTop + ANCHOR_INSET_PX;

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
      next[o - 1] = push;
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
  }, [enabled, scrollRootRef, stickyRefs, userTurnCount]);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      flush();
    });
  }, [flush]);

  useLayoutEffect(() => {
    scheduleFlush();
  }, [messages, scheduleFlush]);

  useEffect(() => {
    if (!scrollRootRef || !enabled || userTurnCount < 2) {
      setPushByOrder({});
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
  }, [enabled, scrollRootRef, userTurnCount, scheduleFlush]);

  const wired = enabled && !!scrollRootRef;

  const getter = useCallback(
    (order: number) => (wired ? pushByOrder[order] ?? 0 : 0),
    [wired, pushByOrder]
  );

  return getter;
}
