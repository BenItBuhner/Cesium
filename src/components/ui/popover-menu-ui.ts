/**
 * Shared popover / context menu chrome — matches workspace & server pickers
 * (`rounded-[var(--radius-card)]`, `bg-panel`, accent hover rows).
 */

/** Panel shell (popover surface without positioning). */
export const popoverMenuPanelClass =
  "overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] shadow-lg";

/** Fixed portal panel (context menus, dropdowns). */
export const popoverMenuFixedPanelClass = `fixed z-[10050] ${popoverMenuPanelClass}`;

/** Inner list padding around menu rows. */
export const popoverMenuListClass = "flex flex-col p-[4px]";

/** Primary text action row. */
export const popoverMenuItemClass =
  "flex w-full cursor-default items-center justify-between gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12.5px] text-[var(--text-primary)] outline-none transition-colors hover:bg-[var(--accent-bg)] focus-visible:bg-[var(--accent-bg)] disabled:cursor-not-allowed disabled:opacity-40";

/** Menu row with a leading icon (editor tab menus). */
export const popoverMenuIconItemClass = `${popoverMenuItemClass} justify-start`;

export const popoverMenuItemShortcutClass =
  "ml-auto shrink-0 font-mono text-[11px] tabular-nums text-[var(--text-secondary)]";

export const popoverMenuSeparatorClass = "my-[4px] h-px shrink-0 bg-[var(--border-card)]";

/** Uppercase section label (filter menus). */
export const popoverMenuSectionLabelClass =
  "px-[10px] pb-[3px] pt-[6px] font-sans text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--text-disabled)]";

/** Search / title header strip (workspace picker). */
export const popoverMenuSearchHeaderClass =
  "border-b border-[var(--border-card)] px-[10px] py-[7px]";

export const popoverMenuFooterClass = "border-t border-[var(--border-card)] p-[4px]";

/** Radio / checkbox row in filter-style menus. */
export const popoverMenuFormRowClass =
  "flex cursor-pointer items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[5px] font-sans text-[13px] font-normal text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]";

export const popoverMenuAccentActionClass = `${popoverMenuItemClass} !text-[var(--accent)]`;
