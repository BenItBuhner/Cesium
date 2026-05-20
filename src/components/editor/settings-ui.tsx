"use client";

import { Check } from "lucide-react";
import { useCallback, useId, type ChangeEvent, type FocusEvent, type ReactNode } from "react";

export const rowButtonClass =
  "inline-flex shrink-0 items-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-transparent px-[12px] py-[5px] font-sans text-[12px] font-normal text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]";

export const tagClass =
  "inline-flex items-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[3px] font-mono text-[11px] text-[var(--text-primary)]";

export function SettingsSection({
  title,
  children,
  action,
  bordered = true,
}: {
  title?: string;
  children: ReactNode;
  action?: ReactNode;
  /** When false, children render without the bordered card wrapper. */
  bordered?: boolean;
}) {
  const showHeader = Boolean((title && title.length > 0) || action);
  return (
    <section className="mb-[20px]">
      {showHeader ? (
        <div className="mb-[10px] flex items-center justify-between gap-[12px] px-[2px]">
          {title ? (
            <h2 className="font-sans text-[15px] font-semibold text-[var(--text-primary)]">
              {title}
            </h2>
          ) : (
            <span />
          )}
          {action}
        </div>
      ) : null}
      {bordered ? (
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)]">
          {children}
        </div>
      ) : (
        children
      )}
    </section>
  );
}

export type SettingsRadioOption<T extends string = string> = {
  value: T;
  label: string;
};

/** Flat vertical radio list — bullet + label rows, no card wrapper. */
export function SettingsRadioList<T extends string>({
  value,
  onChange,
  options,
  "aria-label": ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SettingsRadioOption<T>[];
  "aria-label": string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex flex-col gap-[2px] px-[2px]">
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className="group flex w-full items-center gap-[10px] rounded-[var(--radius-tab)] px-[6px] py-[8px] text-left transition-colors hover:bg-[var(--accent-bg)]"
          >
            <span
              className={`flex size-[8px] shrink-0 items-center justify-center rounded-full transition-colors ${
                selected
                  ? "bg-[var(--text-primary)]"
                  : "border border-[var(--border-card)] bg-transparent group-hover:border-[var(--text-secondary)]"
              }`}
              aria-hidden
            />
            <span
              className={`min-w-0 flex-1 font-sans text-[13px] ${
                selected
                  ? "font-medium text-[var(--text-primary)]"
                  : "font-normal text-[var(--text-primary)]"
              }`}
            >
              {option.label}
            </span>
            {selected ? (
              <Check
                className="size-[14px] shrink-0 text-[var(--text-primary)]"
                strokeWidth={2}
                aria-hidden
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function SettingsRow({
  title,
  description,
  trailing,
  border = true,
  titleExtra,
  searchId,
  highlight,
}: {
  title: string;
  description?: string;
  trailing: ReactNode;
  border?: boolean;
  titleExtra?: ReactNode;
  /** Stable id for global settings search scroll/highlight (`data-settings-search-id`). */
  searchId?: string;
  highlight?: boolean;
}) {
  return (
    <div
      data-settings-search-id={searchId}
      className={`flex min-h-[56px] items-center justify-between gap-[16px] px-[16px] py-[12px] transition-colors ${
        border ? "border-b border-[var(--border-subtle)] last:border-b-0" : ""
      } ${highlight ? "bg-[var(--accent-bg)] ring-1 ring-inset ring-[var(--accent)]" : ""}`}
    >
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-[8px] font-sans text-[13px] font-medium text-[var(--text-primary)]">
          {title}
          {titleExtra}
        </p>
        {description ? (
          <p className="mt-[4px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
            {description}
          </p>
        ) : null}
      </div>
      <div className="shrink-0">{trailing}</div>
    </div>
  );
}

export function PageIntro({ title }: { title: string }) {
  return (
    <h1 className="mb-[16px] font-sans text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
      {title}
    </h1>
  );
}

export type SettingsBreadcrumbSegment = {
  label: string;
  onClick?: () => void;
};

/** Top-of-page location trail for nested settings views (e.g. Agents › harness). */
export function SettingsBreadcrumbs({ segments }: { segments: SettingsBreadcrumbSegment[] }) {
  if (segments.length === 0) {
    return null;
  }
  return (
    <nav
      aria-label="Breadcrumb"
      className={`mb-[12px] flex flex-wrap items-center gap-[4px] px-[2px] font-sans ${
        segments.length === 1 ? "" : "text-[12px]"
      }`}
    >
      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        return (
          <span key={`${segment.label}-${index}`} className="inline-flex min-w-0 items-center gap-[4px]">
            {index > 0 ? (
              <span className="select-none text-[var(--text-disabled)]" aria-hidden>
                ›
              </span>
            ) : null}
            {segment.onClick && !isLast ? (
              <button
                type="button"
                onClick={segment.onClick}
                className="truncate text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
              >
                {segment.label}
              </button>
            ) : (
              <span
                className={`truncate ${
                  isLast
                    ? segments.length === 1
                      ? "font-sans text-[22px] font-semibold tracking-tight text-[var(--text-primary)]"
                      : "font-medium text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)]"
                }`}
                aria-current={isLast ? "page" : undefined}
              >
                {segment.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/** Styled select trigger matching server/workspace pickers in settings. */
export const settingsSelectTriggerClass =
  "inline-flex min-w-[160px] w-full items-center justify-between gap-[8px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[6px] font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]";

export function SettingsSubsectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-[10px] font-sans text-[11px] font-medium uppercase tracking-wide text-[var(--text-disabled)]">
      {children}
    </h3>
  );
}

export function SettingsFieldLabel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={`font-sans text-[11px] font-medium text-[var(--text-secondary)] ${className}`}>
      {children}
    </span>
  );
}

const settingsNumberInputClass =
  "box-border w-[72px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[6px] text-right font-mono text-[12px] text-[var(--text-primary)] outline-none tabular-nums";

/** Slider + integer field for pixel-sized appearance preferences. */
export function SettingsPxRangeControl({
  value,
  onChange,
  min,
  max,
  step = 1,
  unit = "px",
  ariaLabel,
  className = "",
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  ariaLabel: string;
  className?: string;
}) {
  const sliderId = useId();
  const numberId = useId();

  const clamp = useCallback(
    (n: number) => Math.min(max, Math.max(min, Math.round(n))),
    [min, max]
  );

  const handleSlider = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(clamp(Number(event.target.value)));
  };

  const handleNumber = (event: ChangeEvent<HTMLInputElement>) => {
    const parsed = Number.parseInt(event.target.value, 10);
    if (Number.isFinite(parsed)) {
      onChange(clamp(parsed));
    }
  };

  const handleNumberBlur = (event: FocusEvent<HTMLInputElement>) => {
    const parsed = Number.parseInt(event.target.value, 10);
    onChange(Number.isFinite(parsed) ? clamp(parsed) : clamp(value));
  };

  return (
    <div className={`flex flex-wrap items-center gap-[12px] ${className}`}>
      <input
        id={sliderId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={handleSlider}
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        className="h-[20px] min-w-[min(100%,200px)] flex-1 cursor-pointer accent-[var(--accent)]"
      />
      <div className="flex shrink-0 items-center gap-[6px]">
        <input
          id={numberId}
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={handleNumber}
          onBlur={handleNumberBlur}
          aria-label={`${ariaLabel} (${unit})`}
          className={settingsNumberInputClass}
        />
        <span className="font-sans text-[12px] text-[var(--text-secondary)]">{unit}</span>
      </div>
    </div>
  );
}
