"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Minimum editor width the single-line capsule must preserve before overflow
 * handling engages. Wide enough to read a few words of input; small enough
 * that overflow only triggers when the controls genuinely crowd the row.
 */
export const COMPOSER_INLINE_MIN_EDITOR_WIDTH_PX = 96;

/**
 * Below this composer-row width, mode/model controls always collapse to
 * icon-only pills — even when the model name (or mode label) is short enough
 * that a full-size probe would still fit beside the minimum editor width.
 *
 * Matches the existing narrow-pane convention used elsewhere in the agent
 * shell (centered content gutter drops at ≤640px). Wider rows still compact
 * via the probe when a long label would squeeze the editor.
 */
export const COMPOSER_INLINE_FORCE_COMPACT_MAX_ROW_WIDTH_PX = 640;

/**
 * When the docked single-line composer's controls (mode chip + model pill +
 * action buttons) would squeeze the editor below a usable width — e.g. long
 * model names on phone-width panes — the mode chip and model trigger collapse
 * to icon-only pills so the capsule stays a single line.
 *
 * On narrow (mobile-width) rows, compaction is unconditional: short model
 * names must not keep the full label visible while mode chips go icon-only.
 *
 * Compaction only applies while the layout is still single-line; once content
 * itself wraps (or `forceMultiline` is set) the controls already live on
 * their own row and get their full labels back.
 */
export function shouldCompactComposerInlineControls(input: {
  inlineControlsOverflow: boolean;
  contentIsMultiLine: boolean;
  /** Live composer row width; when ≤ force-compact max, always compact. */
  rowWidthPx?: number | null;
}): boolean {
  if (input.contentIsMultiLine) {
    return false;
  }
  if (input.inlineControlsOverflow) {
    return true;
  }
  const rowWidth = input.rowWidthPx;
  return (
    typeof rowWidth === "number" &&
    Number.isFinite(rowWidth) &&
    rowWidth <= COMPOSER_INLINE_FORCE_COMPACT_MAX_ROW_WIDTH_PX
  );
}

export type ComposerInlineControlsOverflowState = {
  /** Probe outgrew the row (long labels would crowd the editor). */
  overflow: boolean;
  /** Latest measured row width; `null` until the first layout pass. */
  rowWidthPx: number | null;
};

/**
 * Measures whether the single-line control row would overflow, by comparing
 * the composer row's width against a hidden "probe" row that always renders
 * the controls at full size (untruncated model name, full mode-chip label)
 * plus a minimum editor width. Also reports the live row width so callers can
 * force-compact on narrow panes regardless of label length.
 *
 * Measuring the probe — never the live controls — keeps the signal stable:
 * compacting the real controls does not change the probe, so the layout
 * cannot oscillate at the boundary.
 */
export function useComposerInlineControlsOverflow(
  rowRef: RefObject<HTMLElement | null>,
  probeRef: RefObject<HTMLElement | null>,
  enabled: boolean
): ComposerInlineControlsOverflowState {
  const [state, setState] = useState<ComposerInlineControlsOverflowState>({
    overflow: false,
    rowWidthPx: null,
  });

  // Layout effect so the first measurement lands before paint — otherwise a
  // narrow pane briefly flashes the full-size controls on mount.
  useLayoutEffect(() => {
    if (!enabled) {
      setState({ overflow: false, rowWidthPx: null });
      return;
    }
    const row = rowRef.current;
    const probe = probeRef.current;
    if (!row || !probe) {
      return;
    }

    const update = () => {
      const rowWidthPx = row.clientWidth;
      // +1px tolerance absorbs sub-pixel rounding at the exact boundary.
      const overflow = probe.scrollWidth > rowWidthPx + 1;
      setState((prev) =>
        prev.overflow === overflow && prev.rowWidthPx === rowWidthPx
          ? prev
          : { overflow, rowWidthPx }
      );
    };

    update();

    const observer = new ResizeObserver(update);
    observer.observe(row);
    observer.observe(probe);

    return () => {
      observer.disconnect();
    };
  }, [rowRef, probeRef, enabled]);

  return enabled ? state : { overflow: false, rowWidthPx: null };
}
