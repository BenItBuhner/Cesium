import type { OrchestrationBoardSnapshot } from "../orchestration/types.js";
import { subscribeOrchestrationStoreEvents } from "../orchestration/store.js";
import { subscribeAgentStoreEvents } from "./session-store.js";
import type { AgentConversationRecord } from "./types.js";
import { subscribeWorkflowStoreEvents, type WorkflowStoreEvent } from "./workflow-store.js";

export type WakeOutcome = "event" | "timeout" | "aborted";

/**
 * Wakes a waiting tool on store events instead of a polling interval.
 * Subscribe before the first check: an event that lands between a check and
 * the next `next()` call is remembered, so it cannot be missed.
 */
export class StoreWake {
  private pending = false;
  private settle: ((outcome: WakeOutcome) => void) | null = null;
  private readonly unsubscribe: () => void;

  constructor(subscribe: (onEvent: () => void) => () => void) {
    this.unsubscribe = subscribe(() => {
      this.pending = true;
      this.settle?.("event");
    });
  }

  /**
   * Resolves on the next event (or one since the last call), at `deadlineMs`
   * (`Infinity` for none), or when any of `signals` aborts.
   */
  next(deadlineMs: number, ...signals: Array<AbortSignal | undefined>): Promise<WakeOutcome> {
    const live = signals.filter((signal): signal is AbortSignal => Boolean(signal));
    if (live.some((signal) => signal.aborted)) return Promise.resolve("aborted");
    if (this.pending) {
      this.pending = false;
      return Promise.resolve("event");
    }
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) return Promise.resolve("timeout");
    return new Promise((resolve) => {
      const finish = (outcome: WakeOutcome) => {
        if (timer) clearTimeout(timer);
        for (const signal of live) signal.removeEventListener("abort", onAbort);
        this.settle = null;
        if (outcome === "event") this.pending = false;
        resolve(outcome);
      };
      const onAbort = () => finish("aborted");
      const timer = Number.isFinite(remaining) ? setTimeout(() => finish("timeout"), remaining) : null;
      for (const signal of live) signal.addEventListener("abort", onAbort, { once: true });
      this.settle = finish;
    });
  }

  close(): void {
    this.unsubscribe();
    this.settle?.("aborted");
  }
}

/** Wakes when one of `conversationIds` is saved (and `matches` its record, when given). */
export function conversationWake(
  conversationIds: Iterable<string>,
  matches?: (record: AgentConversationRecord) => boolean
): StoreWake {
  const ids = new Set(conversationIds);
  return new StoreWake((onEvent) =>
    subscribeAgentStoreEvents((event) => {
      if (event.type !== "conversation" || !ids.has(event.conversation.id)) return;
      if (!matches || matches(event.conversation)) onEvent();
    })
  );
}

/** Wakes on every write to one board; `onSnapshot` sees the snapshot each write saved. */
export function boardWake(boardId: string, onSnapshot?: (snapshot: OrchestrationBoardSnapshot) => void): StoreWake {
  return new StoreWake((onEvent) =>
    subscribeOrchestrationStoreEvents((event) => {
      if (event.boardId !== boardId) return;
      if (event.type === "board") onSnapshot?.(event.snapshot);
      onEvent();
    })
  );
}

/** Wakes on workflow run writes that `matches` accepts. */
export function workflowWake(matches: (event: WorkflowStoreEvent) => boolean): StoreWake {
  return new StoreWake((onEvent) =>
    subscribeWorkflowStoreEvents((event) => {
      if (matches(event)) onEvent();
    })
  );
}