"use client";

import { useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  Briefcase,
  Check,
  ChevronDown,
  Code2,
  Settings2,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { useClickOutside } from "@/hooks/useClickOutside";
import { usePopover } from "@/hooks/usePopover";

export type ChatProfileOption = {
  value: string;
  name: string;
  description?: string;
  builtIn?: boolean;
};

function iconForProfile(option: ChatProfileOption | undefined): LucideIcon {
  if (option?.value === "work") {
    return Briefcase;
  }
  if (option?.value === "code") {
    return Code2;
  }
  return SlidersHorizontal;
}

interface ProfileDropdownProps {
  profileId: string;
  options: ChatProfileOption[];
  onProfileChange?: (profileId: string) => void;
  /** `below`: open under the trigger (e.g. composer at top). Default: above (docked-bottom composer). */
  popoverPlacement?: "above" | "below";
  disabled?: boolean;
  /** Opens Settings → Agents → Cesium Agent for profile management. */
  onManageProfiles?: () => void;
}

/**
 * Capability-profile picker chip (Code / Work / custom presets) for the chat
 * composer, rendered next to the mode dropdown for Cesium Agent conversations.
 */
export function ProfileDropdown({
  profileId,
  options,
  onProfileChange,
  popoverPlacement = "above",
  disabled = false,
  onManageProfiles,
}: ProfileDropdownProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { triggerRef, popoverRef, position, ready } = usePopover(open, {
    placement: popoverPlacement,
  });
  useClickOutside(triggerRef, close, open, [popoverRef]);

  const current = useMemo(
    () => options.find((option) => option.value === profileId) ?? options[0],
    [options, profileId]
  );
  const TriggerIcon = iconForProfile(current);
  const interactive = !disabled;

  if (options.length === 0) {
    return null;
  }

  return (
    <div ref={triggerRef} className="relative inline-flex max-w-full min-w-0">
      <button
        type="button"
        disabled={!interactive}
        onClick={() => {
          if (!interactive) {
            return;
          }
          setOpen((v) => !v);
        }}
        aria-label={`Profile: ${current?.name ?? "Profile"}`}
        title={`Profile: ${current?.name ?? "Profile"}${current?.description ? ` — ${current.description}` : ""}`}
        className="group inline-flex max-w-[150px] items-center overflow-hidden rounded-[var(--radius-pill)] py-[1px] pl-[7px] pr-[7px] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-100"
        style={{ background: "var(--bg-input)" }}
      >
        <TriggerIcon
          className="size-[13px] shrink-0 text-[var(--text-secondary)]"
          strokeWidth={1.5}
        />
        <span
          className={`overflow-hidden whitespace-nowrap font-sans text-[13px] font-normal text-[var(--text-secondary)] transition-[margin,max-width,opacity] duration-200 ${
            open
              ? "ml-[6px] max-w-[120px] opacity-100 ease-out"
              : "ml-0 max-w-0 opacity-0 ease-in group-hover:ml-[6px] group-hover:max-w-[120px] group-hover:opacity-100 group-hover:ease-out group-focus-visible:ml-[6px] group-focus-visible:max-w-[120px] group-focus-visible:opacity-100 group-focus-visible:ease-out"
          }`}
        >
          {current?.name ?? "Profile"}
        </span>
        <ChevronDown
          className={`size-[8px] shrink-0 text-[var(--text-secondary)] transition-[margin,opacity,width] duration-200 ${
            open
              ? "ml-[6px] w-[8px] opacity-100 ease-out"
              : "ml-0 w-0 opacity-0 ease-in group-hover:ml-[6px] group-hover:w-[8px] group-hover:opacity-100 group-hover:ease-out group-focus-visible:ml-[6px] group-focus-visible:w-[8px] group-focus-visible:opacity-100 group-focus-visible:ease-out"
          }`}
          strokeWidth={2.5}
        />
      </button>

      {open &&
        interactive &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-[9999] w-[240px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] py-[4px] transition-opacity"
            data-ide-input-sink
            data-ide-composer-floating-popover
            style={{
              ...(position.top != null
                ? { top: position.top }
                : { bottom: position.bottom ?? 0 }),
              left: position.left,
              opacity: ready ? 1 : 0,
              maxHeight: position.maxHeight,
              overflow: "auto",
              overscrollBehavior: "contain",
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <div className="border-b border-[var(--border-card)] px-[12px] py-[6px]">
              <p className="font-sans text-[11px] font-medium uppercase tracking-wide text-[var(--text-disabled)]">
                Agent profile
              </p>
            </div>
            <div className="py-[2px]">
              {options.map((option) => {
                const Icon = iconForProfile(option);
                const active = option.value === (current?.value ?? profileId);
                return (
                  <button
                    key={option.value}
                    type="button"
                    title={option.description ?? option.name}
                    onClick={() => {
                      onProfileChange?.(option.value);
                      setOpen(false);
                    }}
                    className="flex w-full items-start gap-[8px] px-[12px] py-[6px] text-left transition-colors hover:bg-white/[0.06]"
                  >
                    <Icon
                      className="mt-[2px] size-[15px] shrink-0"
                      strokeWidth={1.5}
                      style={{
                        color: active ? "var(--accent)" : "var(--text-secondary)",
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate font-sans text-[13px] font-normal"
                        style={{
                          color: active ? "var(--text-primary)" : "var(--text-secondary)",
                        }}
                      >
                        {option.name}
                      </span>
                      {option.description ? (
                        <span className="mt-[1px] block font-sans text-[11px] leading-[1.35] text-[var(--text-disabled)]">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    {active && (
                      <Check
                        className="mt-[2px] size-[14px] shrink-0 text-[var(--text-primary)]"
                        strokeWidth={2}
                      />
                    )}
                  </button>
                );
              })}
            </div>
            {onManageProfiles ? (
              <div className="border-t border-[var(--border-card)] py-[2px]">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onManageProfiles();
                  }}
                  className="flex w-full items-center gap-[8px] px-[12px] py-[6px] text-left transition-colors hover:bg-white/[0.06]"
                >
                  <Settings2
                    className="size-[14px] shrink-0 text-[var(--text-secondary)]"
                    strokeWidth={1.5}
                  />
                  <span className="font-sans text-[12px] font-normal text-[var(--text-secondary)]">
                    Manage profiles…
                  </span>
                </button>
              </div>
            ) : null}
          </div>,
          document.body
        )}
    </div>
  );
}
