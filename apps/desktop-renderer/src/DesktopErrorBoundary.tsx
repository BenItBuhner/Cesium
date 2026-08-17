import React, { Component, type ErrorInfo, type ReactNode } from "react";
import {
  WORKBENCH_VIEW_SEARCH_PARAM,
  requestDefaultShellViewOnNextLaunch,
} from "@/lib/workbench-view";

/**
 * Captured at module evaluation, before React renders and before anything can
 * call `history.replaceState`. In the packaged renderers (Electron, Android
 * WebView) the document lives at a real `file://…/index.html` path; reloading
 * a rewritten in-app URL such as `file:///agent?view=settings` fails with
 * `net::ERR_FILE_NOT_FOUND`, so recovery must navigate back to this URL.
 */
const BOOT_DOCUMENT_URL =
  typeof window !== "undefined" ? window.location.href : null;

/**
 * Build the recovery URL: the original boot document with every shell-view
 * routing param stripped, so the app springs back to the default new-chat
 * view instead of re-entering whichever view just crashed.
 */
function buildRecoveryUrl(): string | null {
  const candidate = BOOT_DOCUMENT_URL ?? window.location.href;
  try {
    const url = new URL(candidate);
    url.searchParams.delete(WORKBENCH_VIEW_SEARCH_PARAM);
    return url.toString();
  } catch {
    return null;
  }
}

type DesktopErrorBoundaryProps = {
  children: ReactNode;
};

type DesktopErrorBoundaryState = {
  error: Error | null;
};

export class DesktopErrorBoundary extends Component<
  DesktopErrorBoundaryProps,
  DesktopErrorBoundaryState
> {
  state: DesktopErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): DesktopErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[cesium-desktop-renderer] UI error", error, info.componentStack);
  }

  private handleReload = () => {
    // Persisted session state can pin the crashing view (e.g. Settings) as the
    // launch view, turning one render error into a permanent boot loop. Ask
    // the next launch to fall back to the default new-chat view instead.
    requestDefaultShellViewOnNextLaunch();
    const target = buildRecoveryUrl();
    if (target && target !== window.location.href) {
      window.location.replace(target);
      return;
    }
    window.location.reload();
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-[12px] bg-[#191919] px-[24px] text-center text-[#e5e5e5]">
        <p className="font-sans text-[15px] font-medium">Cesium hit an unexpected UI error</p>
        <p className="max-w-[480px] font-sans text-[12px] text-[#a3a3a3]">
          {this.state.error.message || "Unknown error"}
        </p>
        <button
          type="button"
          onClick={this.handleReload}
          className="rounded-[8px] border border-[#404040] bg-[#262626] px-[14px] py-[8px] font-sans text-[12px] text-[#fafafa] hover:bg-[#333333]"
        >
          Reload Cesium
        </button>
      </div>
    );
  }
}
