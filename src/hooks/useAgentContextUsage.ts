"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentBackendId, AgentContextUsageSnapshot, AgentConversationStatus } from "@/lib/agent-types";
import { fetchAgentContextUsage } from "@/lib/server-api";

const DEBOUNCE_MS = 750;

export function useAgentContextUsage(input: {
  conversationId: string | null | undefined;
  backendId: AgentBackendId;
  modelId: string;
  conversationStatus?: AgentConversationStatus;
  /** Bumps every ~1–2 assistant completions; not on every streamed chunk. */
  refreshGeneration?: number;
  enabled?: boolean;
}): {
  usage: AgentContextUsageSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const {
    conversationId,
    backendId,
    modelId,
    conversationStatus,
    refreshGeneration = 0,
    enabled = true,
  } = input;
  const [usage, setUsage] = useState<AgentContextUsageSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const conversationIdRef = useRef(conversationId);
  const lastFetchKeyRef = useRef<string>("");
  const usageRef = useRef<AgentContextUsageSnapshot | null>(null);

  usageRef.current = usage;

  const load = useCallback(
    async (force = false) => {
      if (!enabled || !conversationId || conversationId === "__empty__") {
        setUsage(null);
        setLoading(false);
        setError(null);
        lastFetchKeyRef.current = "";
        return;
      }
      if (backendId !== "cesium-agent") {
        setUsage({
          supported: false,
          limitTokens: 0,
          usedTokens: 0,
          percentFull: 0,
          categories: [],
          approximate: true,
        });
        setLoading(false);
        setError(null);
        return;
      }

      const fetchKey = `${conversationId}:${modelId}:${refreshGeneration}:${conversationStatus ?? ""}`;
      if (!force && fetchKey === lastFetchKeyRef.current && usageRef.current) {
        return;
      }

      const conversationChanged = conversationIdRef.current !== conversationId;
      conversationIdRef.current = conversationId;
      if (conversationChanged) {
        abortRef.current?.abort();
        setUsage(null);
        usageRef.current = null;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      const showSpinner = !usageRef.current;
      if (showSpinner) {
        setLoading(true);
      }
      setError(null);

      try {
        const result = await fetchAgentContextUsage(conversationId, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return;
        }
        lastFetchKeyRef.current = fetchKey;
        setUsage(result.usage);
        usageRef.current = result.usage;
      } catch (caught) {
        if (controller.signal.aborted) {
          return;
        }
        setError(caught instanceof Error ? caught.message : "Failed to load context usage");
        if (!usageRef.current) {
          setUsage(null);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    },
    [backendId, conversationId, conversationStatus, enabled, modelId, refreshGeneration]
  );

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void load();
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [load]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, [conversationId]);

  const previousStatusRef = useRef<AgentConversationStatus | undefined>(conversationStatus);
  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = conversationStatus;
    if (
      previous &&
      previous !== "idle" &&
      conversationStatus === "idle" &&
      enabled &&
      conversationId
    ) {
      void load(true);
    }
  }, [conversationStatus, conversationId, enabled, load]);

  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  return { usage, loading, error, refresh };
}
