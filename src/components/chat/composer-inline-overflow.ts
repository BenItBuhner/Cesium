"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Minimum editor width the single-line capsule must preserve before overflow
 * handling engages. Wide enough to read a few words of input; small enough
 * that overflow only triggers when the controls genuinely crowd the row.
 */
export const COMPOSER_INLINE_MIN_EDITOR_WIDTH_PX = 96;

/**
 * When the docked single-line composer's controls (mode chip + model pill +
 * action buttons) would squeeze the editor below a usable width — e.g. long
 * model names on phone-width panes — the mode chip and model trigger collapse
 * to icon-only pills so the capsule stays a single line.
 *
 * Compaction only applies while the layout is still single-line; once content
 * itself wraps (or `forceMultiline` is set) the controls already live on
 * their own row and get their full labels back.
 */
export function shouldCompactComposerInlineControls(input: {
  inlineControlsOverflow: boolean;
  contentIsMultiLine: boolean;
}): boolean {
  return input.inlineControlsOverflow && !input.contentIsMultiLine;
}

/**
 * Measures whether the single-line control row would overflow, by comparing
 * the composer row's width against a hidden "probe" row that always renders
 * the controls at full size (untruncated model name, full mode-chip label)
 * plus a minimum editor width.
 *
 * Measuring the probe — never the live controls — keeps the signal stable:
 * compacting the real controls does not change the probe, so the layout
 * cannot oscillate at the boundary.
 */
export function useComposerInlineControlsOverflow(
  rowRef: RefObject<HTMLElement | null>,
  probeRef: RefObject<HTMLElement | null>,
  enabled: boolean
): boolean {
  const [overflow, setOverflow] = useState(false);

  // Layout effect so the first measurement lands before paint — otherwise a
  // narrow pane briefly flashes the full-size controls on mount.
  useLayoutEffect(() => {
    if (!enabled) {
      setOverflow(false);
      return;
    }
    const row = rowRef.current;
    const probe = probeRef.current;
    if (!row || !probe) {
      return;
    }

    const update = () => {
      // +1px tolerance absorbs sub-pixel rounding at the exact boundary.
      const next = probe.scrollWidth > row.clientWidth + 1;
      setOverflow((prev) => (prev === next ? prev : next));
    };

    update();

    const observer = new ResizeObserver(update);
    observer.observe(row);
    observer.observe(probe);

    return () => {
      observer.disconnect();
    };
  }, [rowRef, probeRef, enabled]);

  return enabled ? overflow : false;
}
