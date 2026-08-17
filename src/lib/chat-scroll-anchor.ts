import type { ChatScrollAnchor } from "@/lib/workspace-session";

/**
 * A `position: sticky` user header reports its pinned rect while stuck, not its flow position.
 * Inside a virtualized thread the header sits at the very top of its row wrapper
 * (`[data-index]`), which never sticks, so the row's rect is an exact flow-position proxy.
 * Outside virtual rows (short threads) fall back to the element itself; its stuck offset is
 * bounded by the scripted push-off there.
 */
function flowPositionElementFor(el: Element): Element {
  if (!(el instanceof HTMLElement) || el.dataset.chatStickyHeader == null) {
    return el;
  }
  return el.closest("[data-index]") ?? el;
}

export function contentTopOfElementInScrollRoot(
  el: Element,
  scrollRoot: HTMLElement
): number {
  const rootRect = scrollRoot.getBoundingClientRect();
  const elRect = flowPositionElementFor(el).getBoundingClientRect();
  return elRect.top - rootRect.top + scrollRoot.scrollTop;
}

function selectorForChatMessageId(id: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return `[data-chat-message-id="${CSS.escape(id)}"]`;
  }
  return `[data-chat-message-id="${id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
}

export function findChatMessageElement(
  scrollRoot: HTMLElement,
  messageId: string
): HTMLElement | null {
  return scrollRoot.querySelector<HTMLElement>(selectorForChatMessageId(messageId));
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
