"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentBackendInfo,
  AgentConversationRecord,
  AgentStoredEvent,
} from "@/lib/agent-types";
import {
  COMPLETION_RETRY_MIN_BUSY_MS,
  completionErrorDismissKey,
  computeCompletionAutoRetryActive,
  computeCompletionRetriesRemaining,
  computeCompletionRetryDelayMs,
  conversationHasCompletionFailure,
  deriveConversationCompletionError,
  isRetryableError,
  parseAgentCompletionError,
} from "@/lib/agent-completion-error";

export type AgentCompletionErrorDockState = {
  visible: boolean;
  error: ReturnType<typeof parseAgentCompletionError>;
  supportsRetry: boolean;
  retryDelayMs: number;
  retriesRemaining: number;
  autoRetryActive: boolean;
  retryBusy: boolean;
  dismiss: () => void;
  retry: (source?: "auto" | "manual") => void;
  cancelAutoRetry: () => void;
};

type UseAgentCompletionErrorDockInput = {
  conversation: AgentConversationRecord | null | undefined;
  events?: AgentStoredEvent[];
  backend: AgentBackendInfo | null | undefined;
  dismissedKey: string | undefined;
  onDismiss: (dismissKey: string) => void;
  onRetry: (conversationId: string) => Promise<void>;
};

export function useAgentCompletionErrorDock({
  conversation,
  events,
  backend,
  dismissedKey,
  onDismiss,
  onRetry,
}: UseAgentCompletionErrorDockInput): AgentCompletionErrorDockState {
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryPending, setRetryPending] = useState(false);
  const [attemptIndex, setAttemptIndex] = useState(0);
  const [autoRetryEnabled, setAutoRetryEnabled] = useState(true);
  const [halted, setHalted] = useState(false);
  const lastFailureKeyRef = useRef<string | null>(null);
  const haltedRef = useRef(false);

  const lastError = deriveConversationCompletionError(conversation, events);
  const failureKey = conversation?.id && lastError
    ? completionErrorDismissKey(conversation.id, lastError)
    : null;

  const hasFailure = conversationHasCompletionFailure(conversation, events);

  const error = useMemo(
    () => parseAgentCompletionError(lastError),
    [lastError]
  );

  const supportsRetry = Boolean(backend?.capabilities.supportsCompletionRetry);

  useEffect(() => {
    if (!failureKey) {
      return;
    }
    if (lastFailureKeyRef.current !== failureKey) {
      lastFailureKeyRef.current = failureKey;
      haltedRef.current = false;
      setHalted(false);
      setAttemptIndex(0);
      setAutoRetryEnabled(true);
    }
  }, [failureKey]);

  useEffect(() => {
    if (conversation?.status === "idle" && !conversation.lastError) {
      haltedRef.current = false;
      setHalted(false);
      setAttemptIndex(0);
      setAutoRetryEnabled(true);
      setRetryBusy(false);
    }
  }, [conversation?.status, conversation?.lastError]);

  const visible =
    (Boolean(lastError) &&
      Boolean(failureKey) &&
      dismissedKey !== failureKey &&
      hasFailure &&
      conversation?.status !== "awaiting_permission" &&
      !(conversation?.status === "running" && !hasFailure)) ||
    retryPending;

  const retriesRemaining = computeCompletionRetriesRemaining(attemptIndex);
  const retryDelayMs = computeCompletionRetryDelayMs(attemptIndex);

  const autoRetryActive = computeCompletionAutoRetryActive({
    visible,
    supportsRetry,
    autoRetryEnabled,
    halted: halted || haltedRef.current,
    retryable: isRetryableError(error),
    attemptIndex,
    retryBusy,
  });

  const haltRetries = useCallback(() => {
    haltedRef.current = true;
    setHalted(true);
    setAutoRetryEnabled(false);
    setRetryBusy(false);
  }, []);

  const retry = useCallback(
    async (_source: "auto" | "manual" = "manual") => {
      if (!conversation?.id || !supportsRetry || haltedRef.current) {
        return;
      }
      setRetryPending(true);
      setRetryBusy(true);
      const startedAt = Date.now();
      try {
        await onRetry(conversation.id);
        if (haltedRef.current) {
          return;
        }
        setAttemptIndex((current) => current + 1);
      } finally {
        const remaining = COMPLETION_RETRY_MIN_BUSY_MS - (Date.now() - startedAt);
        if (remaining > 0) {
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, remaining);
          });
        }
        setRetryBusy(false);
        setRetryPending(false);
      }
    },
    [conversation?.id, onRetry, supportsRetry]
  );

  useEffect(() => {
    if (!autoRetryActive) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      void retry("auto");
    }, retryDelayMs);
    return () => window.clearTimeout(timeoutId);
  }, [autoRetryActive, retry, retryDelayMs]);

  const dismiss = useCallback(() => {
    haltRetries();
    if (failureKey) {
      onDismiss(failureKey);
    }
  }, [failureKey, haltRetries, onDismiss]);

  const cancelAutoRetry = useCallback(() => {
    setAutoRetryEnabled(false);
  }, []);

  return {
    visible,
    error,
    supportsRetry,
    retryDelayMs,
    retriesRemaining,
    autoRetryActive,
    retryBusy,
    dismiss,
    retry,
    cancelAutoRetry,
  };
}
