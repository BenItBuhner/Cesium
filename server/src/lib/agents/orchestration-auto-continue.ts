import {
  addOrchestrationComment,
  findOrchestrationAssignmentForConversation,
  upsertOrchestrationAssignment,
} from "../orchestration/store.js";
import { getWorkspaceById } from "../workspace-registry.js";
import { agentRuntimeManager } from "./runtime-manager.js";
import { readConversationSnapshotHead, subscribeAgentStoreEvents } from "./session-store.js";
import type { OrchestrationAssignmentStatus } from "../orchestration/types.js";
import type { AgentStoredEvent } from "./types.js";

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
