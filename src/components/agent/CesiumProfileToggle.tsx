"use client";

import { Briefcase, Code2, Settings2, SlidersHorizontal, type LucideIcon } from "lucide-react";

export type CesiumProfileToggleOption = {
  value: string;
  name: string;
  description?: string;
  builtIn?: boolean;
};

function iconForProfile(option: CesiumProfileToggleOption): LucideIcon {
  if (option.value === "work") {
    return Briefcase;
  }
  if (option.value === "code") {
    return Code2;
  }
  return SlidersHorizontal;
}

interface CesiumProfileToggleProps {
  options: CesiumProfileToggleOption[];
  activeId: string;
  onChange: (profileId: string) => void;
  /** Opens Settings → Agents → Cesium Agent for profile management. */
  onManage?: () => void;
  disabled?: boolean;
}

/**
 * Capability-profile toggle pinned at the very top of the agent center pane.
 * Profiles are a layer above the harness (modes, models, tools live inside
 * it), so the switch renders above the transcript/composer and only for the
 * first-party Cesium agent harness.
 */
export function CesiumProfileToggle({
  options,
  activeId,
  onChange,
  onManage,
  disabled = false,
}: CesiumProfileToggleProps) {
  if (options.length === 0) {
    return null;
  }
  const active = options.find((option) => option.value === activeId) ?? options[0];
  return (
    <div className="flex w-full shrink-0 justify-center pb-[2px] pt-[8px]">
      <div
        className="flex max-w-full items-center gap-[2px] overflow-x-auto rounded-full border border-[var(--agent-border)] bg-[var(--bg-input)] p-[2px]"
        role="tablist"
        aria-label="Agent profile"
      >
        {options.map((option) => {
          const Icon = iconForProfile(option);
          const isActive = option.value === active?.value;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-label={`Agent profile: ${option.name}`}
              disabled={disabled}
              title={option.description ? `${option.name} — ${option.description}` : option.name}
              onClick={() => {
                if (!disabled && !isActive) {
                  onChange(option.value);
                }
              }}
              className={`flex shrink-0 touch-manipulation items-center gap-[5px] whitespace-nowrap rounded-full px-[10px] py-[3px] font-sans text-[12px] font-normal transition-colors disabled:cursor-default ${
                isActive
                  ? "bg-[var(--bg-panel)] text-[var(--text-primary)] shadow-[0_0_0_1px_var(--border-card)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              <Icon className="size-[12px] shrink-0" strokeWidth={1.5} aria-hidden />
              {option.name}
            </button>
          );
        })}
        {onManage ? (
          <button
            type="button"
            onClick={onManage}
            aria-label="Manage agent profiles"
            title="Manage agent profiles"
            className="flex shrink-0 touch-manipulation items-center rounded-full px-[7px] py-[4px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            <Settings2 className="size-[12px] shrink-0" strokeWidth={1.5} aria-hidden />
          </button>
        ) : null}
      </div>
    </div>
  );
}
