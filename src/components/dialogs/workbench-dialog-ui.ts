/**
 * Shared modal dialog chrome. `WorkbenchDialog` (confirm / alert / prompt) is
 * built from these; bespoke dialogs should reuse them too so every modal in the
 * workbench shares one surface, one button vocabulary and one z-layer.
 */

/** Sits above popovers (10050), sheet modals (10060) and the Codespace wizard (10200). */
export const dialogLayerClass = "fixed inset-0 z-[10300]";

export const dialogBackdropClass = "absolute inset-0 bg-[var(--palette-backdrop)]";

/** Panel surface without sizing. */
export const dialogPanelClass =
  "relative overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] shadow-[var(--palette-shadow)]";

export const dialogTitleClass =
  "font-sans text-[13.5px] font-semibold leading-[1.35] tracking-[0.005em] text-[var(--text-primary)]";

export const dialogMessageClass =
  "mt-[4px] font-sans text-[12.5px] leading-[1.5] text-[var(--text-secondary)]";

/** Inline literal (path, branch, name) shown under a dialog message. */
export const dialogDetailClass =
  "mt-[8px] block max-h-[96px] overflow-auto break-all rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[8px] py-[5px] font-mono text-[11.5px] leading-[1.45] text-[var(--text-primary)]";

export const dialogFooterClass =
  "flex flex-wrap items-center justify-end gap-[8px] border-t border-[var(--palette-divider)] px-[12px] py-[10px]";

const dialogButtonBaseClass =
  "inline-flex min-h-[36px] items-center justify-center gap-[6px] rounded-[var(--radius-tab)] border px-[12px] py-[6px] font-sans text-[12.5px] font-medium outline-none transition-[background-color,opacity,border-color] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-panel)] disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-[30px]";

export const dialogSecondaryButtonClass = `${dialogButtonBaseClass} border-[var(--border-card)] bg-[var(--bg-panel)] text-[var(--text-primary)] hover:bg-[var(--accent-bg)]`;

export const dialogPrimaryButtonClass = `${dialogButtonBaseClass} border-[var(--accent)] bg-[var(--accent)] text-[var(--bg-main)] hover:opacity-90`;

export const dialogDangerButtonClass = `${dialogButtonBaseClass} border-[var(--status-error)] bg-[var(--status-error)] text-white hover:opacity-90`;

export const dialogInputClass =
  "mt-[10px] min-h-[38px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[9px] py-[6px] text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)] focus:border-[var(--accent)] sm:min-h-[32px]";

export const dialogInputErrorClass =
  "mt-[6px] font-sans text-[11.5px] leading-[1.4] text-[var(--status-error)]";
