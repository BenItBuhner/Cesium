import { useEffect, useRef, useState } from "react";
import type { AgentConversationStatus } from "@/lib/agent-types";
import type { AuroraConversationState } from "@/lib/aurora-config";

const TYPING_HOLD_MS = 1800;
const COMPLETED_HOLD_MS = 4200;

const WORKING_STATUSES = new Set<AgentConversationStatus>([
  "running",
  "pause_requested",
  "pausing",
]);

const AWAITING_STATUSES = new Set<AgentConversationStatus>([
  "awaiting_permission",
  "awaiting_question",
]);

const CANCELLED_STATUSES = new Set<AgentConversationStatus>([
  "cancelled",
  "interrupted",
]);

export type ResolveAuroraConversationStateInput = {
  isNewChat: boolean;
  status: AgentConversationStatus | null | undefined;
  busy: boolean;
  typing: boolean;
  recentlyCompleted: boolean;
  hasCompletionError: boolean;
};

export function resolveAuroraConversationState(
  input: ResolveAuroraConversationStateInput
): AuroraConversationState {
  if (input.busy || (input.status != null && WORKING_STATUSES.has(input.status))) {
    return "working";
  }
  if (input.status != null && AWAITING_STATUSES.has(input.status)) {
    return "awaiting";
  }
  if (input.hasCompletionError || input.status === "failed") {
    return "failed";
  }
  if (input.status === "paused") {
    return "paused";
  }
  if (input.status != null && CANCELLED_STATUSES.has(input.status)) {
    return "cancelled";
  }
  if (input.recentlyCompleted) {
    return "completed";
  }
  if (input.typing) {
    return "typing";
  }
  if (input.isNewChat) {
    return "new";
  }
  return "idle";
}

function isWorkingLike(
  status: AgentConversationStatus | null | undefined,
  busy: boolean
): boolean {
  return busy || (status != null && WORKING_STATUSES.has(status));
}

export function useAuroraConversationState(input: {
  isNewChat: boolean;
  status: AgentConversationStatus | null | undefined;
  busy: boolean;
  composerText: string;
  hasCompletionError?: boolean;
}): AuroraConversationState {
  const [typing, setTyping] = useState(false);
  const [recentlyCompleted, setRecentlyCompleted] = useState(false);
  const lastComposerTextRef = useRef(input.composerText);
  const typingTimerRef = useRef<number | null>(null);
  const completedTimerRef = useRef<number | null>(null);
  const wasWorkingRef = useRef(isWorkingLike(input.status, input.busy));

  useEffect(() => {
    if (input.composerText === lastComposerTextRef.current) {
      return;
    }
    lastComposerTextRef.current = input.composerText;
    const hasText = input.composerText.trim().length > 0;
    if (!hasText) {
      setTyping(false);
      return;
    }
    setTyping(true);
    if (typingTimerRef.current != null) {
      window.clearTimeout(typingTimerRef.current);
    }
    typingTimerRef.current = window.setTimeout(() => {
      setTyping(false);
      typingTimerRef.current = null;
    }, TYPING_HOLD_MS);
  }, [input.composerText]);

  useEffect(() => {
    return () => {
      if (typingTimerRef.current != null) {
        window.clearTimeout(typingTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const working = isWorkingLike(input.status, input.busy);
    if (wasWorkingRef.current && !working && !input.hasCompletionError) {
      setRecentlyCompleted(true);
      if (completedTimerRef.current != null) {
        window.clearTimeout(completedTimerRef.current);
      }
      completedTimerRef.current = window.setTimeout(() => {
        setRecentlyCompleted(false);
        completedTimerRef.current = null;
      }, COMPLETED_HOLD_MS);
    }
    if (working) {
      setRecentlyCompleted(false);
      if (completedTimerRef.current != null) {
        window.clearTimeout(completedTimerRef.current);
        completedTimerRef.current = null;
      }
    }
    wasWorkingRef.current = working;
  }, [input.busy, input.hasCompletionError, input.status]);

  useEffect(() => {
    return () => {
      if (completedTimerRef.current != null) {
        window.clearTimeout(completedTimerRef.current);
      }
    };
  }, []);

  return resolveAuroraConversationState({
    isNewChat: input.isNewChat,
    status: input.status,
    busy: input.busy,
    typing,
    recentlyCompleted,
    hasCompletionError: Boolean(input.hasCompletionError),
  });
}
