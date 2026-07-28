"use client";

import {
  useEffect,
  useLayoutEffect,
  useState,
  type RefObject,
} from "react";

/**
 * How the docked single-line composer reacts when its inline controls (mode
 * chip + model pill + action buttons) would squeeze the editor below a usable
 * width — e.g. long model names ("OpenAI/GPT-5.1 Codex Max") on phone-width
 * panes:
 *
 * - `"compact"`: the mode chip and model trigger collapse to icon-only pills
 *   so the capsule stays a single line.
 * - `"stack"`: the composer flips into its existing two-line stacked layout
 *   (editor on top, controls on the bottom row, squarer corner radius) — the
 *   same shell used when typed text wraps.
 */
export type ComposerInlineOverflowStrategy = "compact" | "stack";

export const DEFAULT_COMPOSER_INLINE_OVERFLOW_STRATEGY: ComposerInlineOverflowStrategy =
  "compact";

/**
 * Runtime escape hatch so either behavior can be evaluated live without a
 * rebuild: `localStorage["cesium.composer-overflow-strategy"] = "stack"`.
 */
export const COMPOSER_INLINE_OVERFLOW_STRATEGY_STORAGE_KEY =
  "cesium.composer-overflow-strategy";

/**
 * Minimum editor width the single-line capsule must preserve before overflow
 * handling engages. Wide enough to read a few words of input; small enough
 * that overflow only triggers when the controls genuinely crowd the row.
 */
export const COMPOSER_INLINE_MIN_EDITOR_WIDTH_PX = 96;

export function parseComposerInlineOverflowStrategy(
  value: unknown
): ComposerInlineOverflowStrategy | null {
  return value === "compact" || value === "stack" ? value : null;
}

/**
 * Pure resolver mapping the measured overflow state onto the UI adjustments.
 * Overflow handling only applies while the layout is still single-line; once
 * content itself wraps (or `forceMultiline` is set) the controls already live
 * on their own row and get full labels back.
 */
export function resolveComposerInlineOverflowUi(input: {
  strategy: ComposerInlineOverflowStrategy;
  inlineControlsOverflow: boolean;
  contentIsMultiLine: boolean;
}): {
  compactInlineControls: boolean;
  forceStackedControls: boolean;
} {
  if (!input.inlineControlsOverflow || input.contentIsMultiLine) {
    return { compactInlineControls: false, forceStackedControls: false };
  }
  if (input.strategy === "stack") {
    return { compactInlineControls: false, forceStackedControls: true };
  }
  return { compactInlineControls: true, forceStackedControls: false };
}

/**
 * Resolves the active strategy: explicit prop override → localStorage
 * (read once on mount; client-only so SSR markup stays deterministic) →
 * default.
 */
export function useComposerInlineOverflowStrategy(
  override?: ComposerInlineOverflowStrategy
): ComposerInlineOverflowStrategy {
  const [stored, setStored] = useState<ComposerInlineOverflowStrategy | null>(
    null
  );

  useEffect(() => {
    try {
      setStored(
        parseComposerInlineOverflowStrategy(
          window.localStorage.getItem(
            COMPOSER_INLINE_OVERFLOW_STRATEGY_STORAGE_KEY
          )
        )
      );
    } catch {
      // Storage unavailable (private mode / sandboxed webview): use default.
    }
  }, []);

  return override ?? stored ?? DEFAULT_COMPOSER_INLINE_OVERFLOW_STRATEGY;
}

/**
 * Measures whether the single-line control row would overflow, by comparing
 * the composer row's width against a hidden "probe" row that always renders
 * the controls at full size (untruncated model name, full mode-chip label)
 * plus a minimum editor width.
 *
 * Measuring the probe — never the live controls — keeps the signal stable:
 * compacting or stacking the real controls does not change the probe, so the
 * layout cannot oscillate at the boundary.
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
