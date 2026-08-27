import { randomUUID } from "node:crypto";
import { listWorkspaces } from "../workspace-registry.js";
import { agentRuntimeManager } from "./runtime-manager.js";
import {
  appendConversationEvents,
  listWorkspaceConversationRecordPage,
  readConversationRecord,
  subscribeAgentStoreEvents,
  updateConversationRecord,
} from "./session-store.js";
import type { AgentConversationStatus } from "./types.js";

/**
 * Agent runs only exist as in-memory provider runtimes; none survive a server
 * restart. Conversation records, however, are persisted - so a crash or
 * restart mid-turn used to leave records stuck on "running" forever. Clients
 * (workbench rail, mobile live notifications) then showed an eternal
 * "Working" state with an ever-growing elapsed timer.
 *
 * Two recovery layers fix that:
 *  - a boot sweep that interrupts every busy conversation right after start
 *    (nothing can be running yet), and
 *  - a watchdog that interrupts conversations whose provider runtime vanished
 *    mid-flight without settling the turn (e.g. a provider process died
 *    without emitting a terminal status).
 */

/**
 * Statuses that imply a live provider runtime must exist somewhere. After a
 * restart none can, so all of them are safe to interrupt at boot - including
 * the awaiting_* states, whose pending permission/question belonged to a
 * runtime that no longer exists and can never be answered.
 */
const BOOT_STALE_STATUSES: ReadonlySet<AgentConversationStatus> = new Set([
  "running",
  "pause_requested",
  "pausing",
  "awaiting_permission",
  "awaiting_question",
]);

/**
 * Statuses the watchdog may interrupt while the server is up. The awaiting_*
 * states are excluded here: answering a permission/question lazily re-ensures
 * the runtime, so a missing runtime is recoverable for them.
 */
const WATCHDOG_STALE_STATUSES: ReadonlySet<AgentConversationStatus> = new Set([
  "running",
  "pause_requested",
  "pausing",
]);

/** How often the watchdog looks for busy conversations without a runtime. */
const WATCHDOG_TICK_MS = 30_000;

/**
 * How long a busy conversation may lack a live runtime before it is declared
 * stuck. Covers the legitimate startup window where a prompt has already set
 * status "running" but `ensureRuntime` is still spawning the provider.
 */
const WATCHDOG_RUNTIME_GRACE_MS = 120_000;

const BOOT_PAGE_SIZE = 200;

export type StaleRunReconcilerOptions = {
  /** Injectable for tests; defaults to the singleton runtime manager. */
  hasLiveRuntime?: (conversationId: string) => boolean;
};

function defaultHasLiveRuntime(conversationId: string): boolean {
  return agentRuntimeManager.hasLiveRuntime(conversationId);
}

/**
 * Flips one stale conversation to "interrupted": clears the pending
 * permission/question that can no longer be answered and appends a status
 * event so connected clients (and live notifications) see a terminal
 * transition. The flip is guarded inside the per-conversation write queue -
 * if a fresh prompt raced in and the status is no longer stale-eligible,
 * nothing changes.
 *
 * Returns true when the conversation was actually interrupted.
 */
export async function interruptStaleAgentRun(
  workspaceId: string,
  conversationId: string,
  reason: string,
  eligibleStatuses: ReadonlySet<AgentConversationStatus> = BOOT_STALE_STATUSES
): Promise<boolean> {
  let flipped = false;
  await updateConversationRecord(workspaceId, conversationId, (current) => {
    if (!eligibleStatuses.has(current.status)) {
      return current;
    }
    flipped = true;
    return {
      ...current,
      status: "interrupted",
      pendingPermission: null,
      pendingQuestion: null,
    };
  });
  if (!flipped) {
    return false;
  }
  await appendConversationEvents(workspaceId, conversationId, [
    {
      eventId: randomUUID(),
      conversationId,
      kind: "status",
      status: "interrupted",
      detail: `${reason} The run was marked as interrupted; send a new message to continue.`,
    },
  ]);
  return true;
}

/**
 * Interrupts every conversation persisted in a busy status. Meant to run once
 * right after server start, before any prompt can create a new runtime.
 * Returns the number of conversations that were reconciled.
 */
