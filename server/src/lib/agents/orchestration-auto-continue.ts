import {
  addOrchestrationComment,
  findOrchestrationAssignmentForConversation,
  findOrchestrationBoardForHeadConversation,
  orchestrationBoardNeedsManagement,
  upsertOrchestrationAssignment,
} from "../orchestration/store.js";
import { getCesiumAgentSettings } from "../cesium-agent-settings.js";
import { getWorkspaceById } from "../workspace-registry.js";
import { agentRuntimeManager } from "./runtime-manager.js";
import { readConversationSnapshotHead, subscribeAgentStoreEvents } from "./session-store.js";
import { readGoalForConversation } from "./goal-store.js";
import { goalHasRunnableWork } from "./goal-types.js";
import type { OrchestrationAssignmentStatus } from "../orchestration/types.js";
import type { AgentConversationRecord, AgentStoredEvent } from "./types.js";

const AUTO_CONTINUE_MARKER = "[Auto-continue]";
const MAX_AUTO_CONTINUE_ROUNDS = 40;

function countTrailingAutoContinues(events: AgentStoredEvent[]): number {
  let count = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind !== "user_message") {
      continue;
    }
    if (
      event.content.includes(AUTO_CONTINUE_MARKER) ||
      event.content.includes("<goal_context>") ||
      event.content.includes("<burn_context>")
    ) {
      count += 1;
      continue;
    }
    break;
  }
  return count;
}

function latestPlanHasIncompleteEntries(events: AgentStoredEvent[]): boolean {
  const latest = [...events].reverse().find((event) => event.kind === "plan");
  if (!latest || latest.kind !== "plan") {
    return false;
  }
  return latest.entries.some(
    (entry) => entry.status === "pending" || entry.status === "in_progress"
  );
}

function buildAutoContinuePrompt(mode: AgentConversationRecord["config"]["mode"]): string {
  if (mode === "orchestration") {
    return `${AUTO_CONTINUE_MARKER} You stopped while kanban orchestration work is still incomplete. Inspect orchestration_board_snapshot, resume managing open issues and child agents, and continue toward the user's core goals until verified complete or you need a material user decision.`;
  }
  return `${AUTO_CONTINUE_MARKER} You stopped while your todo list still has runnable incomplete items. Continue working through pending and in-progress tasks toward the user's goals before stopping again. If only blocked tasks remain, explain the blocker to the user instead of spinning.`;
}

function isNativeGoalConversation(conversation: AgentConversationRecord): boolean {
  return (
    conversation.config.backendId === "cesium-agent" &&
    (String(conversation.config.mode).trim().toLowerCase() === "goal" ||
      String(conversation.config.mode).trim().toLowerCase() === "burn")
  );
}

async function maybeAutoContinueGoalConversation(
  conversation: AgentConversationRecord
): Promise<void> {
  if (
    conversation.archivedAt != null ||
    (conversation.queuedPrompts?.length ?? 0) > 0
  ) {
    return;
  }
  const goalMode = isNativeGoalConversation(conversation);
  if (!goalMode && conversation.config.backendId !== "cesium-agent") {
    return;
  }
  const settings = await getCesiumAgentSettings();
  if (!settings.orchestration.continueWhenIncomplete) {
    return;
  }
  const workspace = await getWorkspaceById(conversation.workspaceId);
  if (!workspace) {
    return;
  }
  const childAssignment = await findOrchestrationAssignmentForConversation(
    workspace.id,
    conversation.id
  );
  if (childAssignment) {
    return;
  }
  const snapshot = await readConversationSnapshotHead(workspace.id, conversation.id, {
    conversation,
    limitTurns: 12,
    limitEvents: 240,
  });
  if (!snapshot) {
    return;
  }
  if (countTrailingAutoContinues(snapshot.events) >= MAX_AUTO_CONTINUE_ROUNDS) {
    return;
  }
  let shouldContinue = false;
  let hiddenContinuation = false;
  if (conversation.config.mode === "orchestration") {
    const board = await findOrchestrationBoardForHeadConversation(
      workspace.id,
      conversation.id
    );
    shouldContinue = board ? orchestrationBoardNeedsManagement(board) : false;
  } else if (goalMode) {
    const goal = await readGoalForConversation({
      workspace,
      conversationId: conversation.id,
    });
    if (!goal || (goal.status !== "planning" && goal.status !== "active")) {
      return;
    }
    shouldContinue =
      goalHasRunnableWork(goal) ||
      latestPlanHasIncompleteEntries(snapshot.events);
    hiddenContinuation = true;
  } else {
    shouldContinue = latestPlanHasIncompleteEntries(snapshot.events);
  }
  if (!shouldContinue) {
    return;
  }
  await agentRuntimeManager.promptConversation(
    workspace,
    conversation.id,
    buildAutoContinuePrompt(conversation.config.mode),
    undefined,
    hiddenContinuation ? { hidden: true } : undefined
  );
}

