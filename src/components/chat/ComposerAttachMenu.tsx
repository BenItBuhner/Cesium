"use client";

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ImageIcon, Paperclip, Plus } from "lucide-react";
import { ComposerCommandPanel } from "@/components/chat/ComposerCommandPanel";
import { useClickOutside } from "@/hooks/useClickOutside";
import {
  hasVisibleFollowingSibling,
  positionComposerCommandPanel,
  resolveComposerCommandPanelPlacement,
  type ComposerCommandPanelPosition,
} from "@/lib/composer-command-panel";

interface ComposerAttachMenuProps {
  /** Opens the OS picker restricted to media (images). */
  onPickMedia: () => void;
  /** Opens the OS picker accepting any file type. */
  onPickFiles: () => void;
  disabled?: boolean;
  /** `plus` renders the round docked + button; `icon` the flat toolbar glyph. */
  variant: "plus" | "icon";
  /** Composer shell used to match the full-width command panel. */
  anchorRef?: RefObject<HTMLElement | null>;
  composerLayout?: "docked-bottom" | "empty-top";
  composerExpanded?: boolean;
  /** Force-close when the slash command panel is already open. */
  suppressed?: boolean;
}

export function ComposerAttachMenu({
  onPickMedia,
  onPickFiles,
  disabled = false,
  variant,
  anchorRef,
  composerLayout = "docked-bottom",
  composerExpanded = false,
  suppressed = false,
}: ComposerAttachMenuProps) {
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [position, setPosition] = useState<ComposerCommandPanelPosition>({
    placement: "above",
    bottom: 100,
    left: 8,
    width: 320,
    maxHeight: 280,
  });
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  useClickOutside(triggerRef, close, open, [popoverRef]);

  useLayoutEffect(() => {
    if (suppressed && open) {
      setOpen(false);
    }
  }, [open, suppressed]);

  useLayoutEffect(() => {
    if (!open) {
      setReady(false);
      return;
    }
    const update = () => {
      const anchor = anchorRef?.current ?? triggerRef.current;
      if (!anchor) {
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const placement = resolveComposerCommandPanelPlacement({
        layout: composerLayout,
        isExpanded: composerExpanded,
        hasBeneathWidgets: hasVisibleFollowingSibling(anchor),
      });
      setPosition(
        positionComposerCommandPanel(
          {
            left: rect.left,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
          },
          placement,
          { width: window.innerWidth, height: window.innerHeight }
        )
      );
      setReady(true);
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, composerExpanded, composerLayout, open]);

  const pick = (action: () => void) => {
    setOpen(false);
    action();
  };

  const rowClass =
    "flex w-full items-start gap-[10px] rounded-[var(--radius-tab)] px-[10px] py-[8px] text-left font-sans outline-none transition-colors hover:bg-[var(--accent-bg)] focus-visible:bg-[var(--accent-bg)]";

  return (
    <div ref={triggerRef} className="inline-flex shrink-0">
      {variant === "plus" ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          disabled={disabled || suppressed}
          className="composer-attach-plus flex size-[var(--d2-composer-plus-size)] shrink-0 touch-manipulation items-center justify-center rounded-full border border-[var(--agent-border)] bg-[var(--agent-plus-button-bg)] text-[var(--agent-plus-button-icon)] transition-colors hover:bg-[var(--agent-plus-button-bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Attach files or media"
          aria-expanded={open}
          title="Attach files or media"
        >
          <Plus className="size-[14px] shrink-0" strokeWidth={2} aria-hidden />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          disabled={disabled || suppressed}
          className="-m-[4px] touch-manipulation p-[4px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Attach files or media"
          aria-expanded={open}
          title="Attach files or media"
        >
          <Paperclip className="size-[14px] shrink-0" strokeWidth={1.5} aria-hidden />
        </button>
      )}

      {open ? (
        <ComposerCommandPanel
          ariaLabel="Attach"
          position={position}
          popoverRef={popoverRef}
          ready={ready}
          search={{
            value: "",
            placeholder: "Search files, media...",
          }}
        >
          <div className="flex flex-col p-[6px]">
            <button type="button" onClick={() => pick(onPickFiles)} className={rowClass}>
              <Paperclip
                className="mt-[1px] size-[15px] shrink-0 text-[var(--text-secondary)]"
                strokeWidth={1.6}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="block font-sans text-[13px] text-[var(--text-primary)]">
                  Files
                </span>
                <span className="mt-[1px] block font-sans text-[11px] leading-[15px] text-[var(--text-secondary)]">
                  Upload any file type
                </span>
              </span>
            </button>
            <button type="button" onClick={() => pick(onPickMedia)} className={rowClass}>
              <ImageIcon
                className="mt-[1px] size-[15px] shrink-0 text-[var(--text-secondary)]"
                strokeWidth={1.6}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="block font-sans text-[13px] text-[var(--text-primary)]">
                  Media
                </span>
                <span className="mt-[1px] block font-sans text-[11px] leading-[15px] text-[var(--text-secondary)]">
                  Photos and images
                </span>
              </span>
            </button>
          </div>
        </ComposerCommandPanel>
      ) : null}
    </div>
  );
}
