"use client";

import { SignOutButton } from "@clerk/nextjs";
import { ClerkAuthTrigger } from "@/components/auth/ClerkAuthTrigger";
import { Check, CircleUserRound, Link2, LogOut, Settings, UserRound } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useOptionalAuth } from "@/components/auth/AuthProvider";
import { useShellView } from "@/components/layout/ShellViewContext";
import { useCloudContext } from "@/contexts/CloudContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useAccountIdentity } from "@/hooks/useAccountIdentity";

export type AccountPopoverProps = {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
};

export function AccountPopover({ open, onClose, anchorRef }: AccountPopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [popoverPos, setPopoverPos] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxHeight: number;
  }>({
    top: 0,
    left: 0,
    width: 280,
    maxHeight: 360,
  });
  const [copied, setCopied] = useState(false);
  const identity = useAccountIdentity();
  const cloud = useCloudContext();
  const auth = useOptionalAuth();
  const { updateWorkspaceSession } = useWorkspace();
  const { openSettingsView } = useShellView();

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      return;
    }
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewportPad = 10;
      const gap = 8;
      const visual = window.visualViewport;
      const viewTop = visual?.offsetTop ?? 0;
      const viewLeft = visual?.offsetLeft ?? 0;
      const viewWidth = visual?.width ?? window.innerWidth;
      const viewHeight = visual?.height ?? window.innerHeight;
      const viewBottom = viewTop + viewHeight;
      const layoutBottomInset = Math.max(0, window.innerHeight - viewBottom);
      const width = Math.min(300, Math.max(0, viewWidth - viewportPad * 2));
      const left = Math.max(
        viewLeft + viewportPad,
        Math.min(rect.left, viewLeft + viewWidth - width - viewportPad)
      );
      const bottom = Math.max(
        viewportPad + layoutBottomInset,
        window.innerHeight - rect.top + gap
      );
      const maxHeight = Math.max(160, rect.top - gap - viewTop - viewportPad);
      setPopoverPos({ bottom, left, width, maxHeight });
    };
    update();
    const resizeObserver =
      popoverRef.current == null ? null : new ResizeObserver(() => update());
    if (popoverRef.current && resizeObserver) {
      resizeObserver.observe(popoverRef.current);
    }
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [anchorRef, open]);

  useEffect(() => {
    if (!open) {
      setCopied(false);
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        (popoverRef.current?.contains(target) || anchorRef.current?.contains(target))
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

  const deviceKey =
    cloud.mode === "device" && cloud.userKey?.startsWith("device:")
      ? cloud.userKey.slice(7)
      : null;

  const copyDeviceLink = async () => {
    if (!deviceKey) {
      return;
    }
    const url = `${window.location.origin}/setup?link=${encodeURIComponent(deviceKey)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const openAccountSettings = () => {
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: { ...current.settingsView, activeNav: "account" },
    }));
    openSettingsView();
    onClose();
  };

  const rowClass =
    "flex w-full shrink-0 items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--accent-bg)]";

  return createPortal(
    <div
      ref={popoverRef}
      role="menu"
      aria-label="Account"
      className="fixed z-[10050] flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] shadow-lg"
      style={{
        top: popoverPos.top,
        bottom: popoverPos.bottom,
        left: popoverPos.left,
        width: popoverPos.width,
        maxHeight: popoverPos.maxHeight,
      }}
      data-ide-input-sink
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex min-w-0 items-center gap-[10px] px-[10px] py-[10px]">
        {identity.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={identity.imageUrl}
            alt=""
            className="size-[32px] shrink-0 rounded-full object-cover"
          />
        ) : (
          <span className="flex size-[32px] shrink-0 items-center justify-center rounded-full bg-[var(--accent-bg)] text-[var(--text-secondary)]">
            <CircleUserRound className="size-[18px]" strokeWidth={1.5} aria-hidden />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-sans text-[13px] font-medium text-[var(--text-primary)]">
            {identity.title}
          </div>
          <div className="mt-[2px] flex min-w-0 items-center gap-[6px]">
            <span
              className={`size-[6px] shrink-0 rounded-full ${
                identity.signedIn ? "bg-[#22c55e]" : "bg-[var(--text-disabled)]"
              }`}
              aria-hidden
            />
            <span className="truncate font-sans text-[11px] text-[var(--text-secondary)]">
              {identity.subtitle}
            </span>
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-[var(--border-card)] px-[6px] py-[1px] font-sans text-[10px] text-[var(--text-secondary)]">
          {identity.modeLabel}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-[var(--border-card)] p-[4px]">
        {identity.kind === "clerk-signed-out" ? (
          <ClerkAuthTrigger mode="sign-in">
            <button type="button" role="menuitem" className={rowClass} onClick={onClose}>
              <UserRound className="size-[13px] shrink-0" strokeWidth={1.5} />
              Sign in
            </button>
          </ClerkAuthTrigger>
        ) : null}
        {identity.kind === "clerk" ? (
          <SignOutButton>
            <button type="button" role="menuitem" className={rowClass}>
              <LogOut className="size-[13px] shrink-0" strokeWidth={1.5} />
              Sign out
            </button>
          </SignOutButton>
        ) : null}
        {identity.kind === "engine" && auth?.logout ? (
          <button
            type="button"
            role="menuitem"
            className={rowClass}
            onClick={() => {
              void auth.logout();
              onClose();
            }}
          >
            <LogOut className="size-[13px] shrink-0" strokeWidth={1.5} />
            Sign out of server
          </button>
        ) : null}
        {deviceKey ? (
          <button
            type="button"
            role="menuitem"
            className={rowClass}
            onClick={() => void copyDeviceLink()}
          >
            {copied ? (
              <Check className="size-[13px] shrink-0" strokeWidth={2} />
            ) : (
              <Link2 className="size-[13px] shrink-0" strokeWidth={1.5} />
            )}
            {copied ? "Link copied" : "Link another device"}
          </button>
        ) : null}
        <button type="button" role="menuitem" className={rowClass} onClick={openAccountSettings}>
          <Settings className="size-[13px] shrink-0" strokeWidth={1.5} />
          Account settings
        </button>
      </div>
    </div>,
    document.body
  );
}
