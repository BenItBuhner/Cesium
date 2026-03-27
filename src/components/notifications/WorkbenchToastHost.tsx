"use client";

import { useContext } from "react";
import { WorkbenchToast } from "@/components/notifications/WorkbenchToast";
import { WorkbenchNotificationContext } from "@/components/notifications/workbench-notification-context";

const MAX_VISIBLE = 5;

export function WorkbenchToastHost() {
  const ctx = useContext(WorkbenchNotificationContext);
  if (!ctx) return null;

  const { notifications, exitingIds, requestDismiss } = ctx;
  const visible = notifications.slice(-MAX_VISIBLE);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[10040] flex max-h-[min(70vh,calc(100vh-48px))] max-w-[calc(100vw-24px)] flex-col justify-end gap-2 overflow-hidden sm:bottom-5 sm:right-5">
      {visible.map((item) => (
        <WorkbenchToast
          key={item.id}
          item={item}
          exiting={exitingIds.has(item.id)}
          onRequestDismiss={() => requestDismiss(item.id)}
        />
      ))}
    </div>
  );
}
