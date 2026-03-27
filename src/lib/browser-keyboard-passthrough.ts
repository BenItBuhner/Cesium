import type { EditorBridge } from "@/components/ide/EditorBridgeContext";

/**
 * True when the event target is inside an in-IDE browser tab surface and that
 * pane's active tab is a browser tab. Then workbench shortcuts should not run so
 * keys go to the URL bar / toolbar (and the iframe never dispatches keydown on
 * the parent document when cross-origin).
 */
export function isFocusedBrowserSurface(
  bridge: EditorBridge | null,
  eventTarget: EventTarget | null
): boolean {
  if (!bridge || !eventTarget || !(eventTarget instanceof Element)) {
    return false;
  }
  const surface = eventTarget.closest(
    "[data-ide-browser-surface][data-ide-editor-group]"
  );
  if (!surface) return false;
  const groupAttr = surface.getAttribute("data-ide-editor-group");
  if (groupAttr !== "left" && groupAttr !== "right") return false;

  const s = bridge.getState();
  const activeId =
    groupAttr === "left" ? s.leftActiveId : s.rightActiveId;
  const tabs = groupAttr === "left" ? s.leftTabs : s.rightTabs;
  const tab = tabs.find((t) => t.id === activeId);
  return Boolean(tab?.browser);
}
