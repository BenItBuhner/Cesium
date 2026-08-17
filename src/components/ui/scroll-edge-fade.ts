"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

/**
 * Theme-agnostic edge fades for overflowing content.
 *
 * Instead of painting a solid-color gradient overlay on top of the content
 * (which reads as an opaque bar the moment the surface behind it is not a
 * flat theme color — e.g. the aurora conversation backdrop), these helpers
 * dissolve the content itself to transparent with a CSS `mask-image` on the
 * scrollport. Whatever sits behind the element (aurora, translucent panels,
 * any theme) shows through the faded pixels, so no color is ever involved.
 *
 * Both the standards property and the `-webkit-` prefixed one are set: the
 * mobile WebView pipeline supports Chromium 83, which only understands the
 * prefixed form (unprefixed `mask-image` landed in Chromium 120).
 */

export type VerticalScrollFadeState = { top: boolean; bottom: boolean };
export type HorizontalScrollFadeState = { left: boolean; right: boolean };

export type EdgeFadeInput = {
  top?: boolean;
  bottom?: boolean;
  left?: boolean;
  right?: boolean;
};

export const EDGE_FADE_DEFAULT_PX = 28;

function verticalLayer(fade: EdgeFadeInput, fadePx: number): string | null {
  if (!fade.top && !fade.bottom) {
    return null;
  }
  const stops: string[] = [];
  if (fade.top) {
    stops.push("transparent", `black ${fadePx}px`);
  } else {
    stops.push("black");
  }
  if (fade.bottom) {
    stops.push(`black calc(100% - ${fadePx}px)`, "transparent");
  } else {
    stops.push("black");
  }
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}

function horizontalLayer(fade: EdgeFadeInput, fadePx: number): string | null {
  if (!fade.left && !fade.right) {
    return null;
  }
  const stops: string[] = [];
  if (fade.left) {
    stops.push("transparent", `black ${fadePx}px`);
  } else {
    stops.push("black");
  }
  if (fade.right) {
    stops.push(`black calc(100% - ${fadePx}px)`, "transparent");
  } else {
    stops.push("black");
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

/**
 * Build the `mask-image` value for the requested edges, or `null` when no
 * edge is active. Multiple axes come back as two comma-separated layers that
 * must be combined with `mask-composite: intersect`.
 */
export function edgeFadeMaskImage(
  fade: EdgeFadeInput,
  fadePx: number = EDGE_FADE_DEFAULT_PX
): { image: string; layers: number } | null {
  const layers = [verticalLayer(fade, fadePx), horizontalLayer(fade, fadePx)].filter(
    (layer): layer is string => layer != null
  );
  if (layers.length === 0) {
    return null;
  }
  return { image: layers.join(", "), layers: layers.length };
}

/**
 * Inline style for React elements: apply directly to the scrollport (the
 * element that paints the overflowing content), NOT to an overlay.
 */
export function edgeFadeMaskStyle(
  fade: EdgeFadeInput,
  fadePx: number = EDGE_FADE_DEFAULT_PX
): CSSProperties {
  const mask = edgeFadeMaskImage(fade, fadePx);
  if (!mask) {
    return {};
  }
  const style: CSSProperties = {
    maskImage: mask.image,
    WebkitMaskImage: mask.image,
  };
  if (mask.layers > 1) {
    // Multiply the two axes' alphas so corners fade in both directions.
    style.maskComposite = "intersect";
    style.WebkitMaskComposite = "source-in";
  }
  return style;
}

/**
 * Imperative variant for scroll handlers that bypass React state for
 * performance (direct DOM writes, e.g. the workspace rail conversation list).
 */
export function applyEdgeFadeMask(
  el: HTMLElement,
  fade: EdgeFadeInput,
  fadePx: number = EDGE_FADE_DEFAULT_PX
): void {
  const mask = edgeFadeMaskImage(fade, fadePx);
  if (!mask) {
    el.style.removeProperty("mask-image");
    el.style.removeProperty("-webkit-mask-image");
    el.style.removeProperty("mask-composite");
    el.style.removeProperty("-webkit-mask-composite");
    return;
  }
  el.style.setProperty("mask-image", mask.image);
  el.style.setProperty("-webkit-mask-image", mask.image);
  if (mask.layers > 1) {
    el.style.setProperty("mask-composite", "intersect");
    el.style.setProperty("-webkit-mask-composite", "source-in");
  } else {
    el.style.removeProperty("mask-composite");
    el.style.removeProperty("-webkit-mask-composite");
  }
}

/** Shared overflow thresholds (2px slack absorbs subpixel scroll rounding). */
export function verticalFadeState(el: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): VerticalScrollFadeState {
  const maxScrollY = el.scrollHeight - el.clientHeight;
  return {
    top: el.scrollTop > 2,
    bottom: maxScrollY > 2 && el.scrollTop < maxScrollY - 2,
  };
}

export function horizontalFadeState(el: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}): HorizontalScrollFadeState {
  const maxScrollX = el.scrollWidth - el.clientWidth;
  return {
    left: el.scrollLeft > 2,
    right: maxScrollX > 2 && el.scrollLeft < maxScrollX - 2,
  };
}

/**
 * Track top/bottom fade state for a vertically scrollable element. Re-measures
 * on resize and whenever `measureKey` changes (content length, filters, …).
 * Wire the returned `update` to the element's `onScroll`.
 */
export function useVerticalScrollEdgeFade(
  scrollRef: RefObject<HTMLElement | null>,
  measureKey?: string | number | boolean | null
): { fade: VerticalScrollFadeState; update: () => void } {
  const [fade, setFade] = useState<VerticalScrollFadeState>({
    top: false,
    bottom: false,
  });

  const update = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    setFade(verticalFadeState(el));
  }, [scrollRef]);

  useLayoutEffect(() => {
    update();
  }, [measureKey, update]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollRef, update]);

  return { fade, update };
}

/** Horizontal counterpart of {@link useVerticalScrollEdgeFade}. */
export function useHorizontalScrollEdgeFade(
  scrollRef: RefObject<HTMLElement | null>,
  measureKey?: string | number | boolean | null
): { fade: HorizontalScrollFadeState; update: () => void } {
  const [fade, setFade] = useState<HorizontalScrollFadeState>({
    left: false,
    right: false,
  });

  const update = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    setFade(horizontalFadeState(el));
  }, [scrollRef]);

  useLayoutEffect(() => {
    update();
  }, [measureKey, update]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollRef, update]);

  return { fade, update };
}

/**
 * Publish an element's live height as a CSS custom property on its parent, so
 * a sibling's mask can track it (e.g. the chat bottom dock height feeding the
 * message list's bottom dissolve). Cleans the property up when detached.
 */
export function useHeightCssVarRef(varName: string): (el: HTMLElement | null) => void {
  const cleanupRef = useRef<(() => void) | null>(null);

  return useCallback(
    (el: HTMLElement | null) => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (!el) {
        return;
      }
      const parent = el.parentElement;
      if (!parent) {
        return;
      }
      const publish = () => {
        parent.style.setProperty(varName, `${el.offsetHeight}px`);
      };
      publish();
      if (typeof ResizeObserver === "undefined") {
        cleanupRef.current = () => parent.style.removeProperty(varName);
        return;
      }
      const ro = new ResizeObserver(publish);
      ro.observe(el);
      cleanupRef.current = () => {
        ro.disconnect();
        parent.style.removeProperty(varName);
      };
    },
    [varName]
  );
}
