/**
 * Clipboard writes that survive mobile browsers.
 *
 * Every copy button in the workbench routes through {@link copyTextToClipboard}
 * so the platform quirks live in one place:
 *
 * - Mobile browsers (Android Chrome/Edge, iOS Safari, embedded WebViews) only
 *   honour a clipboard write that STARTS synchronously inside the tap handler.
 *   Awaiting anything before `navigator.clipboard.writeText` (a fetch, a state
 *   update, a permission probe) spends the gesture's transient activation and
 *   the write rejects with NotAllowedError.
 * - Older Android System WebViews, plain http:// origins and locked-down
 *   contexts do not expose `navigator.clipboard` at all, or reject every write.
 *   `document.execCommand("copy")` on a hidden textarea still works there while
 *   the gesture is live.
 * - When both fail the user can still copy by hand, so the visible text gets
 *   selected for a long-press / Ctrl+C. A copy attempt never ends as a silent
 *   no-op: callers always learn what happened and can say so.
 */

export type CopyTextResult =
  | { ok: true; method: "clipboard-api" | "exec-command" }
  | {
      ok: false;
      method: "none";
      /** The fallback element's text is selected, ready for a manual copy. */
      selected: boolean;
    };

export type CopyTextOptions = {
  /**
   * Element whose text is selected when every clipboard path fails, so the
   * user can long-press (touch) or Ctrl+C the visible text instead.
   */
  selectionFallback?: Element | null;
};

type FocusableLike = { focus: (options?: FocusOptions) => void };

function hasFocus(value: unknown): value is FocusableLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { focus?: unknown }).focus === "function"
  );
}

function currentDocument(): Document | null {
  return typeof document === "undefined" ? null : document;
}

/**
 * Starts the async Clipboard API write synchronously (no awaits before it) so
 * it runs inside the caller's user gesture. Returns null when the API is
 * missing or throws synchronously, which some WebViews do.
 */
function startClipboardApiWrite(text: string): Promise<void> | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  const clipboard = navigator.clipboard;
  if (!clipboard || typeof clipboard.writeText !== "function") {
    return null;
  }
  try {
    return Promise.resolve(clipboard.writeText(text));
  } catch {
    return null;
  }
}

/**
 * Legacy copy path: select the text inside an off-screen, read-only textarea
 * and ask the browser to copy the selection. Read-only + fixed positioning
 * keep the mobile keyboard closed and the page from scrolling; focus returns
 * to the element that had it (the copy button) afterwards.
 */
function execCommandCopy(text: string, doc: Document): boolean {
  if (typeof doc.execCommand !== "function" || !doc.body) {
    return false;
  }
  const previouslyFocused = hasFocus(doc.activeElement) ? doc.activeElement : null;
  let textarea: HTMLTextAreaElement;
  try {
    textarea = doc.createElement("textarea");
  } catch {
    return false;
  }
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.tabIndex = -1;
  Object.assign(textarea.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "1px",
    height: "1px",
    padding: "0",
    border: "0",
    opacity: "0",
    pointerEvents: "none",
    // Prevents iOS from zooming the viewport when the textarea takes focus.
    fontSize: "16px",
  });
  let copied = false;
  try {
    doc.body.appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    // iOS ignores select() on read-only fields; the explicit range works.
    textarea.setSelectionRange(0, text.length);
    copied = doc.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    try {
      textarea.remove();
    } catch {
      // Detached already.
    }
    if (previouslyFocused) {
      try {
        previouslyFocused.focus({ preventScroll: true });
      } catch {
        // Focus restoration is best effort.
      }
    }
  }
  return copied;
}

/** Selects the element's text so a long-press / Ctrl+C copies it by hand. */
function selectElementText(target: Element, doc: Document): boolean {
  try {
    const selection =
      typeof doc.getSelection === "function"
        ? doc.getSelection()
        : typeof window !== "undefined" && typeof window.getSelection === "function"
          ? window.getSelection()
          : null;
    if (!selection || typeof doc.createRange !== "function") {
      return false;
    }
    const range = doc.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies `text` to the clipboard. Call it directly from the click / tap
 * handler: the Clipboard API write starts synchronously inside the gesture,
 * then falls back to `document.execCommand("copy")`, then to selecting
 * `options.selectionFallback` so a manual copy still works.
 *
 * Never rejects; inspect the resolved result to show "Copied" or a
 * "could not copy, long-press to select" hint.
 */
export function copyTextToClipboard(
  text: string,
  options: CopyTextOptions = {}
): Promise<CopyTextResult> {
  const fallback = (): CopyTextResult => {
    const doc = currentDocument();
    if (doc && execCommandCopy(text, doc)) {
      return { ok: true, method: "exec-command" };
    }
    const target = options.selectionFallback ?? null;
    const selected = Boolean(doc && target && selectElementText(target, doc));
    return { ok: false, method: "none", selected };
  };

  const pending = startClipboardApiWrite(text);
  if (!pending) {
    return Promise.resolve(fallback());
  }
  return pending.then(
    (): CopyTextResult => ({ ok: true, method: "clipboard-api" }),
    () => fallback()
  );
}

/** Short user-facing explanation for a failed copy, matching the fallback that ran. */
export function describeCopyFailure(
  result: Extract<CopyTextResult, { ok: false }>,
  subject = "text"
): string {
  return result.selected
    ? `Could not copy automatically. The ${subject} is selected - long-press it (or press Ctrl+C) to copy.`
    : `Could not copy automatically. Long-press the ${subject} to select and copy it.`;
}
