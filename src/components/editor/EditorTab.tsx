"use client";

import { useEffect, useState, type DragEvent } from "react";
import { X } from "lucide-react";
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
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

export function EditorTab({
  tab,
  group,
  isActive,
  dragEnabled = false,
  onSelect,
  onClose,
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

  return (
    <button
      type="button"
      draggable={dragEnabled}
      onDragStart={dragEnabled ? handleDragStart : undefined}
      onClick={() => onSelect(tab.id)}
      className={`group relative flex h-[36px] w-[220px] shrink-0 items-center overflow-hidden rounded-[var(--radius-tab)] transition-colors ${dragEnabled ? "cursor-grab active:cursor-grabbing" : ""}`}
      style={{ background: surface }}
    >
      <span className="ml-[9px] flex size-[18px] shrink-0 items-center justify-center">
        {faviconSrc && !faviconFailed ? (
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
      <span className="ml-[7px] truncate font-sans text-[14px] font-normal text-[var(--text-secondary)]">
        {tab.name}
      </span>
      {tab.dirty ? (
        <span
          className="ml-[6px] size-[6px] shrink-0 rounded-full bg-[var(--accent)]"
          aria-label="Unsaved changes"
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
        className="absolute right-[9px] text-[var(--text-secondary)] opacity-0 transition-opacity hover:text-[var(--text-primary)] group-hover:opacity-100"
        aria-label={`Close ${tab.name}`}
      >
        <X className="size-[18px]" strokeWidth={1.5} />
      </span>
    </button>
  );
}
