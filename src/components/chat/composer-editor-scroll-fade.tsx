"use client";

import { useCallback, useLayoutEffect, useState, type RefObject } from "react";

export type ComposerEditorScrollFade = {
  top: boolean;
  bottom: boolean;
};

/**
 * Vertical edge fades for a scrollable composer editor — same threshold math as
 * `AgentRailConversationListScroll` in `AgentWorkspaceRail.tsx`.
 */
export function useComposerEditorScrollFade(
  scrollRef: RefObject<HTMLElement | null>,
  measureKey: string | number
): { fade: ComposerEditorScrollFade; onScroll: () => void } {
  const [fade, setFade] = useState<ComposerEditorScrollFade>({
    top: false,
    bottom: false,
  });

  const updateFade = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const { scrollTop, scrollHeight, clientHeight } = el;
    const maxScrollY = scrollHeight - clientHeight;
    setFade({
      top: scrollTop > 2,
      bottom: maxScrollY > 2 && scrollTop < maxScrollY - 2,
    });
  }, [scrollRef]);

  useLayoutEffect(() => {
    updateFade();
  }, [measureKey, updateFade]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver(() => updateFade());
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollRef, measureKey, updateFade]);

  return { fade, onScroll: updateFade };
}

export function ComposerEditorScrollFades({
  fade,
  edgeVar = "var(--agent-card-bg)",
}: {
  fade: ComposerEditorScrollFade;
  /** Must match the solid surface behind the scrolling editor (composer pill vs expanded shell). */
  edgeVar?: string;
}) {
  const gradTop = `linear-gradient(to bottom, ${edgeVar}, transparent)`;
  const gradBottom = `linear-gradient(to top, ${edgeVar}, transparent)`;

  return (
    <>
      {fade.top ? (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-[2] h-[28px]"
          style={{ backgroundImage: gradTop }}
          aria-hidden
        />
      ) : null}
      {fade.bottom ? (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] h-[28px]"
          style={{ backgroundImage: gradBottom }}
          aria-hidden
        />
      ) : null}
    </>
  );
}
