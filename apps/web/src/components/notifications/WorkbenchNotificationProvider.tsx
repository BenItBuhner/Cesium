"use client";

import {
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { EXIT_MS } from "@/components/notifications/WorkbenchToast";
import {
  WorkbenchNotificationContext,
  type WorkbenchNotificationContextValue,
} from "@/components/notifications/workbench-notification-context";
import { WorkbenchToastHost } from "@/components/notifications/WorkbenchToastHost";
import type {
  WorkbenchNotificationInput,
  WorkbenchNotificationItem,
} from "@/components/notifications/workbench-notification-types";

export function WorkbenchNotificationProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<WorkbenchNotificationItem[]>([]);
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set());
  /** Browser timer handles are numeric; avoids NodeJS.Timeout vs DOM mismatch in `tsc`. */
  const timeoutsRef = useRef(new Map<string, number>());
  const itemsRef = useRef(items);
  useLayoutEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const clearTimer = useCallback((id: string) => {
    const t = timeoutsRef.current.get(id);
    if (t) {
      clearTimeout(t);
      timeoutsRef.current.delete(id);
    }
  }, []);

  const dismiss = useCallback((id: string) => {
    clearTimer(id);
    setItems((prev) => {
      const item = prev.find((i) => i.id === id);
      item?.onDismiss?.();
      return prev.filter((i) => i.id !== id);
    });
    setExitingIds((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  }, [clearTimer]);

  const dismissByKind = useCallback(
    (kind: string) => {
      const ids = itemsRef.current.filter((i) => i.kind === kind).map((i) => i.id);
      ids.forEach((id) => clearTimer(id));
      setItems((prev) => prev.filter((i) => i.kind !== kind));
      setExitingIds((s) => {
        const n = new Set(s);
        ids.forEach((id) => n.delete(id));
        return n;
      });
    },
    [clearTimer]
  );

  const requestDismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      setExitingIds((s) => new Set(s).add(id));
      window.setTimeout(() => {
        dismiss(id);
      }, EXIT_MS);
    },
    [clearTimer, dismiss]
  );

  const pushNotification = useCallback(
    (input: WorkbenchNotificationInput) => {
      const id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `n-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const item: WorkbenchNotificationItem = { ...input, id, createdAt: Date.now() };
      setItems((prev) => [...prev, item]);

      if (!input.persistent) {
        const ms = input.autoDismissMs ?? 10_000;
        const t = window.setTimeout(() => {
          timeoutsRef.current.delete(id);
          requestDismiss(id);
        }, ms) as unknown as number;
        timeoutsRef.current.set(id, t);
      }

      return id;
    },
    [requestDismiss]
  );

  const value = useMemo<WorkbenchNotificationContextValue>(
    () => ({
      notifications: items,
      exitingIds,
      pushNotification,
      dismiss,
      dismissByKind,
      requestDismiss,
    }),
    [dismiss, dismissByKind, exitingIds, items, pushNotification, requestDismiss]
  );

  return (
    <WorkbenchNotificationContext.Provider value={value}>
      {children}
      <WorkbenchToastHost />
    </WorkbenchNotificationContext.Provider>
  );
}

export function useWorkbenchNotifications(): WorkbenchNotificationContextValue {
  const ctx = useContext(WorkbenchNotificationContext);
  if (!ctx) {
    throw new Error("useWorkbenchNotifications must be used within WorkbenchNotificationProvider");
  }
  return ctx;
}
