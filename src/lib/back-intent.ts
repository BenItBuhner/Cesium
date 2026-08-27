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
  /** Modals, palettes, dialogs, dropdowns - anything rendered on top of everything. */
  overlay: 100,
  /** Mobile settings-nav drawer (rides on top of the full-screen settings view). */
  settingsNav: 45,
  /** Full-screen settings view. */
  settings: 40,
  /** Mobile left workspace-rail drawer (a modal overlay with a full backdrop). */
  leftRail: 35,
  /** Mobile right (workbench) pane overlay. */
  rightPane: 30,
} as const;

/**
 * One frame of the Android progressive (predictive) back gesture. `progress`
 * runs 0 → 1 as the finger travels inward from `swipeEdge`; the gesture then
 * either commits (the layer must pop) or cancels (the layer must return to
 * rest).
 */
export type BackGestureEvent = {
  progress: number;
  swipeEdge: "left" | "right";
  touchX?: number;
  touchY?: number;
};

/**
 * Optional progressive hooks for a back handler. Layers that can preview
 * their pop (drawers sliding with the finger, the settings view scaling down)
 * implement these; layers that can only close discretely (modals, palettes)
 * omit them and simply pop on commit.
 */
export type BackGestureHooks = {
  onStart?: (event: BackGestureEvent) => void;
  onProgress?: (event: BackGestureEvent) => void;
  onCancel?: () => void;
};

export type BackHandlerEntry = {
  /** Monotonically increasing registration id (higher = registered later). */
  id: number;
  priority: number;
  handler: () => boolean;
  gesture?: BackGestureHooks;
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

/**
 * Drives one progressive back gesture against the handler registry.
 *
 * The gesture target is resolved once at `start` and stashed for the rest of
 * the gesture, so progress/cancel/commit always reach the same layer even if
 * the registry changes mid-gesture (e.g. another overlay opens or the target
 * unregisters). A `commit` without a preceding `start` - 3-button navigation,
 * pre-Android-14 devices - falls back to resolving the top handler at commit
 * time, which is exactly the old discrete behavior.
 */
export class BackGestureCoordinator {
  private active: BackHandlerEntry | null = null;

  constructor(private readonly getEntries: () => readonly BackHandlerEntry[]) {}

  /** Returns whether a handler claimed the gesture. */
  start(event: BackGestureEvent): boolean {
    this.active = selectTopBackHandler(this.getEntries());
    this.active?.gesture?.onStart?.(event);
    return this.active !== null;
  }

  progress(event: BackGestureEvent): void {
    this.active?.gesture?.onProgress?.(event);
  }

  cancel(): void {
    const target = this.active;
    this.active = null;
    target?.gesture?.onCancel?.();
  }

  /** Returns whether the back intent was consumed. */
  commit(): boolean {
    const target = this.active ?? selectTopBackHandler(this.getEntries());
    this.active = null;
    return target ? target.handler() : false;
  }
}
