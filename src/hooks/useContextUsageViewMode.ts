"use client";

import { useCallback, useEffect, useState } from "react";
import {
  isContextUsageViewMode,
  readStoredContextUsageViewMode,
  writeStoredContextUsageViewMode,
  type ContextUsageViewMode,
} from "@/lib/context-usage-timeline";

const VIEW_MODE_EVENT = "cesium:context-usage-view-mode";

function browserStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

/**
 * Pooled vs sequential context breakdown, remembered across sessions and
 * kept in sync between every mounted surface (dock and inspector tabs).
 */
export function useContextUsageViewMode(): [
  ContextUsageViewMode,
  (mode: ContextUsageViewMode) => void,
] {
  const [mode, setMode] = useState<ContextUsageViewMode>(() =>
    readStoredContextUsageViewMode(browserStorage())
  );

  useEffect(() => {
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<unknown>).detail;
      if (isContextUsageViewMode(next)) {
        setMode(next);
      }
    };
    window.addEventListener(VIEW_MODE_EVENT, onChange);
    return () => window.removeEventListener(VIEW_MODE_EVENT, onChange);
  }, []);

  const update = useCallback((next: ContextUsageViewMode) => {
    setMode(next);
    writeStoredContextUsageViewMode(browserStorage(), next);
    window.dispatchEvent(new CustomEvent(VIEW_MODE_EVENT, { detail: next }));
  }, []);

  return [mode, update];
}
