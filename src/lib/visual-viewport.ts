/** CSS custom properties that pin the workbench to the visual viewport. */
export const VISUAL_VIEWPORT_HEIGHT_VAR = "--cesium-vvh";
export const VISUAL_VIEWPORT_WIDTH_VAR = "--cesium-vvw";
export const VISUAL_VIEWPORT_TOP_VAR = "--cesium-vv-top";
export const VISUAL_VIEWPORT_LEFT_VAR = "--cesium-vv-left";

/** Added to `<html>` on workbench routes so the document cannot outgrow the visual viewport. */
export const WORKBENCH_VIEWPORT_CLASS = "cesium-workbench-viewport";

/** Paths that render the full-screen workbench shell. */
export const WORKBENCH_VIEWPORT_PATHS = ["/agent", "/workspace", "/editor"] as const;

export type VisualViewportMetrics = {
  height: number;
  width: number;
  offsetTop: number;
  offsetLeft: number;
};

type VisualViewportLike = {
  height?: number | null;
  width?: number | null;
  offsetTop?: number | null;
  offsetLeft?: number | null;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

type StyleTarget = {
  style: {
    setProperty: (name: string, value: string) => void;
  };
  classList?: {
    add: (name: string) => void;
    remove: (name: string) => void;
  };
};

export type VisualViewportWindow = {
  innerHeight?: number;
  innerWidth?: number;
  visualViewport?: VisualViewportLike | null;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  document?: {
    documentElement?: StyleTarget;
  };
  location?: {
    pathname?: string;
  };
};

function positiveNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function isWorkbenchViewportPath(pathname: string | null | undefined): boolean {
  if (!pathname) {
    return false;
  }
  return WORKBENCH_VIEWPORT_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
}

export function readVisualViewport(win: VisualViewportWindow): VisualViewportMetrics {
  const visual = win.visualViewport;
  return {
    height: positiveNumber(visual?.height) ?? positiveNumber(win.innerHeight) ?? 0,
    width: positiveNumber(visual?.width) ?? positiveNumber(win.innerWidth) ?? 0,
    offsetTop: finiteNumber(visual?.offsetTop) ?? 0,
    offsetLeft: finiteNumber(visual?.offsetLeft) ?? 0,
  };
}

export function applyVisualViewportVars(
  root: StyleTarget,
  metrics: VisualViewportMetrics
): void {
  root.style.setProperty(VISUAL_VIEWPORT_HEIGHT_VAR, `${metrics.height}px`);
  root.style.setProperty(VISUAL_VIEWPORT_WIDTH_VAR, `${metrics.width}px`);
  root.style.setProperty(VISUAL_VIEWPORT_TOP_VAR, `${metrics.offsetTop}px`);
  root.style.setProperty(VISUAL_VIEWPORT_LEFT_VAR, `${metrics.offsetLeft}px`);
}

export function syncVisualViewport(
  win: VisualViewportWindow,
  root: StyleTarget
): VisualViewportMetrics {
  const metrics = readVisualViewport(win);
  applyVisualViewportVars(root, metrics);
  return metrics;
}

export function subscribeVisualViewport(
  win: VisualViewportWindow,
  onChange: () => void
): () => void {
  const visual = win.visualViewport;
  visual?.addEventListener?.("resize", onChange);
  visual?.addEventListener?.("scroll", onChange);
  win.addEventListener?.("resize", onChange);
  win.addEventListener?.("orientationchange", onChange);
  return () => {
    visual?.removeEventListener?.("resize", onChange);
    visual?.removeEventListener?.("scroll", onChange);
    win.removeEventListener?.("resize", onChange);
    win.removeEventListener?.("orientationchange", onChange);
  };
}

export function setWorkbenchViewportClass(
  root: StyleTarget,
  enabled: boolean
): void {
  if (!root.classList) {
    return;
  }
  if (enabled) {
    root.classList.add(WORKBENCH_VIEWPORT_CLASS);
    return;
  }
  root.classList.remove(WORKBENCH_VIEWPORT_CLASS);
}

/**
 * Write visual-viewport CSS vars and keep them in sync. Optionally lock the
 * document to the workbench class when the current path is a workbench route.
 */
export function installVisualViewportLock(
  win: VisualViewportWindow,
  options?: { lockWorkbenchClass?: boolean }
): () => void {
  const root = win.document?.documentElement;
  if (!root) {
    return () => {};
  }
  const apply = () => {
    syncVisualViewport(win, root);
    if (options?.lockWorkbenchClass) {
      setWorkbenchViewportClass(
        root,
        isWorkbenchViewportPath(win.location?.pathname)
      );
    }
  };
  apply();
  return subscribeVisualViewport(win, apply);
}

/**
 * Inline `<head>` script so the first paint of `/agent` already uses the
 * visual viewport instead of `100vh` (which includes mobile browser chrome).
 */
export function buildVisualViewportBootstrapScript(): string {
  return `(()=>{try{var r=document.documentElement;var C=${JSON.stringify(WORKBENCH_VIEWPORT_CLASS)};var P=${JSON.stringify(WORKBENCH_VIEWPORT_PATHS)};function pos(v){return typeof v==="number"&&isFinite(v)&&v>0?v:null}function fin(v){return typeof v==="number"&&isFinite(v)?v:0}function pathOk(p){if(!p)return false;for(var i=0;i<P.length;i++){if(p===P[i]||p.indexOf(P[i]+"/")===0)return true}return false}function apply(){var vv=window.visualViewport;var h=pos(vv&&vv.height)||pos(window.innerHeight)||0;var w=pos(vv&&vv.width)||pos(window.innerWidth)||0;r.style.setProperty(${JSON.stringify(VISUAL_VIEWPORT_HEIGHT_VAR)},h+"px");r.style.setProperty(${JSON.stringify(VISUAL_VIEWPORT_WIDTH_VAR)},w+"px");r.style.setProperty(${JSON.stringify(VISUAL_VIEWPORT_TOP_VAR)},fin(vv&&vv.offsetTop)+"px");r.style.setProperty(${JSON.stringify(VISUAL_VIEWPORT_LEFT_VAR)},fin(vv&&vv.offsetLeft)+"px");if(pathOk(location.pathname))r.classList.add(C)}apply();var vv=window.visualViewport;if(vv&&vv.addEventListener){vv.addEventListener("resize",apply);vv.addEventListener("scroll",apply)}window.addEventListener("resize",apply);window.addEventListener("orientationchange",apply)}catch(e){}})();`;
}
