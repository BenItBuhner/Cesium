export type ComposerCommandPanelPlacement = "above" | "below";

export type ComposerCommandPanelAnchor = {
  left: number;
  top: number;
  bottom: number;
  width: number;
};

export type ComposerCommandPanelPosition = {
  placement: ComposerCommandPanelPlacement;
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
};

export function hasVisibleFollowingSibling(element: HTMLElement | null): boolean {
  let sibling = element?.nextElementSibling ?? null;
  while (sibling) {
    if (sibling instanceof HTMLElement) {
      const style = getComputedStyle(sibling);
      if (style.display !== "none" && style.visibility !== "hidden") {
        const rect = sibling.getBoundingClientRect();
        if (rect.height > 4 && rect.width > 4) {
          return true;
        }
      }
    }
    sibling = sibling.nextElementSibling;
  }
  return false;
}

/**
 * New chats (`empty-top`) open the command panel into the space below the
 * composer. Existing threads (`docked-bottom`) open it above. Widgets such as
 * landing actions that already occupy the space below flip a new chat to above
 * so the panel does not cover them.
 */
export function resolveComposerCommandPanelPlacement(input: {
  layout: "docked-bottom" | "empty-top";
  isExpanded?: boolean;
  hasBeneathWidgets: boolean;
}): ComposerCommandPanelPlacement {
  if (input.isExpanded) {
    return "above";
  }
  if (input.layout === "empty-top" && !input.hasBeneathWidgets) {
    return "below";
  }
  return "above";
}

export function positionComposerCommandPanel(
  anchor: ComposerCommandPanelAnchor,
  placement: ComposerCommandPanelPlacement,
  viewport: { width: number; height: number },
  options?: { gap?: number; edge?: number; maxHeightCap?: number }
): ComposerCommandPanelPosition {
  const gap = options?.gap ?? 8;
  const edge = options?.edge ?? 8;
  const maxHeightCap = options?.maxHeightCap ?? 440;
  const left = Math.max(edge, Math.min(anchor.left, viewport.width - edge - 48));
  const width = Math.max(160, Math.min(anchor.width, viewport.width - left - edge));

  if (placement === "below") {
    const space = viewport.height - anchor.bottom - gap - edge;
    return {
      placement: "below",
      top: anchor.bottom + gap,
      left,
      width,
      maxHeight: Math.min(maxHeightCap, Math.max(140, space)),
    };
  }

  const space = anchor.top - gap - edge;
  return {
    placement: "above",
    bottom: viewport.height - anchor.top + gap,
    left,
    width,
    maxHeight: Math.min(maxHeightCap, Math.max(140, space)),
  };
}
