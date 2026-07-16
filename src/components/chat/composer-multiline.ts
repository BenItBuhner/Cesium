"use client";

import { useEffect, useState, type RefObject } from "react";

/**
 * We flip to multi-line once the editor's *content* (scrollHeight minus
 * padding and min-height) exceeds ~1.5× the computed line-height. Using
 * content-only height avoids false positives from `min-height` pins that keep
 * the box visually tall even when the text is a single line.
 */
const MULTILINE_RATIO = 1.5;

/** Fallback line-height if `getComputedStyle` hasn't latched yet (e.g. SSR hydration). */
const DEFAULT_LINE_HEIGHT_PX = 20;

function readFirstPxNumber(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readLineHeightPx(style: CSSStyleDeclaration): number {
  return readFirstPxNumber(style.lineHeight, DEFAULT_LINE_HEIGHT_PX);
}

function readContentHeightPx(el: HTMLElement): number {
  const style = getComputedStyle(el);
  const paddingTop = readFirstPxNumber(style.paddingTop, 0);
  const paddingBottom = readFirstPxNumber(style.paddingBottom, 0);
  const contentHeight = el.scrollHeight - paddingTop - paddingBottom;
  if (!Number.isFinite(contentHeight) || contentHeight <= 0) {
    return 0;
  }
  return contentHeight;
}

export function measureComposerVisualLineCount(el: HTMLElement): number {
  const style = getComputedStyle(el);
  const lineHeight = readLineHeightPx(style);
  const contentHeight = readContentHeightPx(el);
  if (contentHeight <= 0) {
    return 1;
  }
  return Math.max(1, Math.round(contentHeight / lineHeight));
}

export function measureIsMultiLine(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  const lineHeight = readLineHeightPx(style);
  const contentHeight = readContentHeightPx(el);
  if (contentHeight <= 0) {
    return false;
  }
  return contentHeight > lineHeight * MULTILINE_RATIO;
}

/**
 * Watches a contenteditable (or any block) for wrap transitions. Returns `true`
 * once the content occupies more than a single visual line. Safe in SSR: the
 * hook no-ops until the ref attaches on the client.
 */
export function useComposerTextIsMultiLine(
  ref: RefObject<HTMLElement | null>
): boolean {
  const [isMultiLine, setIsMultiLine] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }

    const update = () => {
      const next = measureIsMultiLine(el);
      setIsMultiLine((prev) => (prev === next ? prev : next));
    };

    update();

    // Fires for both container width changes and content-driven height changes
    // since the editor's box is sized by its text content.
    const observer = new ResizeObserver(update);
    observer.observe(el);

    // `input` is the only reliable signal for contenteditable text edits that
    // do not alter box size (e.g. inserting a soft-break right at the wrap
    // threshold). ResizeObserver would otherwise miss same-height transitions.
    el.addEventListener("input", update);

    return () => {
      observer.disconnect();
      el.removeEventListener("input", update);
    };
    // We intentionally depend on the ref object identity; the caller passes a
    // stable ref, so this runs once on mount per-ref.
  }, [ref]);

  return isMultiLine;
}

/**
 * Estimates wrapped visual line count for the composer editor (soft breaks + wrap).
 */
export function useComposerVisualLineCount(
  ref: RefObject<HTMLElement | null>
): number {
  const [lineCount, setLineCount] = useState(1);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }

    const update = () => {
      const next = measureComposerVisualLineCount(el);
      setLineCount((prev) => (prev === next ? prev : next));
    };

    update();

    const observer = new ResizeObserver(update);
    observer.observe(el);
    el.addEventListener("input", update);

    return () => {
      observer.disconnect();
      el.removeEventListener("input", update);
    };
  }, [ref]);

  return lineCount;
}
