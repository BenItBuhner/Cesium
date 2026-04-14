import type { EditorBridge } from "@/components/ide/EditorBridgeContext";
import { getEditorPaneState } from "@/lib/editor-session-state";

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
  if (!groupAttr) return false;

  const s = bridge.getState();
  const pane = getEditorPaneState(s, groupAttr);
  if (!pane) {
    return false;
  }
  const activeId = pane.activeId;
  const tabs = pane.tabs;
  const tab = tabs.find((t) => t.id === activeId);
  return Boolean(tab?.browser);
}
