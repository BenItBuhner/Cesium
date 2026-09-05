"use client";

import { useCallback } from "react";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";
import { canOpenSideChat } from "@/lib/side-chat";
import type { ImageAttachment } from "@/lib/types";

/**
 * `/side [question]` for one host conversation: creates the side chat on the
 * server (seeded with the parent transcript), then opens it as a full chat in
 * the editor panel - like any other "open in editor" tab, in the focused group
 * and never forcing a split (splitting stays a user decision). `openSideChat`
 * is `undefined` while the host cannot spawn one, which also hides the
 * slash-menu entry.
 */
export function useOpenSideChat(parentConversationId: string | null | undefined): {
  available: boolean;
  openSideChat?: (text: string, attachments?: ImageAttachment[]) => Promise<boolean>;
} {
  const { backends, conversationsById, createSideChat } = useAgentConversations();
  const { openAgentConversation } = useOpenInEditor();
  const { pushNotification } = useWorkbenchNotifications();
  const parent = parentConversationId ? conversationsById[parentConversationId] ?? null : null;
  const parentBackendId = parent?.config.backendId;
  const backend = backends.find((entry) => entry.id === parentBackendId) ?? null;
  const available = canOpenSideChat(parent, backend);

  const openSideChat = useCallback(
    async (text: string, attachments?: ImageAttachment[]) => {
      if (!parentConversationId) {
        return false;
      }
      try {
        const created = await createSideChat(parentConversationId, text, attachments);
        openAgentConversation({ conversationId: created.id, title: created.title });
        return true;
      } catch (error) {
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
          severity: "error",
          title: "Side Chat Unavailable",
          message: error instanceof Error ? error.message : "Could not open a side chat.",
          autoDismissMs: 8_000,
          compact: true,
        });
        return false;
      }
    },
    [createSideChat, openAgentConversation, parentConversationId, pushNotification]
  );

  return available ? { available, openSideChat } : { available };
}
