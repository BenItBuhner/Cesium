"use client";

/**
 * Fired when the agent socket reports that a workspace's browser-control tab
 * set changed. The editor listens and re-syncs its tab strip on demand, so the
 * old 2s tab-list poll is only a slow consistency backstop now.
 */
export const BROWSER_CONTROL_TABS_CHANGED_EVENT = "opencursor:browser-control-tabs-changed";

export type BrowserControlTabsChangedDetail = { workspaceId: string };

export function notifyBrowserControlTabsChanged(workspaceId: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<BrowserControlTabsChangedDetail>(BROWSER_CONTROL_TABS_CHANGED_EVENT, {
      detail: { workspaceId },
    })
  );
}
