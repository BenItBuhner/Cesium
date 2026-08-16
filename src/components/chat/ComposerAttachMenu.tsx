"use client";

import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { ImageIcon, Link2, Paperclip, Plus } from "lucide-react";
import { useClickOutside } from "@/hooks/useClickOutside";
import { usePopover } from "@/hooks/usePopover";

interface ComposerAttachMenuProps {
  /** Opens the OS picker restricted to media (images). */
  onPickMedia: () => void;
  /** Opens the OS picker accepting any file type. */
  onPickFiles: () => void;
  /** Prompts for / attaches a URL as a title+favicon link pill. */
  onAttachLink?: () => void;
  disabled?: boolean;
  /** `plus` renders the round docked + button; `icon` the flat toolbar glyph. */
  variant: "plus" | "icon";
  popoverPlacement?: "above" | "below";
}

/**
 * Attach button for the chat composer. Instead of jumping straight into an
 * image-only OS picker, it pops a small Files / Media / Link menu: Media keeps the
 * classic image picker, Files accepts absolutely anything, Link resolves a URL
 * into a title + favicon pill.
 */
export function ComposerAttachMenu({
  onPickMedia,
  onPickFiles,
  onAttachLink,
  disabled = false,
  variant,
  popoverPlacement = "above",
}: ComposerAttachMenuProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { triggerRef, popoverRef, position, ready } = usePopover(open, {
    placement: popoverPlacement,
  });
  useClickOutside(triggerRef, close, open, [popoverRef]);

  const pick = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div ref={triggerRef} className="inline-flex shrink-0">
      {variant === "plus" ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={disabled}
          className="composer-attach-plus flex size-[var(--d2-composer-plus-size)] shrink-0 touch-manipulation items-center justify-center rounded-full border border-[var(--agent-border)] bg-[var(--agent-plus-button-bg)] text-[var(--agent-plus-button-icon)] transition-colors hover:bg-[var(--agent-plus-button-bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Attach files, media, or link"
          aria-expanded={open}
          title="Attach files, media, or link"
        >
          <Plus className="size-[14px] shrink-0" strokeWidth={2} aria-hidden />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={disabled}
          className="-m-[4px] touch-manipulation p-[4px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Attach files, media, or link"
          aria-expanded={open}
          title="Attach files, media, or link"
        >
          <Paperclip className="size-[14px] shrink-0" strokeWidth={1.5} aria-hidden />
        </button>
      )}

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-[10050] min-w-[168px] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] p-[4px] shadow-lg"
            data-ide-input-sink
            data-ide-composer-floating-popover
            style={{
              ...(position.top != null
                ? { top: position.top }
                : { bottom: position.bottom ?? 0 }),
              left: position.left,
              opacity: ready ? 1 : 0,
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => pick(onPickFiles)}
              className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12.5px] text-[var(--text-primary)] outline-none transition-colors hover:bg-[var(--accent-bg)] focus-visible:bg-[var(--accent-bg)]"
            >
              <Paperclip className="size-[14px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.6} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block leading-[16px]">Files</span>
                <span className="block text-[10.5px] leading-[14px] text-[var(--text-secondary)]">
                  Upload any file type
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => pick(onPickMedia)}
              className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12.5px] text-[var(--text-primary)] outline-none transition-colors hover:bg-[var(--accent-bg)] focus-visible:bg-[var(--accent-bg)]"
            >
              <ImageIcon className="size-[14px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.6} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block leading-[16px]">Media</span>
                <span className="block text-[10.5px] leading-[14px] text-[var(--text-secondary)]">
                  Photos and images
                </span>
              </span>
            </button>
            {onAttachLink ? (
              <button
                type="button"
                onClick={() => pick(onAttachLink)}
                className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12.5px] text-[var(--text-primary)] outline-none transition-colors hover:bg-[var(--accent-bg)] focus-visible:bg-[var(--accent-bg)]"
              >
                <Link2 className="size-[14px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.6} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block leading-[16px]">Link</span>
                  <span className="block text-[10.5px] leading-[14px] text-[var(--text-secondary)]">
                    Attach a URL with title
                  </span>
                </span>
              </button>
            ) : null}
          </div>,
          document.body
        )}
    </div>
  );
}
