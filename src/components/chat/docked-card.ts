/**
 * Horizontal inset so a docked card's square bottom corners land on the
 * composer's flat top edge. Compensates for the default composer shell mx
 * (`mx-0` / `@min-[481px]:mx-[10px]`) so the inset is relative to the
 * composer, not the column.
 */
export const dockedComposerCardMx =
  "mx-[var(--agent-composer-radius)] @min-[481px]:mx-[calc(10px+var(--agent-composer-radius))]";

/** Shared chrome for cards docked directly above the chat composer. */
export const dockedComposerCardFrame =
  `${dockedComposerCardMx} flex flex-col overflow-hidden rounded-t-[var(--agent-composer-radius)] rounded-b-none border-x border-t border-[var(--border-card)] bg-[var(--bg-card)] p-[10px]`;

/** Wrapper spacing when a docked card sits above the composer shell in the bottom dock. */
export const dockedComposerCardSlot = "pt-[8px]";
