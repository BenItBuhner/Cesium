"use client";

import { useEffect, useState, type DragEvent, type MouseEvent } from "react";
import { Loader, X } from "lucide-react";
import { buildBrowserProxyUrl } from "@/lib/browser-proxy-url";
import { fileTypeIcons, type FileTypeIconKind } from "@/lib/file-type-icons";
import { getServerBaseUrl } from "@/lib/server-api";
import type { EditorTab as EditorTabType } from "@/lib/types";
import type { EditorGroup } from "./editor-panel-state";
import { TAB_DND_MIME } from "./editor-panel-state";
import { setMinimalTabDragImage } from "./tab-drag-image";

const tabIconToKind: Record<EditorTabType["icon"], FileTypeIconKind> = {
  terminal: "shell",
  json: "json",
  markdown: "markdown",
  agent: "agent",
  subagent: "subagent",
  typescript: "typescript",
  css: "css",
  default: "default",
  settings: "settings",
  browser: "browser",
};

interface EditorTabProps {
  tab: EditorTabType;
  group: EditorGroup;
  isActive: boolean;
  /** Drag between panes only when split. */
  dragEnabled?: boolean;
  /** Agent conversation: tool permission / approval pending. */
  agentNeedsAttention?: boolean;
  /** Agent conversation: turn in flight (spinner replaces tab icon). */
  agentRunning?: boolean;
  /** Agent conversation: idle with a completed turn not yet focused by the user. */
  agentUnreadCompletion?: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onContextMenu?: (e: MouseEvent) => void;
}

export function EditorTab({
  tab,
  group,
  isActive,
  dragEnabled = false,
  agentNeedsAttention = false,
  agentRunning = false,
  agentUnreadCompletion = false,
  onSelect,
  onClose,
  onContextMenu,
}: EditorTabProps) {
  const kind = tabIconToKind[tab.icon];
  const { Icon, className: iconClass } = fileTypeIcons[kind];
  const [faviconFailed, setFaviconFailed] = useState(false);
  const faviconSrc =
    tab.browser?.faviconUrl &&
    buildBrowserProxyUrl(getServerBaseUrl(), tab.browser.faviconUrl);

  useEffect(() => {
    setFaviconFailed(false);
  }, [tab.browser?.faviconUrl]);

  const surface = isActive
    ? "var(--bg-tab-active)"
    : "var(--bg-tab-inactive)";

  function handleDragStart(e: DragEvent) {
    e.dataTransfer.setData(
      TAB_DND_MIME,
      JSON.stringify({ tabId: tab.id, group })
    );
    e.dataTransfer.effectAllowed = "move";
    setMinimalTabDragImage(e.dataTransfer);
  }

  const agentAria =
    agentNeedsAttention && tab.conversationId
      ? ", approval needed"
      : agentRunning && tab.conversationId
        ? ", in progress"
        : agentUnreadCompletion && tab.conversationId
          ? ", new response"
          : "";
  const baseLabel = tab.dirty ? `${tab.name}, unsaved changes` : tab.name;
  const ariaLabel = `${baseLabel}${agentAria}`;

  return (
    <button
      type="button"
      draggable={dragEnabled}
      onDragStart={dragEnabled ? handleDragStart : undefined}
      onClick={() => onSelect(tab.id)}
      onContextMenu={onContextMenu}
      aria-label={ariaLabel}
      className={`group relative inline-flex h-[36px] max-w-[220px] shrink-0 items-center overflow-hidden rounded-[var(--radius-tab)] transition-colors ${dragEnabled ? "cursor-grab active:cursor-grabbing" : ""}`}
      style={{ background: surface }}
    >
      <span className="ml-[9px] flex shrink-0 items-center gap-[6px]">
        {agentNeedsAttention && tab.conversationId ? (
          <span
            className="size-[7px] shrink-0 rounded-full bg-[var(--tab-agent-attention-dot)]"
            title="Approval or permission needed"
            aria-hidden
          />
        ) : agentUnreadCompletion && tab.conversationId ? (
          <span
            className="size-[7px] shrink-0 rounded-full bg-[var(--tab-unread-completion-dot)]"
            title="New response ready"
            aria-hidden
          />
        ) : null}
        <span className="flex size-[18px] items-center justify-center">
          {agentRunning && tab.conversationId ? (
            <Loader
              className="size-[18px] shrink-0 text-[var(--text-secondary)] animate-spin"
              strokeWidth={1.5}
              aria-hidden
            />
          ) : faviconSrc && !faviconFailed ? (
            // Proxied arbitrary URLs; next/image is not appropriate here.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={faviconSrc}
              alt=""
              className="size-[18px] rounded-[3px] object-contain"
              onError={() => setFaviconFailed(true)}
            />
          ) : (
            <Icon className={`size-[18px] shrink-0 ${iconClass}`} strokeWidth={1.5} aria-hidden />
          )}
        </span>
      </span>
      <span className="ml-[7px] min-w-0 flex-1 truncate text-left font-sans text-[14px] font-normal text-[var(--text-secondary)]">
        {tab.name}
      </span>
      <div className="relative mr-[6px] flex size-[22px] shrink-0 items-center justify-center">
        {tab.dirty ? (
          <span
            className="pointer-events-none size-[8px] rounded-full bg-white group-hover:hidden"
            aria-hidden
          />
        ) : null}
        <span
          role="button"
          tabIndex={0}
          draggable={false}
          onDragStart={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose(tab.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              onClose(tab.id);
            }
          }}
          className={`absolute inset-0 flex items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-opacity hover:text-[var(--text-primary)] ${
            tab.dirty
              ? "pointer-events-none hidden opacity-100 group-hover:pointer-events-auto group-hover:flex"
              : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"
          }`}
          aria-label={`Close ${tab.name}`}
        >
          <X className="size-[18px]" strokeWidth={1.5} />
        </span>
      </div>
    </button>
  );
}
