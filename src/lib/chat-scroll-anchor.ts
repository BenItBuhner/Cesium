import type { ChatScrollAnchor } from "@/lib/workspace-session";

export function contentTopOfElementInScrollRoot(
  el: Element,
  scrollRoot: HTMLElement
): number {
  const rootRect = scrollRoot.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  return elRect.top - rootRect.top + scrollRoot.scrollTop;
}

function selectorForChatMessageId(id: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return `[data-chat-message-id="${CSS.escape(id)}"]`;
  }
  return `[data-chat-message-id="${id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
}

/**
 * Virtual sticky headers duplicate the active user message id outside the measured row.
 * Prefer the copy inside a virtual row so navigation resolves to the turn's real content offset.
 */
export function findChatMessageElement(
  scrollRoot: HTMLElement,
  messageId: string
): HTMLElement | null {
  const matches = Array.from(
    scrollRoot.querySelectorAll<HTMLElement>(selectorForChatMessageId(messageId))
  );
  return matches.find((element) => element.closest("[data-index]")) ?? matches[0] ?? null;
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
    const el = findChatMessageElement(scrollRoot, id);
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
    const el = findChatMessageElement(scrollRoot, id);
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
  const el = findChatMessageElement(scrollRoot, anchor.messageId);
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
