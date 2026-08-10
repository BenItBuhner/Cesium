"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, Image as ImageIcon, Loader2, MessageSquarePlus, Search, X } from "lucide-react";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import {
  agentWorkspaceComposerDraftId,
  useOpenInEditor,
} from "@/components/editor/OpenInEditorContext";
import { useShellView } from "@/components/layout/ShellViewContext";
import {
  BACK_INTENT_PRIORITY,
  useBackHandler,
} from "@/components/mobile/BackIntentContext";
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  MOBILE_BRIDGE_MESSAGE_EVENT,
  type MobileNativeToWebMessage,
  type MobileSharePayload,
  type MobileSharedFile,
} from "@/lib/mobile-bridge";
import { uploadAttachments } from "@/lib/server-api";
import { AGENT_NEW_CHAT_SESSION_ID } from "@/lib/workspace-session";
import type { ImageAttachment } from "@/lib/types";

const MAX_LISTED_CONVERSATIONS = 50;

type ShareTarget = { kind: "new" } | { kind: "conversation"; conversationId: string };

function sharedText(share: MobileSharePayload): string {
  const subject = share.subject?.trim() ?? "";
  const text = share.text?.trim() ?? "";
  if (subject && text && !text.includes(subject)) {
    return `${subject}\n${text}`;
  }
  return text || subject;
}

function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatUpdatedAt(updatedAt: number): string {
  const deltaMs = Date.now() - updatedAt;
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function decodeBase64ToFile(file: MobileSharedFile): File {
  const binary = atob(file.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes], file.name, { type: file.mimeType });
}

function isInlineImage(file: MobileSharedFile): boolean {
  return file.mimeType.startsWith("image/") && file.base64.length > 0;
}

/**
 * Handles Android share-sheet payloads relayed by the native shell
 * (`shareIntent` bridge messages): shows a picker over the workbench where the
 * user chooses a new chat or an existing conversation, then routes there with
 * the shared text and attachments prefilled into that composer draft. The user
 * finalizes and sends from the normal composer.
 */
