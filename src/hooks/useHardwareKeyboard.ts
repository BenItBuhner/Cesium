"use client";

import { useViewport } from "@/hooks/useViewport";

/**
 * When true, plain Enter in the chat composer submits (subject to settings).
 * Mobile layout (`width < 768`) always returns false so Enter inserts a newline;
 * touch keyboards lack Shift+Enter, so users rely on the Send button or Ctrl/Cmd+Enter.
 */
export function useHardwareKeyboard(): boolean {
  const { isMobile } = useViewport();
  return !isMobile;
}
