"use client";

/**
 * Fired (already coalesced) whenever the active workspace's file watcher
 * reports changes. Lets derived views such as the composer insights refresh
 * when something actually changed instead of on a fixed timer.
 */
export const WORKSPACE_FS_CHANGED_EVENT = "opencursor:workspace-fs-changed";

export function notifyWorkspaceFsChanged(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(WORKSPACE_FS_CHANGED_EVENT));
}
