export const OPEN_WORKSPACE_STUDIO_EVENT = "opencursor:open-workspace-studio";

export type WorkspaceStudioOpenMode = "clone" | "browse" | "newfolder";

export function openWorkspaceStudio(mode: WorkspaceStudioOpenMode = "clone"): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent(OPEN_WORKSPACE_STUDIO_EVENT, { detail: { mode } })
  );
}

export function isOpenWorkspaceStudioEvent(
  event: Event
): event is CustomEvent<{ mode: WorkspaceStudioOpenMode }> {
  return event.type === OPEN_WORKSPACE_STUDIO_EVENT;
}
