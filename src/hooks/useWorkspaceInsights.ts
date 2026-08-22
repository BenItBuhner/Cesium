"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceInsights } from "@cesium/core";
import type { AgentConversationStatus } from "@/lib/agent-types";
import { fetchWorkspaceInsights } from "@/lib/server-api";

const POLL_INTERVAL_MS = 20_000;
const INITIAL_DEBOUNCE_MS = 500;

const REFRESH_EVENT = "opencursor:workspace-insights-refresh";

/** Ask all mounted insight hooks to refetch (e.g. after running an action). */
export function requestWorkspaceInsightsRefresh(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
  }
}

/**
 * Polls the composer insights snapshot for a workspace. Refreshes when the
 * conversation settles back to idle (agent turns usually change the diff), on
 * a slow interval, and on explicit {@link requestWorkspaceInsightsRefresh}.
 */
export function useWorkspaceInsights(input: {
  workspaceId: string | null | undefined;
  conversationStatus?: AgentConversationStatus;
  enabled?: boolean;
}): {
  insights: WorkspaceInsights | null;
  loading: boolean;
  refresh: () => void;
} {
  const { workspaceId, conversationStatus, enabled = true } = input;
  const [insights, setInsights] = useState<WorkspaceInsights | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const workspaceIdRef = useRef(workspaceId);

  const load = useCallback(async () => {
    if (!enabled || !workspaceId) {
      setInsights(null);
      setLoading(false);
      return;
    }
    if (workspaceIdRef.current !== workspaceId) {
      workspaceIdRef.current = workspaceId;
      setInsights(null);
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const response = await fetchWorkspaceInsights(workspaceId, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setInsights(response.insights);
      }
    } catch {
      /* transient — keep last snapshot */
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [enabled, workspaceId]);

  useEffect(() => {
    if (!enabled || !workspaceId) {
      setInsights(null);
      return;
    }
    let lastLoadAt = 0;
    const loadNow = () => {
      lastLoadAt = Date.now();
      void load();
    };
    const initial = window.setTimeout(loadNow, INITIAL_DEBOUNCE_MS);
    // Hidden tabs skip the poll entirely; on return the snapshot refreshes
    // immediately when stale instead of waiting out the interval.
    const interval = window.setInterval(() => {
      if (document.visibilityState === "hidden") {
        return;
      }
      loadNow();
    }, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastLoadAt >= POLL_INTERVAL_MS
      ) {
        loadNow();
      }
    };
    const onRefresh = () => loadNow();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(REFRESH_EVENT, onRefresh);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(REFRESH_EVENT, onRefresh);
      abortRef.current?.abort();
    };
  }, [enabled, workspaceId, load]);

  const previousStatusRef = useRef<AgentConversationStatus | undefined>(conversationStatus);
  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = conversationStatus;
    if (previous && previous !== "idle" && conversationStatus === "idle") {
      void load();
    }
  }, [conversationStatus, load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return { insights, loading, refresh };
}
