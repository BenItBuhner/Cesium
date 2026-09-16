"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  copyTextToClipboard,
  type CopyTextOptions,
  type CopyTextResult,
} from "@/lib/copy-to-clipboard";

export type CopyFeedback = "idle" | "copied" | "failed";

const DEFAULT_KEY = "";
const COPIED_RESET_MS = 1800;
const FAILED_RESET_MS = 6000;

/**
 * Copy-button state machine on top of {@link copyTextToClipboard}.
 *
 * Invoke `copy()` directly from the click / tap handler (it starts the
 * clipboard write synchronously inside the gesture). `feedback` then reads
 * "copied" or "failed" until it resets; components with several copy buttons
 * pass a `key` and read `feedbackFor(key)` instead.
 */
export function useCopyToClipboard(options?: {
  copiedResetMs?: number;
  failedResetMs?: number;
}) {
  const copiedResetMs = options?.copiedResetMs ?? COPIED_RESET_MS;
  const failedResetMs = options?.failedResetMs ?? FAILED_RESET_MS;
  const [feedback, setFeedback] = useState<{
    state: Exclude<CopyFeedback, "idle">;
    key: string;
  } | null>(null);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    },
    []
  );

  const copy = useCallback(
    (
      text: string,
      copyOptions: CopyTextOptions & { key?: string } = {}
    ): Promise<CopyTextResult> => {
      const { key = DEFAULT_KEY, ...rest } = copyOptions;
      return copyTextToClipboard(text, rest).then((result) => {
        setFeedback({ state: result.ok ? "copied" : "failed", key });
        if (resetTimerRef.current !== null) {
          window.clearTimeout(resetTimerRef.current);
        }
        resetTimerRef.current = window.setTimeout(
          () => {
            resetTimerRef.current = null;
            setFeedback(null);
          },
          result.ok ? copiedResetMs : failedResetMs
        );
        return result;
      });
    },
    [copiedResetMs, failedResetMs]
  );

  const feedbackFor = useCallback(
    (key: string = DEFAULT_KEY): CopyFeedback =>
      feedback && feedback.key === key ? feedback.state : "idle",
    [feedback]
  );

  /** Clears any pending "copied" / "failed" state, e.g. when a popover closes. */
  const reset = useCallback(() => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    setFeedback(null);
  }, []);

  return {
    copy,
    feedback: feedbackFor(DEFAULT_KEY),
    feedbackFor,
    reset,
  };
}
