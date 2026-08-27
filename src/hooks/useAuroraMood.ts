"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentConversationStatus } from "@/lib/agent-types";
import type { AuroraMood } from "@/lib/aurora/aurora-renderer";

/** How long the completion bloom lingers before easing back to ambient. */
const COMPLETED_LINGER_MS = 6000;
/** How long the failure wash lingers before easing back to ambient. */
const ERROR_LINGER_MS = 6500;

function isWorkingStatus(status: AgentConversationStatus | undefined): boolean {
  return status === "running" || status === "pause_requested" || status === "pausing";
}

function isWaitingStatus(status: AgentConversationStatus | undefined): boolean {
  return status === "awaiting_permission" || status === "awaiting_question";
}

/**
 * Derive the aurora backdrop mood from the conversation lifecycle.
 *
 * Transitions out of an active turn produce short-lived transient moods: a
 * completion bloom when a busy status settles to `idle`, and an error wash
 * when it lands on `failed`. Everything else maps directly from the current
 * status / composer state.
 */
export function useAuroraMood(input: {
  /** Distinguishes conversations so switching threads never fires a false bloom. */
  conversationKey: string | null;
  status: AgentConversationStatus | undefined;
  /**
   * Latest turn ended in a completion failure (from
   * `conversationHasCompletionFailure`). Some failures never pass through the
   * `failed` status - synchronous rejections and failure events on an `idle`
   * conversation - so status transitions alone would miss them.
   */
  hasCompletionFailure: boolean;
  /**
   * A docked ask-question card is waiting on the user. More reliable than
   * `awaiting_question`, which can read as `running` mid-question.
   */
  hasDockedQuestion: boolean;
  /**
   * Key used for the optimistic first-turn view. Handing off from this key to
   * the server-acked conversation is a continuation of the same thread, so
   * transition tracking survives it (instant failures land right at the
   * handoff and would otherwise be swallowed by the reset).
   */
  optimisticKey?: string;
  /** New-chat landing (draft conversation, nothing sent yet). */
  showLanding: boolean;
  /** Composer draft has content. */
  isTyping: boolean;
  /** Optimistic first turn in flight before the server ack. */
  workingOverride: boolean;
  /** From settings - when false the backdrop stays in the ambient state. */
  reactToActivity: boolean;
}): AuroraMood {
  const {
    conversationKey,
    status,
    hasCompletionFailure,
    hasDockedQuestion,
    optimisticKey,
    showLanding,
    isTyping,
    workingOverride,
    reactToActivity,
  } = input;

  const [transient, setTransient] = useState<"completed" | "error" | null>(null);
  const prevStatusRef = useRef<AgentConversationStatus | undefined>(status);
  const prevFailureRef = useRef<boolean>(hasCompletionFailure);
  const prevKeyRef = useRef<string | null>(conversationKey);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const previousKey = prevKeyRef.current;
    const keyChanged = previousKey !== conversationKey;
    const isOptimisticHandoff =
      keyChanged && optimisticKey != null && previousKey === optimisticKey;
    const previous = prevStatusRef.current;
    const previousFailure = prevFailureRef.current;
    prevKeyRef.current = conversationKey;
    prevStatusRef.current = status;
    prevFailureRef.current = hasCompletionFailure;

    if (keyChanged && !isOptimisticHandoff) {
      // Selecting another thread must never replay its last transition.
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setTransient(null);
      return;
    }
    if (!reactToActivity) {
      return;
    }
    const statusChanged = previous !== status;
    const failureAppeared = !previousFailure && hasCompletionFailure;
    if (!statusChanged && !failureAppeared) {
      return;
    }

    // A fast turn can finish before the client ever observes `running`: the
    // first status after the optimistic handoff is already `idle`. The
    // optimistic send WAS the active phase, so treat the handoff as active.
    const wasActive =
      isWorkingStatus(previous) ||
      isWaitingStatus(previous) ||
      (isOptimisticHandoff && previous == null);
    let next: "completed" | "error" | null = null;
    if (failureAppeared || status === "failed") {
      next = "error";
    } else if (statusChanged && wasActive && status === "idle") {
      next = hasCompletionFailure ? "error" : "completed";
    } else if (statusChanged && (isWorkingStatus(status) || isWaitingStatus(status))) {
      // A new turn immediately supersedes any lingering bloom/wash.
      next = null;
    } else {
      return;
    }

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setTransient(next);
    if (next) {
      timerRef.current = setTimeout(
        () => {
          timerRef.current = null;
          setTransient(null);
        },
        next === "completed" ? COMPLETED_LINGER_MS : ERROR_LINGER_MS
      );
    }
  }, [conversationKey, status, hasCompletionFailure, optimisticKey, reactToActivity]);

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    },
    []
  );

  if (!reactToActivity) {
    return "idle";
  }
  if (isWaitingStatus(status) || hasDockedQuestion) {
    return "waiting";
  }
  if (workingOverride || isWorkingStatus(status)) {
    return "working";
  }
  if (transient) {
    return transient;
  }
  if (status === "paused") {
    return "paused";
  }
  if (isTyping) {
    return "typing";
  }
  if (showLanding) {
    return "new-chat";
  }
  return "idle";
}
