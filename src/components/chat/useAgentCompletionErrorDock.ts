"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentBackendInfo,
  AgentConversationRecord,
  AgentStoredEvent,
} from "@/lib/agent-types";
import {
  COMPLETION_AUTO_RETRY_MAX_ATTEMPTS,
  COMPLETION_RETRY_DELAYS_MS,
  completionErrorDismissKey,
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
  autoRetryActive: boolean;
  retryBusy: boolean;
  dismiss: () => void;
  retry: () => void;
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
  const [attemptIndex, setAttemptIndex] = useState(0);
  const [autoRetryEnabled, setAutoRetryEnabled] = useState(true);
  const lastFailureKeyRef = useRef<string | null>(null);

  const lastError = conversation?.lastError?.trim() ?? "";
  const failureKey = conversation?.id && lastError
    ? completionErrorDismissKey(conversation.id, lastError)
    : null;

  const error = useMemo(
    () => parseAgentCompletionError(lastError, conversation?.config.backendId),
    [lastError, conversation?.config.backendId]
  );

  const supportsRetry = Boolean(backend?.capabilities.supportsCompletionRetry);

  useEffect(() => {
    if (!failureKey) {
      return;
    }
    if (lastFailureKeyRef.current !== failureKey) {
      lastFailureKeyRef.current = failureKey;
      setAttemptIndex(0);
      setAutoRetryEnabled(true);
    }
  }, [failureKey]);

  useEffect(() => {
    if (conversation?.status === "idle" && !conversation.lastError) {
      setAttemptIndex(0);
      setAutoRetryEnabled(true);
      setRetryBusy(false);
    }
  }, [conversation?.status, conversation?.lastError]);

  const visible =
    Boolean(lastError) &&
    Boolean(failureKey) &&
    dismissedKey !== failureKey &&
    conversationHasCompletionFailure(conversation, events) &&
    conversation?.status !== "running" &&
    conversation?.status !== "awaiting_permission";

  const retryDelayMs =
    COMPLETION_RETRY_DELAYS_MS[
      Math.min(attemptIndex, COMPLETION_RETRY_DELAYS_MS.length - 1)
    ] ?? COMPLETION_RETRY_DELAYS_MS[0]!;

  const autoRetryActive =
    visible &&
    supportsRetry &&
    autoRetryEnabled &&
    isRetryableError(error) &&
    attemptIndex < COMPLETION_AUTO_RETRY_MAX_ATTEMPTS &&
    !retryBusy;

  const retry = useCallback(async () => {
    if (!conversation?.id || !supportsRetry) {
      return;
    }
    setAutoRetryEnabled(false);
    setRetryBusy(true);
    try {
      await onRetry(conversation.id);
      setAttemptIndex((current) => current + 1);
    } finally {
      setRetryBusy(false);
    }
  }, [conversation?.id, onRetry, supportsRetry]);

  const dismiss = useCallback(() => {
    if (failureKey) {
      onDismiss(failureKey);
    }
    setAutoRetryEnabled(false);
  }, [failureKey, onDismiss]);

  const cancelAutoRetry = useCallback(() => {
    setAutoRetryEnabled(false);
  }, []);

  return {
    visible,
    error,
    supportsRetry,
    retryDelayMs,
    autoRetryActive,
    retryBusy,
    dismiss,
    retry,
    cancelAutoRetry,
  };
}
