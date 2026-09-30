"use client";

import { useEffect, useState } from "react";
import type { AgentGoalSummary } from "@/lib/agent-types";
import { fetchAgentConversationGoal } from "@/lib/server-api";

/**
 * The conversation's Goal record as the chat shows it. Refetches when
 * `refreshKey` changes; null while there is no Goal or it cannot be read.
 */
export function useConversationGoal(input: {
  conversationId: string | null | undefined;
  refreshKey: string;
  enabled: boolean;
}): AgentGoalSummary | null {
  const { conversationId, refreshKey, enabled } = input;
  const [goal, setGoal] = useState<{ conversationId: string; goal: AgentGoalSummary | null } | null>(null);

  useEffect(() => {
    if (!enabled || !conversationId) {
      return;
    }
    const controller = new AbortController();
    fetchAgentConversationGoal(conversationId, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) {
          setGoal({ conversationId, goal: result.goal });
        }
      })
      .catch(() => {
        // An unreadable record leaves the previous state; the pill falls back to tool events.
      });
    return () => controller.abort();
  }, [conversationId, enabled, refreshKey]);

  return enabled && goal && goal.conversationId === conversationId ? goal.goal : null;
}
