import React, { Component, type ErrorInfo, type ReactNode } from "react";

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