export function MobileShareTarget() {
  const { activeWorkspaceId, updateWorkspaceSession } = useWorkspace();
  const { conversationsById } = useAgentConversations();
  const { composerDrafts, upsertComposerDraft } = useOpenInEditor();
  const { shellView, setShellView } = useShellView();
  const { pushNotification } = useWorkbenchNotifications();

  const [pendingShare, setPendingShare] = useState<MobileSharePayload | null>(null);
  const [applyingTarget, setApplyingTarget] = useState<ShareTarget | null>(null);
  const [query, setQuery] = useState("");

  // Freshest draft store for async upload completions (attachments patches
  // replace the array, so appends must read the latest record).
  const composerDraftsRef = useRef(composerDrafts);
  composerDraftsRef.current = composerDrafts;

  useEffect(() => {
    const onNativeMessage = (event: Event) => {
      const message = (event as CustomEvent<MobileNativeToWebMessage>).detail;
      if (!message || message.type !== "shareIntent") {
        return;
      }
      const share = message.share;
      const hasContent =
        Boolean(share.text?.trim() || share.subject?.trim()) ||
        (share.files?.length ?? 0) > 0;
      if (!hasContent) {
        return;
      }
      setQuery("");
      setApplyingTarget(null);
      setPendingShare(share);
      if ((share.skippedFiles?.length ?? 0) > 0) {
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
          severity: "warning",
          title: "Some attachments were skipped",
          message: `Not shareable (unreadable or too large): ${share.skippedFiles!.join(", ")}`,
          autoDismissMs: 6000,
          compact: true,
        });
      }
    };
    window.addEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, onNativeMessage);
    return () => {
      window.removeEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, onNativeMessage);
    };
  }, [pushNotification]);

  const dismiss = useCallback(() => {
    if (applyingTarget) {
      return;
    }
    setPendingShare(null);
  }, [applyingTarget]);

  useBackHandler(pendingShare != null, BACK_INTENT_PRIORITY.overlay, () => {
    dismiss();
    return true;
  });

  const recentConversations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return Object.values(conversationsById)
      .filter((conversation) => conversation.archivedAt == null)
      .filter(
        (conversation) =>
          normalizedQuery.length === 0 ||
          conversation.title.toLowerCase().includes(normalizedQuery)
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_LISTED_CONVERSATIONS);
  }, [conversationsById, query]);

  const routeToTarget = useCallback(
    (target: ShareTarget) => {
      if (shellView !== "agent") {
        setShellView("agent");
      }
      updateWorkspaceSession((current) => {
        if (target.kind === "new") {
          return {
            ...current,
            agentView: {
              ...current.agentView,
              selectedConversationId: AGENT_NEW_CHAT_SESSION_ID,
            },
          };
        }
        // Mirrors the notification-tap routing in MobileBridgeSync: activate
        // (or create) the chat tab and select it in the agent view.
        const conversationId = target.conversationId;
        const existing = current.chat.tabs.find((tab) => tab.id === conversationId);
        const nextTabs = current.chat.tabs.map((tab) => ({
          ...tab,
          active: tab.id === conversationId,
        }));
        if (!existing) {
          nextTabs.push({
            id: conversationId,
            title: conversationsById[conversationId]?.title ?? "Conversation",
            active: true,
          });
        }
        return {
          ...current,
          chat: { ...current.chat, tabs: nextTabs },
          agentView: {
            ...current.agentView,
            selectedConversationId: conversationId,
          },
        };
      });
    },
    [conversationsById, setShellView, shellView, updateWorkspaceSession]
  );

  const applyShareToTarget = useCallback(
    async (target: ShareTarget) => {
      const share = pendingShare;
      if (!share || applyingTarget) {
        return;
      }
      setApplyingTarget(target);
      try {
        const draftId =
          target.kind === "conversation"
            ? target.conversationId
            : agentWorkspaceComposerDraftId(activeWorkspaceId);
        const draftTitle =
          target.kind === "conversation"
            ? `${conversationsById[target.conversationId]?.title ?? "Conversation"} prompt`
            : "Agent prompt";

        const attachments: ImageAttachment[] = [];
        const failedUploads: string[] = [];
        for (const file of share.files ?? []) {
          if (isInlineImage(file)) {
            attachments.push({
              mimeType: file.mimeType,
              data: file.base64,
              name: file.name,
              kind: "image",
              size: file.byteLength,
            });
            continue;
          }
          // Generic files never travel inline; persist them through the same
          // upload endpoint the composer uses, then reference by savedPath.
          try {
            const uploaded = await uploadAttachments([decodeBase64ToFile(file)]);
            const result = uploaded[0];
            if (!result) {
              throw new Error("Empty upload result");
            }
            attachments.push({
              mimeType: file.mimeType,
              data: "",
              name: result.name ?? file.name,
              kind: "file",
              savedPath: result.path,
              size: file.byteLength,
            });
          } catch {
            failedUploads.push(file.name);
          }
        }

        const text = sharedText(share);
        const existingDraft = composerDraftsRef.current[draftId];
        const existingContent = existingDraft?.content?.replace(/\s+$/, "") ?? "";
        upsertComposerDraft(draftId, {
          title: draftTitle,
          ...(text
            ? { content: existingContent ? `${existingContent}\n${text}` : text }
            : {}),
          ...(attachments.length > 0
            ? { attachments: [...(existingDraft?.attachments ?? []), ...attachments] }
            : {}),
        });

        routeToTarget(target);
        setPendingShare(null);

        if (failedUploads.length > 0) {
          pushNotification({
            kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
            severity: "warning",
            title: "Some attachments failed to upload",
            message: failedUploads.join(", "),
            autoDismissMs: 6000,
            compact: true,
          });
        }
      } finally {
        setApplyingTarget(null);
      }
    },
    [
      activeWorkspaceId,
      applyingTarget,
      conversationsById,
      pendingShare,
      pushNotification,
      routeToTarget,
      upsertComposerDraft,
    ]
  );

  if (!pendingShare) {
    return null;
  }

  const previewText = sharedText(pendingShare);
  const files = pendingShare.files ?? [];
  const busy = applyingTarget != null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10050] flex items-end justify-center sm:items-center sm:px-4"
      role="presentation"
    >
      <div
        className="absolute inset-0 bg-black/55"
        aria-hidden
        onPointerDown={(event) => {
          event.preventDefault();
          dismiss();
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Share to Cesium"
        className="relative flex max-h-[82vh] w-full flex-col overflow-hidden rounded-t-[16px] border border-[var(--border-card)] bg-[var(--bg-panel)] shadow-2xl sm:w-[min(480px,94vw)] sm:rounded-[var(--radius-card)]"
      >
        <div className="mobile-safe-top-pad flex items-center justify-between gap-[8px] border-b border-[var(--palette-divider)] px-[16px] py-[12px]">
          <h2 className="font-sans text-[15px] font-semibold text-[var(--text-primary)]">
            Share to Cesium
          </h2>
          <button
            type="button"
            aria-label="Cancel share"
            onClick={dismiss}
            disabled={busy}
            className="flex size-[28px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
          >
            <X className="size-[15px]" strokeWidth={1.8} />
          </button>
        </div>

        <div className="flex flex-col gap-[8px] border-b border-[var(--palette-divider)] px-[16px] py-[10px]">
          {previewText ? (
            <p className="line-clamp-3 font-sans text-[13px] leading-[1.45] text-[var(--text-secondary)]">
              {previewText}
            </p>
          ) : null}
          {files.length > 0 ? (
            <div className="flex flex-wrap gap-[6px]">
              {files.map((file, index) => (
                <span
                  key={`${file.name}-${index}`}
                  className="flex max-w-full items-center gap-[5px] rounded-[var(--radius-pill)] bg-white/[0.07] px-[8px] py-[3px] font-sans text-[12px] text-[var(--text-secondary)]"
                >
                  {file.mimeType.startsWith("image/") ? (
                    <ImageIcon className="size-[12px] shrink-0" strokeWidth={1.8} />
                  ) : (
                    <FileText className="size-[12px] shrink-0" strokeWidth={1.8} />
                  )}
                  <span className="min-w-0 truncate">{file.name}</span>
                  <span className="shrink-0 opacity-70">{formatByteSize(file.byteLength)}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <button
            type="button"
            data-testid="share-target-new-chat"
            onClick={() => void applyShareToTarget({ kind: "new" })}
            disabled={busy}
            className="flex items-center gap-[10px] px-[16px] py-[12px] text-left transition-colors hover:bg-[var(--accent-bg)] disabled:opacity-60"
          >
            {busy && applyingTarget?.kind === "new" ? (
              <Loader2 className="size-[17px] shrink-0 animate-spin text-[var(--accent)]" strokeWidth={1.8} />
            ) : (
              <MessageSquarePlus className="size-[17px] shrink-0 text-[var(--accent)]" strokeWidth={1.8} />
            )}
            <span className="font-sans text-[14px] font-medium text-[var(--text-primary)]">
              New chat
            </span>
          </button>

          <div className="flex items-center gap-[8px] border-y border-[var(--palette-divider)] px-[16px] py-[8px]">
            <Search className="size-[13px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.8} />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search chats"
              disabled={busy}
              className="w-full bg-transparent font-sans text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)]"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto pb-[max(env(safe-area-inset-bottom),8px)]">
            {recentConversations.length === 0 ? (
              <p className="px-[16px] py-[14px] font-sans text-[13px] text-[var(--text-secondary)]">
                No matching chats.
              </p>
            ) : (
              recentConversations.map((conversation) => {
                const applyingHere =
                  applyingTarget?.kind === "conversation" &&
                  applyingTarget.conversationId === conversation.id;
                return (
                  <button
                    key={conversation.id}
                    type="button"
                    onClick={() =>
                      void applyShareToTarget({
                        kind: "conversation",
                        conversationId: conversation.id,
                      })
                    }
                    disabled={busy}
                    className="flex w-full items-center gap-[10px] px-[16px] py-[11px] text-left transition-colors hover:bg-[var(--accent-bg)] disabled:opacity-60"
                  >
                    {applyingHere ? (
                      <Loader2
                        className="size-[15px] shrink-0 animate-spin text-[var(--text-secondary)]"
                        strokeWidth={1.8}
                      />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate font-sans text-[13px] text-[var(--text-primary)]">
                      {conversation.title}
                    </span>
                    <span className="shrink-0 font-sans text-[11px] text-[var(--text-secondary)]">
                      {formatUpdatedAt(conversation.updatedAt)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
