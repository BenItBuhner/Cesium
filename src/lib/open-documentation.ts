"use client";

/** In-app documentation route (Next app router + desktop renderer pathname). */
export const DOCS_PATH = "/docs";

/**
 * Packaged Electron renderer (`loadFile`) cannot rely on `history.replaceState` for
 * `/docs` on `file:` URLs; main process sets this query on the docs window instead.
 */
export const DOCS_ROUTE_QUERY_PARAM = "cesiumRoute";
export const DOCS_ROUTE_QUERY_VALUE = "docs";

type CesiumDesktopDocsBridge = {
  openDocsWindow?: () => boolean | Promise<boolean>;
  openExternal?: (url: string) => boolean | Promise<boolean>;
};

export function isDocsPath(pathname: string): boolean {
  return pathname === DOCS_PATH || pathname.startsWith(`${DOCS_PATH}/`);
}

export function isDocsRoute(
  location: Pick<Location, "pathname" | "search"> = typeof window !== "undefined"
    ? window.location
    : { pathname: "/", search: "" }
): boolean {
  if (isDocsPath(location.pathname)) {
    return true;
  }
  return (
    new URLSearchParams(location.search).get(DOCS_ROUTE_QUERY_PARAM) ===
    DOCS_ROUTE_QUERY_VALUE
  );
}

/**
 * Opens product documentation without leaving the current workbench tab/window.
 * Web: new browser tab at `/docs`. Electron: dedicated docs BrowserWindow via IPC.
 */
export function openDocumentation(): void {
  if (typeof window === "undefined") {
    return;
  }

  const desktop = (
    window as Window & { cesiumDesktop?: CesiumDesktopDocsBridge }
  ).cesiumDesktop;

  if (desktop?.openDocsWindow) {
    void (async () => {
      const opened = await desktop.openDocsWindow?.();
      if (opened !== false) {
        return;
      }
      const url = `${window.location.origin}${DOCS_PATH}`;
      if (desktop.openExternal) {
        await desktop.openExternal(url);
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    })();
    return;
  }

  const url = `${window.location.origin}${DOCS_PATH}`;
  window.open(url, "_blank", "noopener,noreferrer");
}