function lastAssistantText(events: AgentStoredEvent[]): string | null {
  const textByMessageId = new Map<string, string>();
  let lastMessageId: string | null = null;
  for (const event of events) {
    if (event.kind === "assistant_message_chunk") {
      textByMessageId.set(
        event.messageId,
        `${textByMessageId.get(event.messageId) ?? ""}${event.text}`
      );
      lastMessageId = event.messageId;
    }
    if (event.kind === "assistant_message_end") {
      lastMessageId = event.messageId;
    }
  }
  const text = lastMessageId ? textByMessageId.get(lastMessageId)?.trim() : undefined;
  return text || null;
}

const inFlight = new Set<string>();

/** Resolve orchestration child-agent permission prompts according to board policy. */
export function startOrchestrationAgentControlListener(): void {
  subscribeAgentStoreEvents((event) => {
    if (event.type !== "conversation") {
      return;
    }
    const conversation = event.conversation;
    if (
      conversation.status === "idle" ||
      conversation.status === "failed" ||
      conversation.status === "cancelled" ||
      conversation.status === "interrupted"
    ) {
      if (conversation.status === "idle") {
        const autoContinueKey = `auto-continue:${conversation.id}:${conversation.lastEventSeq}`;
        if (!inFlight.has(autoContinueKey)) {
          setImmediate(() => {
            void (async () => {
              if (inFlight.has(autoContinueKey)) {
                return;
              }
              inFlight.add(autoContinueKey);
              try {
                await maybeAutoContinueGoalConversation(conversation);
              } catch (error) {
                console.warn("[orchestration] auto-continue failed:", error);
              } finally {
                inFlight.delete(autoContinueKey);
              }
            })();
          });
        }
      }
      const key = `completion:${conversation.id}:${conversation.lastEventSeq}:${conversation.status}`;
      if (!inFlight.has(key)) {
        setImmediate(() => {
          void (async () => {
            if (inFlight.has(key)) {
              return;
            }
            inFlight.add(key);
            try {
              const workspace = await getWorkspaceById(conversation.workspaceId);
              if (!workspace) {
                return;
              }
              const assignment = await findOrchestrationAssignmentForConversation(
                workspace.id,
                conversation.id
              );
              if (
                !assignment ||
                assignment.status === "completed" ||
                assignment.status === "failed" ||
                assignment.status === "cancelled"
              ) {
                return;
              }
              const nextStatus: OrchestrationAssignmentStatus =
                conversation.status === "idle"
                  ? "completed"
                  : conversation.status === "cancelled"
                    ? "cancelled"
                    : "failed";
              const snapshot = await readConversationSnapshotHead(
                workspace.id,
                conversation.id,
                { conversation, limitTurns: 8, limitEvents: 200 }
              );
              const finalText =
                snapshot && conversation.status === "idle"
                  ? lastAssistantText(snapshot.events)
                  : null;
              await addOrchestrationComment({
                boardId: assignment.boardId,
                issueId: assignment.issueId,
                actor: { type: "child_agent", conversationId: conversation.id },
                message:
                  finalText ??
                  `Child agent ${conversation.status}${
                    conversation.lastError ? `: ${conversation.lastError}` : "."
                  }`,
              });
              await upsertOrchestrationAssignment(
                assignment.boardId,
                {
                  ...assignment,
                  status: nextStatus,
                  lastKnownConversationStatus: conversation.status,
                },
                { type: "child_agent", conversationId: conversation.id }
              );
            } catch (error) {
              console.warn("[orchestration] child completion sync failed:", error);
            } finally {
              inFlight.delete(key);
            }
          })();
        });
      }
    }
    const pendingPermission = conversation.pendingPermission;
    if (conversation.status === "awaiting_permission" && pendingPermission) {
      const key = `permission:${conversation.id}:${pendingPermission.requestId}`;
      if (inFlight.has(key)) {
        return;
      }
      setImmediate(() => {
        void (async () => {
          if (inFlight.has(key)) {
            return;
          }
          inFlight.add(key);
          try {
            const workspace = await getWorkspaceById(conversation.workspaceId);
            if (!workspace) {
              return;
            }
            const assignment = await findOrchestrationAssignmentForConversation(
              workspace.id,
              conversation.id
            );
            if (!assignment) {
              return;
            }
            const policy =
              assignment.config.permissionPolicy?.[
                pendingPermission.permission ?? "editFile"
              ] ?? "allow";
            if (policy !== "allow") {
              return;
            }
            await agentRuntimeManager.answerPermission(workspace, conversation.id, {
              requestId: pendingPermission.requestId,
              optionId: "allow_once",
            });
          } catch (error) {
            console.warn("[orchestration] auto-permission failed:", error);
          } finally {
            inFlight.delete(key);
          }
        })();
      });
      return;
    }
  });
}