export async function reconcileStaleAgentRunsOnBoot(
  options: StaleRunReconcilerOptions = {}
): Promise<number> {
  const hasLiveRuntime = options.hasLiveRuntime ?? defaultHasLiveRuntime;
  let interrupted = 0;
  const workspaces = await listWorkspaces();
  for (const workspace of workspaces) {
    let cursor: string | null = null;
    do {
      const page = await listWorkspaceConversationRecordPage(workspace.id, {
        cursor,
        limit: BOOT_PAGE_SIZE,
        includeArchived: true,
      });
      for (const record of page.records) {
        if (!BOOT_STALE_STATUSES.has(record.status)) {
          continue;
        }
        if (hasLiveRuntime(record.id)) {
          continue;
        }
        const didInterrupt = await interruptStaleAgentRun(
          workspace.id,
          record.id,
          "The server restarted while this agent run was in progress.",
          BOOT_STALE_STATUSES
        ).catch((error) => {
          console.warn(
            `[agent-reconcile] failed to interrupt stale run ${record.id}:`,
            error instanceof Error ? error.message : error
          );
          return false;
        });
        if (didInterrupt) {
          interrupted += 1;
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
  if (interrupted > 0) {
    console.warn(
      `[agent-reconcile] interrupted ${interrupted} agent run(s) left busy by a previous server process.`
    );
  }
  return interrupted;
}

type WatchedConversation = {
  workspaceId: string;
  /** When the runtime was first observed missing; null while it is alive. */
  runtimeMissingSince: number | null;
};

export type StaleRunWatchdogOptions = StaleRunReconcilerOptions & {
  tickMs?: number;
  graceMs?: number;
};

/**
 * Tracks conversations observed transitioning into an in-flight turn status
 * and interrupts any that keep that status while their provider runtime is
 * gone for longer than the grace window. Returns a stop function.
 */
export function startStaleAgentRunWatchdog(
  options: StaleRunWatchdogOptions = {}
): () => void {
  const hasLiveRuntime = options.hasLiveRuntime ?? defaultHasLiveRuntime;
  const graceMs = options.graceMs ?? WATCHDOG_RUNTIME_GRACE_MS;
  const watched = new Map<string, WatchedConversation>();

  const unsubscribe = subscribeAgentStoreEvents((event) => {
    if (event.type === "conversation_deleted") {
      watched.delete(event.conversationId);
      return;
    }
    if (event.type !== "conversation") {
      return;
    }
    const conversation = event.conversation;
    if (!WATCHDOG_STALE_STATUSES.has(conversation.status)) {
      watched.delete(conversation.id);
      return;
    }
    const existing = watched.get(conversation.id);
    if (existing) {
      existing.workspaceId = conversation.workspaceId;
    } else {
      watched.set(conversation.id, {
        workspaceId: conversation.workspaceId,
        runtimeMissingSince: null,
      });
    }
  });

  const sweep = async (now: number): Promise<void> => {
    for (const [conversationId, entry] of [...watched]) {
      if (hasLiveRuntime(conversationId)) {
        entry.runtimeMissingSince = null;
        continue;
      }
      if (entry.runtimeMissingSince == null) {
        entry.runtimeMissingSince = now;
        continue;
      }
      if (now - entry.runtimeMissingSince < graceMs) {
        continue;
      }
      watched.delete(conversationId);
      try {
        // Re-read to confirm the record is still stuck before interrupting.
        const record = await readConversationRecord(entry.workspaceId, conversationId);
        if (
          !record ||
          !WATCHDOG_STALE_STATUSES.has(record.status) ||
          hasLiveRuntime(conversationId)
        ) {
          continue;
        }
        const didInterrupt = await interruptStaleAgentRun(
          entry.workspaceId,
          conversationId,
          "The agent runtime for this run is no longer alive.",
          WATCHDOG_STALE_STATUSES
        );
        if (didInterrupt) {
          console.warn(
            `[agent-reconcile] interrupted stuck agent run ${conversationId} (runtime missing for ${Math.round((now - (entry.runtimeMissingSince ?? now)) / 1000)}s).`
          );
        }
      } catch (error) {
        console.warn(
          `[agent-reconcile] watchdog failed for ${conversationId}:`,
          error instanceof Error ? error.message : error
        );
      }
    }
  };

  const timer = setInterval(() => {
    void sweep(Date.now());
  }, options.tickMs ?? WATCHDOG_TICK_MS);
  timer.unref?.();

  return () => {
    unsubscribe();
    clearInterval(timer);
  };
}
