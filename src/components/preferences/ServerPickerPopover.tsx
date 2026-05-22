"use client";

import { Check, CircleUserRound } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { VerticalFadedScroll } from "@/components/chat/VerticalFadedScroll";
import type { ServerRailAppearance } from "@/lib/global-settings";
import {
  getServerDisplayLabel,
  getServerRailAppearance,
  isLocalDeviceServer,
} from "@/lib/server-rail-appearance";
import {
  serverHealthColorClass,
  serverHealthIndicator,
} from "@/lib/server-health-display";
import { WorkspaceFolderIcon } from "@/lib/workspace-rail-appearance";

export type ServerPickerPopoverProps = {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  selectedServerId: string;
  servers: Array<{ id: string; label: string; baseUrl: string }>;
  serverStatusById: Record<string, { health: string } | undefined>;
  serverRailAppearances?: Record<string, ServerRailAppearance>;
  onSelect: (serverId: string) => void;
  /** Rail footer opens upward; settings pickers open below the trigger. */
  placement?: "above" | "below";
};

export function ServerPickerPopover({
  open,
  onClose,
  anchorRef,
  label,
  selectedServerId,
  servers,
  serverStatusById,
  serverRailAppearances = {},
  onSelect,
  placement = "below",
}: ServerPickerPopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0, width: 280 });

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      return;
    }
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewportPad = 8;
      const width = Math.min(320, Math.max(0, window.innerWidth - viewportPad * 2));
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const gap = 6;
      const estimatedHeight = popoverRef.current?.offsetHeight ?? 280;
      const desiredTop =
        placement === "above"
          ? rect.top - estimatedHeight - gap
          : rect.bottom + gap;
      const maxTop = Math.max(viewportPad, window.innerHeight - estimatedHeight - viewportPad);
      const top = Math.max(viewportPad, Math.min(desiredTop, maxTop));
      setPopoverPos({ top, left, width });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, open, placement, servers.length]);

  useEffect(() => {
    if (!open) return;
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

  return createPortal(
    <div
      ref={popoverRef}
      role="menu"
      aria-label={label}
      className="fixed z-[10050] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] shadow-lg"
      style={{
        top: popoverPos.top,
        left: popoverPos.left,
        width: popoverPos.width,
      }}
      data-ide-input-sink
      onPointerDown={(event) => event.stopPropagation()}
    >
      <VerticalFadedScroll
        measureKey={servers.length}
        edgeColorVar="var(--bg-panel)"
        scrollClassName="hide-scrollbar-y max-h-[min(360px,60dvh)] min-h-0 overflow-y-auto overscroll-contain p-[4px]"
      >
        {servers.map((server, index) => {
          const selected = server.id === selectedServerId;
          const health = serverStatusById[server.id]?.health ?? "unknown";
          const appearance = getServerRailAppearance(serverRailAppearances, server.id, index);
          const displayLabel = getServerDisplayLabel(server, appearance);
          const isLocalDevice = isLocalDeviceServer(server);
          return (
            <button
              key={server.id}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              onClick={() => {
                onSelect(server.id);
                onClose();
              }}
              className="flex w-full min-w-0 items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[8px] text-left hover:bg-[var(--accent-bg)] sm:py-[7px]"
            >
              {isLocalDevice ? (
                <CircleUserRound
                  className="size-[14px] shrink-0 text-[var(--text-secondary)]"
                  strokeWidth={1.5}
                  aria-hidden
                />
              ) : (
                <WorkspaceFolderIcon
                  iconName={appearance.icon}
                  color={appearance.color}
                  className="size-[14px] shrink-0"
                  strokeWidth={1.8}
                />
              )}
              <span
                className={`shrink-0 text-[10px] ${serverHealthColorClass(health)}`}
                aria-hidden
              >
                {serverHealthIndicator(health)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-sans text-[12.5px] text-[var(--text-primary)]">
                  {displayLabel}
                </span>
                <span className="mt-[2px] block truncate font-mono text-[10.5px] text-[var(--text-secondary)]">
                  {server.baseUrl}
                </span>
              </span>
              {selected ? (
                <Check className="size-[13px] shrink-0 text-[var(--text-primary)]" strokeWidth={2} />
              ) : null}
            </button>
          );
        })}
      </VerticalFadedScroll>
    </div>,
    document.body
  );
}
