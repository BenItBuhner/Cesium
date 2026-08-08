"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { useClickOutside } from "@/hooks/useClickOutside";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import {
  popoverMenuFixedPanelClass,
  popoverMenuItemClass,
  popoverMenuListClass,
  popoverMenuSectionLabelClass,
  popoverMenuSeparatorClass,
} from "@/components/ui/popover-menu-ui";
import type { ComposerPillsVisibility } from "@/lib/composer-pills";

const VIEWPORT_PAD = 8;

interface ComposerActionPillsMenuProps {
  open: boolean;
  x: number;
  y: number;
  visibility: ComposerPillsVisibility;
  onVisibilityChange: (next: ComposerPillsVisibility) => void;
  onClose: () => void;
  onOpenSettings: () => void;
}

/**
 * Right-click menu for the composer pill row. Toggles persist per conversation
 * and become the default for new conversations (last-used wins).
 */
export function ComposerActionPillsMenu({
  open,
  x,
  y,
  visibility,
  onVisibilityChange,
  onClose,
  onOpenSettings,
}: ComposerActionPillsMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useClickOutside(menuRef, onClose, open);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  useLayoutEffect(() => {
    if (!open || !menuRef.current) {
      return;
    }
    const el = menuRef.current;
    const rect = el.getBoundingClientRect();
    let left = x;
    let top = y - rect.height - 6;
    if (left + rect.width > window.innerWidth - VIEWPORT_PAD) {
      left = Math.max(VIEWPORT_PAD, window.innerWidth - rect.width - VIEWPORT_PAD);
    }
    if (top < VIEWPORT_PAD) {
      top = y + 6;
    }
    if (left < VIEWPORT_PAD) {
      left = VIEWPORT_PAD;
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [open, x, y]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  const row = (id: string, label: string, key: keyof ComposerPillsVisibility) => (
    <div
      key={key}
      className="flex items-center justify-between gap-[12px] rounded-[var(--radius-tab)] px-[10px] py-[7px]"
    >
      <span id={id} className="font-sans text-[13px] font-normal text-[var(--text-primary)]">
        {label}
      </span>
      <ToggleSwitch
        variant="green"
        checked={visibility[key]}
        labelledBy={id}
        onChange={(checked) => onVisibilityChange({ ...visibility, [key]: checked })}
      />
    </div>
  );

  return createPortal(
    <div
      ref={menuRef}
      className={`${popoverMenuFixedPanelClass} min-w-[230px]`}
      style={{ left: x, top: y }}
      role="menu"
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className={`${popoverMenuListClass} py-[6px]`}>
        <div className={popoverMenuSectionLabelClass}>Status pills</div>
        {row("composer-pills-diff", "Diff line counts", "diff")}
        {row("composer-pills-conflicts", "Merge conflicts", "conflicts")}
        {row("composer-pills-sync", "Ahead / behind upstream", "sync")}
        {row("composer-pills-work", "Background work", "work")}
        <div className={popoverMenuSeparatorClass} />
        {row("composer-pills-actions", "Quick action buttons", "actions")}
        <div className={popoverMenuSeparatorClass} />
        <button type="button" className={popoverMenuItemClass} onClick={onOpenSettings}>
          <span className="flex items-center gap-[7px]">
            <Settings2 className="size-[13px]" strokeWidth={1.8} aria-hidden />
            Configure actions…
          </span>
        </button>
      </div>
    </div>,
    document.body
  );
}
