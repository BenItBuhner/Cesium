/**
 * "Split" transition for spawning a conversation from the new-chat composer.
 *
 * On submit the composer card visually divides: the typed prompt becomes the
 * user-message card at the top of the fresh thread (top-aligned with the old
 * shell), while the emptied composer shell peels off to its docked resting
 * spot at the bottom (bottom-aligned with the old shell). Both pieces are the
 * *real* destination elements FLIP-translated from the captured source rect,
 * so nothing is cloned or faked - the cards genuinely travel to where they
 * live, at any viewport size.
 *
 * Usage: `captureComposerSplitSource()` synchronously in the submit handler
 * (while the source composer is still mounted), then
 * `runComposerSplitAnimation()` from a layout effect once the optimistic
 * conversation view has rendered. Submit-side heavy work should sequence on
 * `waitForComposerSplitStart()` / `waitForComposerSplitSettled()` so the
 * animation gets a quiet main thread for its start frame and is not
 * remounted away mid-flight.
 */

import { prefersReducedMotion } from "@/components/mobile/drawer-motion";

type SplitSource = {
  shellRect: DOMRect;
  capturedAt: number;
};

let pendingSource: SplitSource | null = null;

// Generous TTL: the optimistic first-turn render can take well over a second
// on slow devices (Android WebView under TCG, busy main thread). The old
// 800ms budget silently skipped the split FLIP there, snapping the composer
// into place with no animation. The capture is consumed by the very next
// optimistic commit, so a longer window cannot leak into unrelated renders.
const SOURCE_TTL_MS = 3000;
const SPLIT_EASING = "cubic-bezier(0.24, 0.9, 0.3, 1)";
const SPLIT_DURATION_MS = 360;

/**
 * Lifecycle rendezvous for the pending split. Submit-side code can hold heavy
 * work (server round-trip, real-view commit) until the animation has actually
 * started / finished, instead of guessing with wall-clock timers. Once the
 * transforms have started they run on the compositor, so later main-thread
 * jank no longer freezes them - but the *start* frame needs a quiet main
 * thread, hence the started gate.
 */
let notifyStarted: (() => void) | null = null;
let notifySettled: (() => void) | null = null;
let startedPromise: Promise<void> | null = null;
let settledPromise: Promise<void> | null = null;

function armSplitWaiters(): void {
  releaseSplitWaiters();
  startedPromise = new Promise((resolve) => (notifyStarted = resolve));
  settledPromise = new Promise((resolve) => (notifySettled = resolve));
}

function releaseSplitWaiters(): void {
  notifyStarted?.();
  notifyStarted = null;
  notifySettled?.();
  notifySettled = null;
}

/** Bounded so a hidden tab (no rendering opportunities) can never stall the caller. */
function withDeadline(promise: Promise<void> | null, ms: number): Promise<void> {
  if (!promise) {
    return Promise.resolve();
  }
  return Promise.race([
    promise,
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}

/** Resolves once the split animations have started (or won't run at all). */
export function waitForComposerSplitStart(): Promise<void> {
  return withDeadline(startedPromise, SOURCE_TTL_MS);
}

/** Resolves once the split animations have finished/cancelled (or never ran). */
export function waitForComposerSplitSettled(): Promise<void> {
  return withDeadline(settledPromise, SOURCE_TTL_MS + 2 * SPLIT_DURATION_MS);
}

export function captureComposerSplitSource(scope?: HTMLElement | null): void {
  const root: ParentNode = scope ?? document;
  const shell = root.querySelector<HTMLElement>("[data-composer-shell]");
  if (!shell) {
    pendingSource = null;
    releaseSplitWaiters();
    return;
  }
  pendingSource = {
    shellRect: shell.getBoundingClientRect(),
    capturedAt: performance.now(),
  };
  armSplitWaiters();
}

export function clearComposerSplitSource(): void {
  pendingSource = null;
  releaseSplitWaiters();
}

/**
 * FLIP the freshly-rendered first user-message card and the docked composer
 * shell from the captured source shell rect to their natural positions.
 */
export function runComposerSplitAnimation(scope: HTMLElement | null): void {
  const source = pendingSource;
  pendingSource = null;
  if (!source || !scope) {
    releaseSplitWaiters();
    return;
  }
  if (performance.now() - source.capturedAt > SOURCE_TTL_MS) {
    releaseSplitWaiters();
    return;
  }
  if (prefersReducedMotion()) {
    releaseSplitWaiters();
    return;
  }

  const createdAnimations: Animation[] = [];
  const src = source.shellRect;
  const bubble = scope.querySelector<HTMLElement>("[data-user-message-card]");
  const dockShell = scope.querySelector<HTMLElement>(
    ".chat-bottom-dock [data-composer-shell]"
  );

  if (bubble) {
    const rect = bubble.getBoundingClientRect();
    // Top halves align: the prompt text starts at the top of the old shell.
    const dx = src.left - rect.left;
    const dy = src.top - rect.top;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      createdAnimations.push(
        bubble.animate(
          [
            { transform: `translate(${dx}px, ${dy}px)` },
            { transform: "translate(0px, 0px)" },
          ],
          { duration: SPLIT_DURATION_MS, easing: SPLIT_EASING }
        )
      );
    }
  }

  if (dockShell) {
    const rect = dockShell.getBoundingClientRect();
    // Bottom halves align: the emptied shell keeps its control row and slides
    // down from the old shell's lower edge into the dock.
    const dx = src.left - rect.left;
    const dy = src.bottom - rect.bottom;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      createdAnimations.push(
        dockShell.animate(
          [
            { transform: `translate(${dx}px, ${dy}px)` },
            { transform: "translate(0px, 0px)" },
          ],
          { duration: SPLIT_DURATION_MS, easing: SPLIT_EASING }
        )
      );
    }
  }

  if (createdAnimations.length === 0) {
    releaseSplitWaiters();
  } else {
    void Promise.allSettled(createdAnimations.map((a) => a.ready)).then(() => {
      notifyStarted?.();
      notifyStarted = null;
    });
    void Promise.allSettled(createdAnimations.map((a) => a.finished)).then(() => {
      releaseSplitWaiters();
    });
  }
}
