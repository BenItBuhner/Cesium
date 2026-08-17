"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, Image as ImageIcon, Link as LinkIcon, Loader2, MessageSquarePlus, X } from "lucide-react";
import { useAgentShellState } from "@/components/agent/AgentShellStateContext";
import {
  AGENT_STANDALONE_COMPOSER_DRAFT_ID,
  agentWorkspaceComposerDraftId,
  useOpenInEditor,
} from "@/components/editor/OpenInEditorContext";
import {
  BACK_INTENT_PRIORITY,
  useBackHandler,
} from "@/components/mobile/BackIntentContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { uploadAttachments } from "@/lib/server-api";
import type { AgentRailConversationSummary } from "@/lib/agent-types";
import { isStandaloneChatWorkspace } from "@/lib/types";
import type { ImageAttachment } from "@/lib/types";
import {
  MOBILE_BRIDGE_MESSAGE_EVENT,
  type MobileNativeToWebMessage,
  type MobileSharePayload,
  type MobileSharedItem,
} from "@/lib/mobile-bridge";

const MAX_PICKER_CONVERSATIONS = 30;
const SHARE_DRAFT_TITLE = "Agent prompt";

type ShareTarget =
  | { kind: "new" }
  | { kind: "conversation"; summary: AgentRailConversationSummary };

function base64ToFile(item: MobileSharedItem): File {
  const binary = atob(item.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], item.name, {
    type: item.mimeType || "application/octet-stream",
  });
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function buildSharedText(payload: MobileSharePayload): string {
  const subject = payload.subject?.trim() ?? "";
  const text = payload.text?.trim() ?? "";
  if (subject && text && !text.includes(subject)) {
    return `${subject}\n${text}`;
  }
  return text || subject;
}

/**
 * Mobile share-sheet intake: when the Android shell forwards an ACTION_SEND /
 * ACTION_SEND_MULTIPLE payload over the bridge, this sheet lets the user start
 * a new chat or pick a recent conversation. The shared files are uploaded via
 * the normal attachments endpoint and, together with the shared text, staged
 * into that chat's composer draft — the user reviews and sends the message
 * themselves through the existing composer.
 */
