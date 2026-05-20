"use client";

import { Check } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { VerticalFadedScroll } from "@/components/chat/VerticalFadedScroll";
import {
  serverHealthColorClass,
  serverHealthIndicator,
} from "@/lib/server-health-display";

export type ServerPickerPopoverProps = {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  selectedServerId: string;
  servers: Array<{ id: string; label: string; baseUrl: string }>;
  serverStatusById: Record<string, { health: string } | undefined>;
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
      const width = Math.max(240, Math.min(320, window.innerWidth - 16));
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const gap = 6;
      const estimatedHeight = popoverRef.current?.offsetHeight ?? 280;
      const top =
        placement === "above"
          ? Math.max(8, rect.top - estimatedHeight - gap)
          : rect.bottom + gap;
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
        scrollClassName="hide-scrollbar-y max-h-[min(320px,45vh)] min-h-0 overflow-y-auto overscroll-contain p-[4px]"
      >
        {servers.map((server) => {
          const selected = server.id === selectedServerId;
          const health = serverStatusById[server.id]?.health ?? "unknown";
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
              className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[7px] text-left transition-colors hover:bg-[var(--accent-bg)]"
            >
              <span
                className={`shrink-0 text-[10px] ${serverHealthColorClass(health)}`}
                aria-hidden
              >
                {serverHealthIndicator(health)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-sans text-[12.5px] text-[var(--text-primary)]">
                  {server.label}
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

