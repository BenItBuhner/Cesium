"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceInsights } from "@cesium/core";
import type { AgentConversationStatus } from "@/lib/agent-types";
import { fetchWorkspaceInsights } from "@/lib/server-api";
import { WORKSPACE_FS_CHANGED_EVENT } from "@/lib/workspace-fs-events";

/**
 * Backstop only. Real refreshes are event-driven: file-watcher changes, the
 * conversation settling back to idle, and explicit refresh requests. The old
 * fixed 20s poll spawned 3-4 git processes per client per tick regardless of
 * whether anything had changed.
 */
const POLL_INTERVAL_MS = 60_000;
const INITIAL_DEBOUNCE_MS = 500;
/** Wait for a burst of file changes (agent edits, builds) to settle first. */
const FS_CHANGE_DEBOUNCE_MS = 2_000;
/** Never re-run git status more often than this, whatever the trigger. */
const MIN_REFRESH_GAP_MS = 4_000;

const REFRESH_EVENT = "opencursor:workspace-insights-refresh";

/** Ask all mounted insight hooks to refetch (e.g. after running an action). */
export function requestWorkspaceInsightsRefresh(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
  }
}

/** Structural equality ignoring the server's `updatedAt` stamp, so an unchanged snapshot is a no-op render. */
function sameInsights(a: WorkspaceInsights | null, b: WorkspaceInsights): boolean {
  if (!a) return false;
  const withoutStamp = (value: WorkspaceInsights) =>
    JSON.stringify({ ...value, updatedAt: 0 });
  return withoutStamp(a) === withoutStamp(b);
}

/**
 * Tracks the composer insights snapshot for a workspace. Refreshes when the
 * workspace's files change (debounced), when the conversation settles back to
 * idle (agent turns usually change the diff), on explicit
 * {@link requestWorkspaceInsightsRefresh}, and on a slow backstop interval.
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
  const insightsRef = useRef<WorkspaceInsights | null>(null);
  const lastLoadAtRef = useRef(0);

  const load = useCallback(async () => {
    if (!enabled || !workspaceId) {
      insightsRef.current = null;
      setInsights(null);
      setLoading(false);
      return;
    }
    if (workspaceIdRef.current !== workspaceId) {
      workspaceIdRef.current = workspaceId;
      insightsRef.current = null;
      setInsights(null);
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    lastLoadAtRef.current = Date.now();
    // Only the first load for a workspace shows a loading state; background
    // refreshes must not flip the composer between loading/loaded.
    const initialLoad = insightsRef.current === null;
    if (initialLoad) {
      setLoading(true);
    }
    try {
      const response = await fetchWorkspaceInsights(workspaceId, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted && !sameInsights(insightsRef.current, response.insights)) {
        insightsRef.current = response.insights;
        setInsights(response.insights);
      }
    } catch {
      /* transient - keep last snapshot */
    } finally {
      if (!controller.signal.aborted && initialLoad) {
        setLoading(false);
      }
    }
  }, [enabled, workspaceId]);

  useEffect(() => {
    if (!enabled || !workspaceId) {
      insightsRef.current = null;
      setInsights(null);
      return;
    }
    let debounceTimer: number | null = null;
    const loadNow = () => {
      if (debounceTimer != null) {
        window.clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      void load();
    };
    // Coalesce triggers and enforce the minimum gap between git runs.
    const loadSoon = (delayMs: number) => {
      const sinceLast = Date.now() - lastLoadAtRef.current;
      const wait = Math.max(delayMs, MIN_REFRESH_GAP_MS - sinceLast);
      if (debounceTimer != null) {
        window.clearTimeout(debounceTimer);
      }
      debounceTimer = window.setTimeout(loadNow, wait);
    };
    const initial = window.setTimeout(loadNow, INITIAL_DEBOUNCE_MS);
    // Hidden tabs skip the backstop entirely; on return the snapshot refreshes
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
        Date.now() - lastLoadAtRef.current >= POLL_INTERVAL_MS
      ) {
        loadNow();
      }
    };
    const onRefresh = () => loadNow();
    const onFsChanged = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      loadSoon(FS_CHANGE_DEBOUNCE_MS);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(REFRESH_EVENT, onRefresh);
    window.addEventListener(WORKSPACE_FS_CHANGED_EVENT, onFsChanged);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      if (debounceTimer != null) {
        window.clearTimeout(debounceTimer);
      }
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(REFRESH_EVENT, onRefresh);
      window.removeEventListener(WORKSPACE_FS_CHANGED_EVENT, onFsChanged);
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
