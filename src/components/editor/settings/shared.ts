/** Shared style constants for the settings panels. */

/** Compact select-style trigger used for pickers and secondary actions. */
export const selectClass =
  "inline-flex min-w-[160px] max-w-[240px] shrink-0 items-center justify-between gap-[8px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[6px] font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]";

/** Monospace text input used for shortcut-style and technical values. */
export const shortcutInputClass =
  "box-border min-w-[200px] max-w-[min(100%,380px)] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[6px] font-mono text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]";

/** Full-width search input at the top of filterable panels (Models, Shortcuts). */
export const panelSearchInputClass =
  "box-border h-[36px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] pl-[10px] pr-[10px] font-sans text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]";
