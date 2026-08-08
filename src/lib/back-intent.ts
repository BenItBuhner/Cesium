/**
 * Pure logic for the in-WebView Android "back" stack. Kept framework-free so it
 * can be unit tested without a React/DOM environment. The React context and
 * hooks live in `@/components/mobile/BackIntentContext`.
 */

/**
 * Priorities for the in-WebView "back" stack. A single back gesture pops the
 * highest-priority active layer; among equal priorities the most recently
 * registered layer wins (i.e. the visually top-most overlay closes first).
 *
 * These are intentionally spaced so new layers can slot in between without
 * renumbering everything.
 */
export const BACK_INTENT_PRIORITY = {
  /** Modals, palettes, dialogs, dropdowns — anything rendered on top of everything. */
  overlay: 100,
  /** Full-screen settings view. */
  settings: 40,
  /** Mobile left workspace-rail drawer (a modal overlay with a full backdrop). */
  leftRail: 35,
  /** Mobile right (workbench) pane overlay. */
  rightPane: 30,
} as const;

export type BackHandlerEntry = {
  /** Monotonically increasing registration id (higher = registered later). */
  id: number;
  priority: number;
  handler: () => boolean;
};

/**
 * Choose which registered handler a single back intent should reach: the
 * highest priority, breaking ties by most-recently registered (largest id).
 * Returns `null` when nothing is registered.
 */
export function selectTopBackHandler(
  entries: readonly BackHandlerEntry[]
): BackHandlerEntry | null {
  let top: BackHandlerEntry | null = null;
  for (const entry of entries) {
    if (
      top === null ||
      entry.priority > top.priority ||
      (entry.priority === top.priority && entry.id > top.id)
    ) {
      top = entry;
    }
  }
  return top;
}
