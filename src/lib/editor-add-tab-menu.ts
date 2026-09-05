/**
 * Catalog for the editor tab-strip "+" chevron menu.
 *
 * The plus button itself still opens the file palette. The chevron lists the
 * other first-class editor surfaces that are easy to miss in the command palette.
 */

export type EditorAddTabMenuId =
  | "terminal"
  | "browser"
  | "pullRequest"
  | "orchestrationBoard"
  | "marketplace";

export type EditorAddTabMenuGroup = "session" | "surface";

export type EditorAddTabMenuItem = {
  id: EditorAddTabMenuId;
  label: string;
  group: EditorAddTabMenuGroup;
};

export type EditorAddTabMenuAvailability = {
  terminal?: boolean;
  browser?: boolean;
  pullRequest?: boolean;
  orchestrationBoard?: boolean;
  marketplace?: boolean;
};

const CATALOG: readonly EditorAddTabMenuItem[] = [
  { id: "terminal", label: "New Terminal", group: "session" },
  { id: "browser", label: "New Browser Tab", group: "session" },
  { id: "pullRequest", label: "Open Pull Request", group: "surface" },
  { id: "orchestrationBoard", label: "New Orchestration Board", group: "surface" },
  { id: "marketplace", label: "Extension Marketplace", group: "surface" },
];

export function listEditorAddTabMenuItems(
  available: EditorAddTabMenuAvailability
): EditorAddTabMenuItem[] {
  return CATALOG.filter((item) => Boolean(available[item.id]));
}

/** Insert a divider between session tabs (terminal/browser) and the later surfaces. */
export function editorAddTabMenuNeedsSeparatorBefore(
  items: readonly EditorAddTabMenuItem[],
  index: number
): boolean {
  const current = items[index];
  const previous = items[index - 1];
  return Boolean(current && previous && current.group !== previous.group);
}
