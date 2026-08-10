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

/**
 * Module-scope park for the pending share. Workbench providers can remount
 * their subtree during workspace bootstrap; React state would lose the share,
 * but this store lets a remounted picker pick it right back up.
 */
let parkedShare: MobileSharePayload | null = null;

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

  const [pendingShare, setPendingShare] = useState<MobileSharePayload | null>(
    () => parkedShare
  );
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
      parkedShare = share;
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
    parkedShare = null;
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
        parkedShare = null;
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

  // Styling note: everything load-bearing is inline. The bundled workbench
  // runs on Android 11's Chromium 83 WebView, where Tailwind v4's @layer-based
  // output is largely ignored — utility classes (even `fixed inset-0`) never
  // apply, so a class-styled overlay renders as an invisible static block.
  const textPrimary = "var(--text-primary, #f2f2f2)";
  const textSecondary = "var(--text-secondary, #a3a3a3)";
  const divider = "1px solid var(--palette-divider, rgba(127,127,127,0.35))";
  const rowButtonStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    padding: "12px 16px",
    textAlign: "left",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    opacity: busy ? 0.6 : 1,
  };

  return createPortal(
    <div
      role="presentation"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 10050,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
    >
      <div
        aria-hidden
        onPointerDown={(event) => {
          event.preventDefault();
          dismiss();
        }}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(0,0,0,0.55)",
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Share to Cesium"
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          width: "100%",
          maxWidth: 520,
          maxHeight: "82vh",
          overflow: "hidden",
          borderRadius: "16px 16px 0 0",
          border: "1px solid var(--border-card, rgba(127,127,127,0.4))",
          background: "var(--bg-panel, #202020)",
          color: textPrimary,
          boxShadow: "0 -12px 40px rgba(0,0,0,0.45)",
          fontFamily: "var(--font-sans, system-ui, sans-serif)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            borderBottom: divider,
            padding: "12px 16px",
          }}
        >
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: textPrimary }}>
            Share to Cesium
          </h2>
          <button
            type="button"
            aria-label="Cancel share"
            onClick={dismiss}
            disabled={busy}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              flexShrink: 0,
              borderRadius: 6,
              border: "none",
              background: "transparent",
              color: textSecondary,
              cursor: "pointer",
            }}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>

        {previewText || files.length > 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              borderBottom: divider,
              padding: "10px 16px",
            }}
          >
            {previewText ? (
              <p
                style={{
                  margin: 0,
                  fontSize: 13,
                  lineHeight: 1.45,
                  color: textSecondary,
                  overflow: "hidden",
                  display: "-webkit-box",
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: "vertical",
                }}
              >
                {previewText}
              </p>
            ) : null}
            {files.length > 0 ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {files.map((file, index) => (
                  <span
                    key={`${file.name}-${index}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      maxWidth: "100%",
                      borderRadius: 999,
                      background: "rgba(127,127,127,0.18)",
                      padding: "3px 8px",
                      fontSize: 12,
                      color: textSecondary,
                    }}
                  >
                    {file.mimeType.startsWith("image/") ? (
                      <ImageIcon size={12} strokeWidth={1.8} style={{ flexShrink: 0 }} />
                    ) : (
                      <FileText size={12} strokeWidth={1.8} style={{ flexShrink: 0 }} />
                    )}
                    <span
                      style={{
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {file.name}
                    </span>
                    <span style={{ flexShrink: 0, opacity: 0.7 }}>
                      {formatByteSize(file.byteLength)}
                    </span>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
          <button
            type="button"
            data-testid="share-target-new-chat"
            onClick={() => void applyShareToTarget({ kind: "new" })}
            disabled={busy}
            style={rowButtonStyle}
          >
            {busy && applyingTarget?.kind === "new" ? (
              <Loader2
                size={17}
                strokeWidth={1.8}
                style={{ flexShrink: 0, color: "var(--accent, #6ea8fe)" }}
                className="animate-spin"
              />
            ) : (
              <MessageSquarePlus
                size={17}
                strokeWidth={1.8}
                style={{ flexShrink: 0, color: "var(--accent, #6ea8fe)" }}
              />
            )}
            <span style={{ fontSize: 14, fontWeight: 500, color: textPrimary }}>
              New chat
            </span>
          </button>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              borderTop: divider,
              borderBottom: divider,
              padding: "8px 16px",
            }}
          >
            <Search size={13} strokeWidth={1.8} style={{ flexShrink: 0, color: textSecondary }} />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search chats"
              disabled={busy}
              style={{
                width: "100%",
                background: "transparent",
                border: "none",
                outline: "none",
                fontSize: 13,
                color: textPrimary,
              }}
            />
          </div>

          <div
            style={{
              minHeight: 0,
              flex: 1,
              overflowY: "auto",
              paddingBottom: "max(env(safe-area-inset-bottom), 8px)",
            }}
          >
            {recentConversations.length === 0 ? (
              <p style={{ margin: 0, padding: "14px 16px", fontSize: 13, color: textSecondary }}>
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
                    style={{ ...rowButtonStyle, padding: "11px 16px" }}
                  >
                    {applyingHere ? (
                      <Loader2
                        size={15}
                        strokeWidth={1.8}
                        style={{ flexShrink: 0, color: textSecondary }}
                        className="animate-spin"
                      />
                    ) : null}
                    <span
                      style={{
                        minWidth: 0,
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 13,
                        color: textPrimary,
                        textAlign: "left",
                      }}
                    >
                      {conversation.title}
                    </span>
                    <span style={{ flexShrink: 0, fontSize: 11, color: textSecondary }}>
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