export function MobileShareIntake() {
  const {
    activeWorkspaceGroup,
    groups,
    openConversationSummary,
    standaloneDraftActive,
    startNewConversation,
  } = useAgentShellState();
  const { activeWorkspaceId } = useWorkspace();
  const { upsertComposerDraft } = useOpenInEditor();
  const [payload, setPayload] = useState<MobileSharePayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onBridgeMessage = (event: Event) => {
      const message = (event as CustomEvent<MobileNativeToWebMessage>).detail;
      if (!message || message.type !== "shareIntake") {
        return;
      }
      setPayload(message.payload);
      setError(null);
      setBusy(false);
    };
    window.addEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, onBridgeMessage);
    return () => {
      window.removeEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, onBridgeMessage);
    };
  }, []);

  const dismiss = useCallback(() => {
    if (busy) return;
    setPayload(null);
    setError(null);
  }, [busy]);

  useBackHandler(payload != null, BACK_INTENT_PRIORITY.overlay, () => {
    if (busy) return true;
    setPayload(null);
    setError(null);
    return true;
  });

  const recentConversations = useMemo(() => {
    const workspaceNameById = new Map<string, string>();
    const flattened: AgentRailConversationSummary[] = [];
    for (const group of groups) {
      workspaceNameById.set(group.workspace.id, group.workspace.name);
      for (const conversation of group.conversations) {
        if (conversation.archivedAt) continue;
        flattened.push(conversation);
      }
    }
    flattened.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return flattened.slice(0, MAX_PICKER_CONVERSATIONS).map((conversation) => ({
      summary: conversation,
      workspaceName: workspaceNameById.get(conversation.workspaceId) ?? null,
    }));
  }, [groups]);

  const prepareAttachments = useCallback(
    async (items: MobileSharedItem[]): Promise<ImageAttachment[]> => {
      const attachments: ImageAttachment[] = [];
      // One upload per file mirrors the composer's own attach flow and keeps
      // item ↔ upload-result pairing unambiguous.
      for (const item of items) {
        const file = base64ToFile(item);
        const [uploaded] = await uploadAttachments([file]);
        const isImage = item.mimeType.startsWith("image/");
        attachments.push({
          mimeType: item.mimeType,
          // Images travel inline to vision models; generic files are
          // referenced by their uploaded workspace path instead.
          data: isImage ? item.base64 : "",
          name: uploaded?.name ?? item.name,
          kind: isImage ? "image" : "file",
          ...(uploaded?.path ? { savedPath: uploaded.path } : {}),
          size: item.byteLength,
        });
      }
      return attachments;
    },
    []
  );

  const applyToDraft = useCallback(
    (draftId: string, sharedText: string, attachments: ImageAttachment[]) => {
      upsertComposerDraft(draftId, {
        title: SHARE_DRAFT_TITLE,
        ...(sharedText ? { content: sharedText } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      });
    },
    [upsertComposerDraft]
  );

  const handleSelect = useCallback(
    async (target: ShareTarget) => {
      if (!payload || busy) return;
      setBusy(true);
      setError(null);
      try {
        const sharedText = buildSharedText(payload);
        const attachments = await prepareAttachments(payload.items);
        if (target.kind === "conversation") {
          await openConversationSummary(target.summary);
          applyToDraft(target.summary.id, sharedText, attachments);
        } else {
          startNewConversation();
          // Mirror AgentNewChatLanding's draft-id choice so the prefill lands
          // in the composer the landing actually renders.
          const draftId =
            standaloneDraftActive ||
            !activeWorkspaceId ||
            (activeWorkspaceGroup != null &&
              isStandaloneChatWorkspace(activeWorkspaceGroup.workspace))
              ? AGENT_STANDALONE_COMPOSER_DRAFT_ID
              : agentWorkspaceComposerDraftId(activeWorkspaceGroup?.workspace.id);
          applyToDraft(draftId, sharedText, attachments);
        }
        setPayload(null);
      } catch {
        setError("Could not prepare the shared attachments. Check the server connection and try again.");
      } finally {
        setBusy(false);
      }
    },
    [
      activeWorkspaceGroup,
      activeWorkspaceId,
      applyToDraft,
      busy,
      openConversationSummary,
      payload,
      prepareAttachments,
      standaloneDraftActive,
      startNewConversation,
    ]
  );

  if (!payload || typeof document === "undefined") {
    return null;
  }

  const sharedText = buildSharedText(payload);
  const isLikelyLink = /^https?:\/\/\S+$/i.test(sharedText.trim());

  return createPortal(
    // Longhand positioning (not `inset-0`): the `inset` shorthand only landed in
    // Chromium 87, and stock Android 11 WebViews still ship Chromium 83.
    <div className="fixed bottom-0 left-0 right-0 top-0 z-[10060] flex items-end justify-center sm:items-center">
      <div
        // Plain rgba (not `bg-black/50`): Tailwind 4 opacity modifiers compile to
        // color-mix(), which Chromium < 111 drops, leaving the backdrop invisible.
        className="absolute bottom-0 left-0 right-0 top-0 bg-[rgba(0,0,0,0.5)]"
        onClick={dismiss}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Share to Cesium"
        className="relative flex max-h-[80vh] w-full max-w-[430px] flex-col overflow-hidden rounded-t-[16px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] shadow-2xl sm:rounded-[16px]"
      >
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-[16px] py-[12px]">
          <div className="text-[14px] font-semibold text-[var(--text-primary)]">
            Share to Cesium
          </div>
          <button
            type="button"
            onClick={dismiss}
            disabled={busy}
            aria-label="Dismiss share"
            className="flex size-[24px] items-center justify-center rounded-[6px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            <X className="size-[15px]" strokeWidth={1.75} />
          </button>
        </div>

        <div className="border-b border-[var(--border-subtle)] px-[16px] py-[10px]">
          {sharedText ? (
            <div className="mb-[6px] flex items-start gap-[6px]">
              {isLikelyLink ? (
                <LinkIcon className="mt-[2px] size-[13px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.75} />
              ) : (
                <FileText className="mt-[2px] size-[13px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.75} />
              )}
              <div className="line-clamp-2 min-w-0 break-words text-[12px] text-[var(--text-secondary)]">
                {sharedText}
              </div>
            </div>
          ) : null}
          {payload.items.length > 0 ? (
            <div className="flex flex-wrap gap-[6px]">
              {payload.items.map((item, index) => (
                <span
                  key={`${item.name}-${index}`}
                  className="inline-flex max-w-full items-center gap-[5px] rounded-[6px] border border-[var(--border-subtle)] bg-[var(--bg-card)] px-[7px] py-[3px] text-[11px] text-[var(--text-secondary)]"
                >
                  {item.mimeType.startsWith("image/") ? (
                    <ImageIcon className="size-[11px] shrink-0" strokeWidth={1.75} />
                  ) : (
                    <FileText className="size-[11px] shrink-0" strokeWidth={1.75} />
                  )}
                  <span className="truncate">{item.name}</span>
                  <span className="shrink-0 opacity-70">{formatByteSize(item.byteLength)}</span>
                </span>
              ))}
            </div>
          ) : null}
          {payload.skippedCount ? (
            <div className="mt-[6px] text-[11px] text-[var(--text-secondary)]">
              {payload.skippedCount} item{payload.skippedCount === 1 ? "" : "s"} skipped (too large or unreadable).
            </div>
          ) : null}
        </div>

        {error ? (
          <div className="border-b border-[var(--border-subtle)] px-[16px] py-[8px] text-[12px] text-red-400">
            {error}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[8px] py-[8px]">
          <button
            type="button"
            onClick={() => void handleSelect({ kind: "new" })}
            disabled={busy}
            className="flex w-full items-center gap-[10px] rounded-[10px] px-[10px] py-[10px] text-left transition-colors hover:bg-[var(--bg-card)] disabled:opacity-60"
          >
            <span className="flex size-[30px] shrink-0 items-center justify-center rounded-[8px] bg-[var(--accent)]/15 text-[var(--accent)]">
              <MessageSquarePlus className="size-[16px]" strokeWidth={1.75} />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-[var(--text-primary)]">
                New chat
              </span>
              <span className="block text-[11px] text-[var(--text-secondary)]">
                Start a fresh conversation with this content
              </span>
            </span>
          </button>

          {recentConversations.length > 0 ? (
            <>
              <div className="px-[10px] pb-[4px] pt-[10px] text-[11px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">
                Add to a recent chat
              </div>
              {recentConversations.map(({ summary, workspaceName }) => (
                <button
                  key={summary.id}
                  type="button"
                  onClick={() => void handleSelect({ kind: "conversation", summary })}
                  disabled={busy}
                  className="flex w-full items-center gap-[10px] rounded-[10px] px-[10px] py-[8px] text-left transition-colors hover:bg-[var(--bg-card)] disabled:opacity-60"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] text-[var(--text-primary)]">
                      {summary.title || "Untitled conversation"}
                    </span>
                    {workspaceName ? (
                      <span className="block truncate text-[11px] text-[var(--text-secondary)]">
                        {workspaceName}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </>
          ) : null}
        </div>

        {busy ? (
          <div className="flex items-center gap-[8px] border-t border-[var(--border-subtle)] px-[16px] py-[10px] text-[12px] text-[var(--text-secondary)]">
            <Loader2 className="size-[14px] animate-spin" strokeWidth={1.75} />
            Preparing attachments...
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
