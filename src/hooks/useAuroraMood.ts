"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentConversationStatus } from "@/lib/agent-types";
import type { AuroraMood } from "@/lib/aurora/aurora-renderer";

/** How long the completion bloom lingers before easing back to ambient. */
const COMPLETED_LINGER_MS = 5000;
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
  /** New-chat landing (draft conversation, nothing sent yet). */
  showLanding: boolean;
  /** Composer draft has content. */
  isTyping: boolean;
  /** Optimistic first turn in flight before the server ack. */
  workingOverride: boolean;
  /** From settings — when false the backdrop stays in the ambient state. */
  reactToActivity: boolean;
}): AuroraMood {
  const {
    conversationKey,
    status,
    showLanding,
    isTyping,
    workingOverride,
    reactToActivity,
  } = input;

  const [transient, setTransient] = useState<"completed" | "error" | null>(null);
  const prevStatusRef = useRef<AgentConversationStatus | undefined>(status);
  const prevKeyRef = useRef<string | null>(conversationKey);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const keyChanged = prevKeyRef.current !== conversationKey;
    const previous = prevStatusRef.current;
    prevKeyRef.current = conversationKey;
    prevStatusRef.current = status;

    if (keyChanged) {
      // Selecting another thread must never replay its last transition.
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setTransient(null);
      return;
    }
    if (!reactToActivity || previous === status) {
      return;
    }

    const wasActive =
      isWorkingStatus(previous) || isWaitingStatus(previous);
    let next: "completed" | "error" | null = null;
    if (wasActive && status === "idle") {
      next = "completed";
    } else if (status === "failed") {
      next = "error";
    } else if (isWorkingStatus(status) || isWaitingStatus(status)) {
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
  }, [conversationKey, status, reactToActivity]);

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
  if (workingOverride || isWorkingStatus(status)) {
    return "working";
  }
  if (isWaitingStatus(status)) {
    return "waiting";
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
