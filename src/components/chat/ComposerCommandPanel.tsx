"use client";

import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import type { ComposerCommandPanelPosition } from "@/lib/composer-command-panel";

type SearchProps = {
  value: string;
  placeholder: string;
};

type Props = {
  id?: string;
  ariaLabel: string;
  position: ComposerCommandPanelPosition;
  popoverRef: RefObject<HTMLDivElement | null>;
  search?: SearchProps;
  children: ReactNode;
  ready?: boolean;
};

export function ComposerCommandPanel({
  id,
  ariaLabel,
  position,
  popoverRef,
  search,
  children,
  ready = true,
}: Props) {
  const positionStyle =
    position.placement === "above"
      ? {
          bottom: position.bottom,
          top: "auto" as const,
          left: position.left,
          width: position.width,
          maxHeight: position.maxHeight,
        }
      : {
          top: position.top,
          bottom: "auto" as const,
          left: position.left,
          width: position.width,
          maxHeight: position.maxHeight,
        };

  return createPortal(
    <div
      id={id}
      ref={popoverRef}
      role="listbox"
      aria-label={ariaLabel}
      data-ide-composer-floating-popover
      data-ide-input-sink
      data-composer-command-panel
      data-placement={position.placement}
      className="chat-composer-surface fixed z-[10050] flex flex-col overflow-hidden rounded-[var(--agent-composer-radius)] border border-[var(--agent-border)]"
      style={{ ...positionStyle, opacity: ready ? 1 : 0 }}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      {search ? (
        <div className="shrink-0 border-b border-[var(--agent-border)] px-[14px] py-[10px]">
          {search.value ? (
            <p className="min-w-0 truncate font-sans text-[13px] text-[var(--text-primary)]">
              {search.value}
            </p>
          ) : (
            <p className="min-w-0 truncate font-sans text-[13px] text-[var(--text-disabled)]">
              {search.placeholder}
            </p>
          )}
        </div>
      ) : null}
      {children}
    </div>,
    document.body
  );
}
