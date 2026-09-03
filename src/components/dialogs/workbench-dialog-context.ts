"use client";

import { createContext } from "react";
import type {
  WorkbenchAlertOptions,
  WorkbenchConfirmOptions,
  WorkbenchDialogRequest,
  WorkbenchDialogResult,
  WorkbenchPromptOptions,
} from "@/lib/workbench-dialog-queue";

export type WorkbenchDialogs = {
  /** Resolves `true` when the user confirms, `false` on cancel/dismiss. */
  confirm: (options: WorkbenchConfirmOptions) => Promise<boolean>;
  /** Resolves once the user acknowledges the notice. */
  alert: (options: WorkbenchAlertOptions) => Promise<void>;
  /** Resolves the trimmed input, or `null` on cancel/dismiss. */
  prompt: (options: WorkbenchPromptOptions) => Promise<string | null>;
};

export type WorkbenchDialogContextValue = {
  /** Stable for the provider's lifetime - safe to put in hook dependency arrays. */
  dialogs: WorkbenchDialogs;
  /** The request currently on screen, if any. */
  active: WorkbenchDialogRequest | null;
  /** Number of requests waiting behind the active one. */
  pendingCount: number;
  /** Resolve a request by id (used by the host). */
  settle: (id: string, result: WorkbenchDialogResult) => void;
};

export const WorkbenchDialogContext = createContext<WorkbenchDialogContextValue | null>(null);
