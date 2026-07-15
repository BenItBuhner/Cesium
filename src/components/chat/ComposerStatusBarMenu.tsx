"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useClickOutside } from "@/hooks/useClickOutside";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import {
  popoverMenuFixedPanelClass,
  popoverMenuListClass,
} from "@/components/ui/popover-menu-ui";
import type { ComposerStatusBarVisibility } from "@/lib/composer-status-bar";

const VIEWPORT_PAD = 8;

interface ComposerStatusBarMenuProps {
  open: boolean;
  x: number;
  y: number;
  visibility: ComposerStatusBarVisibility;
  onVisibilityChange: (next: ComposerStatusBarVisibility) => void;
  onClose: () => void;
}

export function ComposerStatusBarMenu({
  open,
  x,
  y,
  visibility,
  onVisibilityChange,
  onClose,
}: ComposerStatusBarMenuProps) {
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

  const row = (id: string, label: string, key: keyof ComposerStatusBarVisibility) => (
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
      className={`${popoverMenuFixedPanelClass} min-w-[200px]`}
      style={{ left: x, top: y }}
      role="menu"
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className={`${popoverMenuListClass} py-[6px]`}>
        {row("composer-status-repo", "Repo", "repo")}
        {row("composer-status-branch", "Branch", "branch")}
        {row("composer-status-goal", "Burn progress", "goal")}
        {row("composer-status-context", "Context", "context")}
      </div>
    </div>,
    document.body
  );
}
