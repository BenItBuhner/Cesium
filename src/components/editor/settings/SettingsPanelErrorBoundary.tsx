"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

type SettingsPanelErrorBoundaryProps = {
  /** Active settings nav id - remounting on change clears a previous error. */
  panelId: string;
  children: ReactNode;
};

type SettingsPanelErrorBoundaryState = {
  error: Error | null;
};

/**
 * Contains render crashes to the active settings panel. Panels render data
 * straight off the wire from whichever server the app is connected to, and a
 * malformed payload (older/newer server builds, self-updating installs) used
 * to take down the whole workbench via the root error boundary - leaving only
 * a full reload to recover. With this boundary the settings shell, its nav,
 * and the rest of the app stay usable; the user can retry or switch panels.
 */
export class SettingsPanelErrorBoundary extends Component<
  SettingsPanelErrorBoundaryProps,
  SettingsPanelErrorBoundaryState
> {
  state: SettingsPanelErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): SettingsPanelErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[settings] panel "${this.props.panelId}" failed to render`,
      error,
      info.componentStack
    );
  }

  componentDidUpdate(prevProps: SettingsPanelErrorBoundaryProps) {
    if (prevProps.panelId !== this.props.panelId && this.state.error) {
      this.setState({ error: null });
    }
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <div className="flex flex-col gap-[10px] rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-card)] px-[16px] py-[14px]">
        <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
          This settings section failed to render
        </p>
        <p className="break-words font-sans text-[12px] text-[var(--text-secondary)]">
          {this.state.error.message || "Unknown error"}
        </p>
        <p className="font-sans text-[12px] text-[var(--text-secondary)]">
          The rest of Cesium is unaffected - you can switch to another section.
          If this keeps happening, the connected server may be returning data
          this app version does not understand.
        </p>
        <div>
          <button
            type="button"
            onClick={this.handleRetry}
            className="rounded-[var(--radius-tab)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-[12px] py-[6px] font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
