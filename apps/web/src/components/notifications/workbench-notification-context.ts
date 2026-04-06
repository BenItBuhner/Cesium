"use client";

import { createContext } from "react";
import type {
  WorkbenchNotificationInput,
  WorkbenchNotificationItem,
} from "@/components/notifications/workbench-notification-types";

export type WorkbenchNotificationContextValue = {
  notifications: WorkbenchNotificationItem[];
  exitingIds: ReadonlySet<string>;
  pushNotification: (input: WorkbenchNotificationInput) => string;
  dismiss: (id: string) => void;
  dismissByKind: (kind: string) => void;
  requestDismiss: (id: string) => void;
};

export const WorkbenchNotificationContext =
  createContext<WorkbenchNotificationContextValue | null>(null);
