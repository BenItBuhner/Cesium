import type { ChatScrollAnchor } from "@/lib/workspace-session";

export function contentTopOfElementInScrollRoot(
  el: Element,
  scrollRoot: HTMLElement
): number {
  const rootRect = scrollRoot.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  return elRect.top - rootRect.top + scrollRoot.scrollTop;
}

export function selectorForChatMessageId(id: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return `[data-chat-message-id="${CSS.escape(id)}"]`;
  }
  return `[data-chat-message-id="${id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
}

/**
 * Pick a message row at or above the viewport top and compute delta = scrollTop - rowTop.
 */
export function findChatScrollAnchor(
  scrollRoot: HTMLElement,
  scrollTop: number,
  orderedMessageIds: string[]
): ChatScrollAnchor | null {
  let best: { id: string; top: number } | null = null;
  for (const id of orderedMessageIds) {
    const el = scrollRoot.querySelector(selectorForChatMessageId(id));
    if (!el) {
      continue;
    }
    const top = contentTopOfElementInScrollRoot(el, scrollRoot);
    if (top <= scrollTop + 0.75) {
      if (!best || top > best.top) {
        best = { id, top };
      }
    }
  }
  if (best) {
    return { messageId: best.id, delta: scrollTop - best.top };
  }
  for (const id of orderedMessageIds) {
    const el = scrollRoot.querySelector(selectorForChatMessageId(id));
    if (!el) {
      continue;
    }
    const top = contentTopOfElementInScrollRoot(el, scrollRoot);
    return { messageId: id, delta: scrollTop - top };
  }
  return null;
}

export function scrollTopForAnchor(
  scrollRoot: HTMLElement,
  anchor: ChatScrollAnchor
): number | null {
  const el = scrollRoot.querySelector(selectorForChatMessageId(anchor.messageId));
  if (!el) {
    return null;
  }
  const top = contentTopOfElementInScrollRoot(el, scrollRoot);
  return top + anchor.delta;
}

/** TanStack Virtual and some browsers need a nudge after programmatic scrollTop writes. */
export function notifyScrollElementLayout(scrollRoot: HTMLElement | null): void {
  if (!scrollRoot || typeof window === "undefined") {
    return;
  }
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      scrollRoot.dispatchEvent(new Event("scroll", { bubbles: false }));
    });
  });
}

/**
 * Align a chat message row under the sticky rail inset. Returns false when the row is not in the DOM
 * (e.g. virtualized out of range — caller should scroll the virtualizer first).
 */
export function scrollChatMessageIntoView(
  scrollRoot: HTMLElement,
  messageId: string,
  railInsetPx: number
): boolean {
  const el = scrollRoot.querySelector(selectorForChatMessageId(messageId));
  if (!el) {
    return false;
  }
  const top = contentTopOfElementInScrollRoot(el, scrollRoot);
  scrollRoot.scrollTop = Math.max(0, top - railInsetPx);
  notifyScrollElementLayout(scrollRoot);
  return true;
}
