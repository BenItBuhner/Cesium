"use client";

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  WorkbenchDialogContext,
  type WorkbenchDialogContextValue,
  type WorkbenchDialogs,
} from "@/components/dialogs/workbench-dialog-context";
import { WorkbenchDialogHost } from "@/components/dialogs/WorkbenchDialogHost";
import {
  activeDialogRequest,
  cancelAllDialogRequests,
  enqueueDialogRequest,
  removeDialogRequest,
  resolveDialogRequest,
  type WorkbenchAlertOptions,
  type WorkbenchConfirmOptions,
  type WorkbenchDialogRequest,
  type WorkbenchDialogResult,
  type WorkbenchPromptOptions,
} from "@/lib/workbench-dialog-queue";

function newDialogId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `d-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Owns the modal dialog queue and renders the host. Mount once, high in the
 * tree; consumers call `useWorkbenchDialogs()`.
 *
 * The queue ref is the source of truth (so a double settle is a no-op and
 * unmount can cancel everything synchronously); state only triggers renders.
 */
export function WorkbenchDialogProvider({
  children,
  renderHost = true,
}: {
  children: ReactNode;
  /** Set false when a parent renders `WorkbenchDialogHost` itself. */
  renderHost?: boolean;
}) {
  const queueRef = useRef<WorkbenchDialogRequest[]>([]);
  const [queue, setQueue] = useState<WorkbenchDialogRequest[]>([]);

  useEffect(
    () => () => {
      queueRef.current = cancelAllDialogRequests(queueRef.current);
    },
    []
  );

  const enqueue = useCallback((request: WorkbenchDialogRequest) => {
    queueRef.current = enqueueDialogRequest(queueRef.current, request);
    setQueue(queueRef.current);
  }, []);

  const settle = useCallback((id: string, result: WorkbenchDialogResult) => {
    const request = queueRef.current.find((entry) => entry.id === id);
    if (!request) {
      return;
    }
    queueRef.current = removeDialogRequest(queueRef.current, id);
    setQueue(queueRef.current);
    resolveDialogRequest(request, result);
  }, []);

  const confirm = useCallback<WorkbenchDialogs["confirm"]>(
    (options: WorkbenchConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        enqueue({ id: newDialogId(), kind: "confirm", options, resolve });
      }),
    [enqueue]
  );

  const alert = useCallback<WorkbenchDialogs["alert"]>(
    (options: WorkbenchAlertOptions) =>
      new Promise<void>((resolve) => {
        enqueue({ id: newDialogId(), kind: "alert", options, resolve });
      }),
    [enqueue]
  );

  const prompt = useCallback<WorkbenchDialogs["prompt"]>(
    (options: WorkbenchPromptOptions) =>
      new Promise<string | null>((resolve) => {
        enqueue({ id: newDialogId(), kind: "prompt", options, resolve });
      }),
    [enqueue]
  );

  const dialogs = useMemo<WorkbenchDialogs>(
    () => ({ confirm, alert, prompt }),
    [alert, confirm, prompt]
  );

  const value = useMemo<WorkbenchDialogContextValue>(
    () => ({
      dialogs,
      active: activeDialogRequest(queue),
      pendingCount: Math.max(0, queue.length - 1),
      settle,
    }),
    [dialogs, queue, settle]
  );

  return (
    <WorkbenchDialogContext.Provider value={value}>
      {children}
      {renderHost ? <WorkbenchDialogHost /> : null}
    </WorkbenchDialogContext.Provider>
  );
}

/**
 * Promise-based in-app replacements for `window.confirm` / `alert` / `prompt`.
 *
 * ```ts
 * const dialogs = useWorkbenchDialogs();
 * if (!(await dialogs.confirm({ title: "Delete folder?", tone: "danger", confirmLabel: "Delete" }))) return;
 * ```
 */
export function useWorkbenchDialogs(): WorkbenchDialogs {
  const ctx = useContext(WorkbenchDialogContext);
  if (!ctx) {
    throw new Error("useWorkbenchDialogs must be used within WorkbenchDialogProvider");
  }
  return ctx.dialogs;
}
