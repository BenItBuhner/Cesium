"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, LogOut, Server, UserRound } from "lucide-react";
import { SignOutButton } from "@clerk/nextjs";
import { AccountAvatar } from "@/components/account/AccountAvatar";
import { useCloudContext } from "@/contexts/CloudContext";
import { useShellView } from "@/components/layout/ShellViewContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useWorkbenchAccess } from "@/lib/workbench-access";

export function AccountRailButton({
  compact = false,
}: {
  compact?: boolean;
}) {
  const access = useWorkbenchAccess();
  const cloud = useCloudContext();
  const { openSettingsView } = useShellView();
  const { updateWorkspaceSession } = useWorkspace();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  const openAccountSettings = () => {
    setOpen(false);
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: { ...current.settingsView, activeNav: "account" },
    }));
    openSettingsView();
  };

  const openServersSettings = () => {
    setOpen(false);
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: { ...current.settingsView, activeNav: "servers" },
    }));
    openSettingsView();
  };

  const signedIn = access.accountKind === "signed-in";
  const label = access.displayName;
  const subtitle = signedIn
    ? access.email
    : access.isGuest
      ? "Guest · local engine"
      : access.accountKind === "local-only"
        ? "Local-only"
        : "Sign in to sync";

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          if (signedIn || access.accountKind === "device" || access.isGuest) {
            setOpen((current) => !current);
            return;
          }
          openAccountSettings();
        }}
        className="flex min-w-0 flex-1 items-center gap-[8px] rounded-[var(--radius-tab)] py-[2px] text-left hover:bg-[var(--bg-card)]"
        aria-label={signedIn ? `Account (${label})` : label}
        aria-expanded={open}
        aria-haspopup="menu"
        title={subtitle ?? label}
      >
        <AccountAvatar name={label} imageUrl={access.imageUrl} size={compact ? 18 : 18} />
        <span className="min-w-0 flex-1 truncate font-sans text-[13px] text-[var(--text-primary)]">
          {label}
        </span>
        <ChevronDown
          className="size-[14px] shrink-0 text-[var(--text-secondary)]"
          strokeWidth={1.5}
          aria-hidden
        />
      </button>
      <AccountRailMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={buttonRef}
        onOpenAccount={openAccountSettings}
        onOpenServers={openServersSettings}
        showSignOut={signedIn && cloud.mode === "clerk"}
      />
    </>
  );
}

function AccountRailMenu({
  open,
  onClose,
  anchorRef,
  onOpenAccount,
  onOpenServers,
  showSignOut,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  onOpenAccount: () => void;
  onOpenServers: () => void;
  showSignOut: boolean;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 260 });

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      return;
    }
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(280, Math.max(220, rect.width + 48));
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const estimatedHeight = menuRef.current?.offsetHeight ?? 160;
      const top = Math.max(8, rect.top - estimatedHeight - 6);
      setPos({ top, left, width });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        (menuRef.current?.contains(target) || anchorRef.current?.contains(target))
      ) {
        return;
      }
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [anchorRef, onClose, open]);

  if (!open) {
    return null;
  }

  const itemClass =
    "flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[7px] text-left font-sans text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--accent-bg)]";

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Account"
      className="fixed z-[10050] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] p-[4px] shadow-lg"
      style={{ top: pos.top, left: pos.left, width: pos.width }}
      data-ide-input-sink
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button type="button" role="menuitem" className={itemClass} onClick={onOpenAccount}>
        <UserRound className="size-[14px] text-[var(--text-secondary)]" strokeWidth={1.6} />
        Account
      </button>
      <button type="button" role="menuitem" className={itemClass} onClick={onOpenServers}>
        <Server className="size-[14px] text-[var(--text-secondary)]" strokeWidth={1.6} />
        Servers
      </button>
      {showSignOut ? (
        <SignOutButton>
          <button type="button" role="menuitem" className={itemClass}>
            <LogOut className="size-[14px] text-[var(--text-secondary)]" strokeWidth={1.6} />
            Sign out
          </button>
        </SignOutButton>
      ) : null}
      <p className="flex items-center gap-[6px] px-[8px] py-[6px] font-sans text-[10.5px] text-[var(--text-disabled)]">
        <Check className="size-[11px]" strokeWidth={2} aria-hidden />
        Preferences stay on this client
      </p>
    </div>,
    document.body
  );
}
