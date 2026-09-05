"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** Below this many CSS pixels in either dimension the surface is treated as not visible. */
const MIN_VISIBLE_PX = 48;

/**
 * Mounts `children` only once the wrapper has real on-screen dimensions, and
 * keeps them mounted from then on.
 *
 * The workbench keeps the editor side pane mounted while collapsed (0-5px
 * wide) so imperative bridges, pending open requests and live terminals
 * survive a collapse. Without this guard a persisted file tab in a collapsed
 * pane downloaded and booted Monaco (~1 MB from the CDN) on every landing-page
 * load for an editor nobody could see; the same goes for xterm and the browser
 * tab. Deferring the FIRST mount until the pane is actually shown removes that
 * cost without changing what happens after the pane has been opened once.
 */
export function DeferUntilVisible({
  children,
  placeholder = null,
  className = "relative h-full w-full",
}: {
  children: ReactNode;
  placeholder?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible) {
      return;
    }
    const element = ref.current;
    if (!element) {
      return;
    }
    const isShown = (width: number, height: number) =>
      width >= MIN_VISIBLE_PX && height >= MIN_VISIBLE_PX;
    const initial = element.getBoundingClientRect();
    if (isShown(initial.width, initial.height)) {
      setVisible(true);
      return;
    }
    if (typeof ResizeObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box && isShown(box.width, box.height)) {
        observer.disconnect();
        setVisible(true);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  return (
    <div ref={ref} className={className}>
      {visible ? children : placeholder}
    </div>
  );
}
