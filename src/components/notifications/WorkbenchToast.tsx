"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import type {
  WorkbenchNotificationItem,
  WorkbenchNotificationSeverity,
} from "@/components/notifications/workbench-notification-types";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";

const EXIT_MS = 220;

function SeverityIcon({
  severity,
  className,
}: {
  severity: WorkbenchNotificationSeverity;
  className?: string;
}) {
  switch (severity) {
    case "error":
      return <AlertTriangle className={className} strokeWidth={1.8} aria-hidden />;
    case "warning":
      return <AlertTriangle className={className} strokeWidth={1.8} aria-hidden />;
    case "info":
    default:
      return <Info className={className} strokeWidth={1.8} aria-hidden />;
  }
}

export function WorkbenchToast({
  item,
  exiting,
  onRequestDismiss,
}: {
  item: WorkbenchNotificationItem;
  exiting: boolean;
  onRequestDismiss: () => void;
}) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const visible = exiting ? false : entered;

  return (
    <section
      role={item.severity === "error" ? "alert" : "status"}
      aria-live={item.severity === "error" ? "assertive" : "polite"}
      className={`pointer-events-auto w-[min(420px,calc(100vw-24px))] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] shadow-[var(--palette-shadow)] transition-[transform,opacity] duration-200 ease-out will-change-transform ${
        visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
      }`}
    >
      <div className="flex items-start gap-[10px] px-[12px] pb-[10px] pt-[12px]">
        <div
          className="mt-[1px] flex size-[26px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] border"
          style={{
            color:
              item.kind === WORKBENCH_NOTIFICATION_KIND.connectionReconnected
                ? "var(--accent)"
                : item.severity === "error" || item.severity === "warning"
                  ? "var(--debug-accent)"
                  : "var(--text-secondary)",
            borderColor:
              item.kind === WORKBENCH_NOTIFICATION_KIND.connectionReconnected
                ? "color-mix(in srgb, var(--accent) 30%, var(--border-card))"
                : "color-mix(in srgb, var(--debug-accent) 26%, var(--border-card))",
            backgroundColor:
              item.kind === WORKBENCH_NOTIFICATION_KIND.connectionReconnected
                ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                : "color-mix(in srgb, var(--debug-accent) 12%, transparent)",
          }}
        >
          {item.kind === WORKBENCH_NOTIFICATION_KIND.connectionReconnected ? (
            <CheckCircle2 className="size-[14px]" strokeWidth={1.8} aria-hidden />
          ) : (
            <SeverityIcon severity={item.severity} className="size-[14px]" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-[8px]">
            <div className="min-w-0 flex-1">
              <h2 className="font-sans text-[12px] font-semibold tracking-[0.01em] text-[var(--text-primary)]">
                {item.title}
              </h2>
              <p className="mt-[3px] font-sans text-[12px] leading-[1.45] text-[var(--text-secondary)]">
                {item.message}
              </p>
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={onRequestDismiss}
              className="flex size-[24px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] border border-transparent text-[var(--text-secondary)] transition-colors hover:border-[var(--border-card)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
            >
              <X className="size-[14px]" strokeWidth={1.8} aria-hidden />
            </button>
          </div>

          {item.actions && item.actions.length > 0 ? (
            <div className="mt-[10px] flex flex-wrap gap-[8px]">
              {item.actions.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    a.onClick();
                  }}
                  className={
                    a.primary
                      ? "inline-flex items-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--accent)] bg-[var(--accent)] px-[11px] py-[6px] font-sans text-[12px] font-medium transition-opacity hover:opacity-90"
                      : "rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[11px] py-[6px] font-sans text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]"
                  }
                  style={a.primary ? { color: "var(--bg-main)" } : undefined}
                >
                  {a.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export { EXIT_MS };
