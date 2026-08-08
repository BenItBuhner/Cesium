/**
 * "Split" transition for spawning a conversation from the new-chat composer.
 *
 * On submit the composer card visually divides: the typed prompt becomes the
 * user-message card at the top of the fresh thread (top-aligned with the old
 * shell), while the emptied composer shell peels off to its docked resting
 * spot at the bottom (bottom-aligned with the old shell). Both pieces are the
 * *real* destination elements FLIP-translated from the captured source rect,
 * so nothing is cloned or faked — the cards genuinely travel to where they
 * live, at any viewport size.
 *
 * Usage: `captureComposerSplitSource()` synchronously in the submit handler
 * (while the source composer is still mounted), then
 * `runComposerSplitAnimation()` from a layout effect once the optimistic
 * conversation view has rendered.
 */

type SplitSource = {
  shellRect: DOMRect;
  capturedAt: number;
};

let pendingSource: SplitSource | null = null;

const SOURCE_TTL_MS = 800;
const SPLIT_EASING = "cubic-bezier(0.24, 0.9, 0.3, 1)";
const SPLIT_DURATION_MS = 360;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
  );
}

export function captureComposerSplitSource(scope?: HTMLElement | null): void {
  const root: ParentNode = scope ?? document;
  const shell = root.querySelector<HTMLElement>("[data-composer-shell]");
  if (!shell) {
    pendingSource = null;
    return;
  }
  pendingSource = {
    shellRect: shell.getBoundingClientRect(),
    capturedAt: performance.now(),
  };
}

export function clearComposerSplitSource(): void {
  pendingSource = null;
}

/**
 * FLIP the freshly-rendered first user-message card and the docked composer
 * shell from the captured source shell rect to their natural positions.
 */
export function runComposerSplitAnimation(scope: HTMLElement | null): void {
  const source = pendingSource;
  pendingSource = null;
  if (!source || !scope) {
    return;
  }
  if (performance.now() - source.capturedAt > SOURCE_TTL_MS) {
    return;
  }
  if (prefersReducedMotion()) {
    return;
  }

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
      bubble.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: "translate(0px, 0px)" },
        ],
        { duration: SPLIT_DURATION_MS, easing: SPLIT_EASING }
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
      dockShell.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: "translate(0px, 0px)" },
        ],
        { duration: SPLIT_DURATION_MS, easing: SPLIT_EASING }
      );
    }
  }
}
