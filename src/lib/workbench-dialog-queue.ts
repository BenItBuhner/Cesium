/**
 * Pure state logic for the workbench dialog queue (the in-app replacement for
 * `window.confirm` / `window.alert` / `window.prompt`). Kept framework-free so
 * it can be unit tested without React or a DOM. The provider, hook and host
 * live in `@/components/dialogs`.
 *
 * Dialogs are strictly serialized: one request is visible at a time and the
 * rest wait FIFO. Every request carries a `resolve` that must be called exactly
 * once, which is why settlement helpers here always remove the request from the
 * queue before resolving it.
 */

import type { ReactNode } from "react";

export type WorkbenchDialogTone = "default" | "danger";

type WorkbenchDialogBaseOptions = {
  /** Short heading - a question or statement, not a paragraph. */
  title: string;
  /** Supporting copy; keep to one or two sentences. */
  message?: ReactNode;
  /** Optional literal (path, branch, name) rendered in monospace under the message. */
  detail?: string;
  tone?: WorkbenchDialogTone;
};

export type WorkbenchConfirmOptions = WorkbenchDialogBaseOptions & {
  /** Defaults to "Confirm". */
  confirmLabel?: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
};

export type WorkbenchAlertOptions = WorkbenchDialogBaseOptions & {
  /** Defaults to "OK". */
  dismissLabel?: string;
};

export type WorkbenchPromptOptions = WorkbenchDialogBaseOptions & {
  defaultValue?: string;
  placeholder?: string;
  /** Accessible label for the input. Defaults to the title. */
  inputLabel?: string;
  /** Defaults to "OK". */
  confirmLabel?: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
  /** Return a human-readable error to block submission, or `null` to accept. */
  validate?: (value: string) => string | null;
  /** Render the input in the monospace font (paths, hex colors, branch names). */
  monospace?: boolean;
  /** Allow submitting a blank value. Default: blank input is rejected. */
  allowEmpty?: boolean;
  /** Select the default value when the dialog opens. Default: true. */
  selectOnOpen?: boolean;
};

export type WorkbenchDialogRequest =
  | {
      id: string;
      kind: "confirm";
      options: WorkbenchConfirmOptions;
      resolve: (value: boolean) => void;
    }
  | {
      id: string;
      kind: "alert";
      options: WorkbenchAlertOptions;
      resolve: () => void;
    }
  | {
      id: string;
      kind: "prompt";
      options: WorkbenchPromptOptions;
      resolve: (value: string | null) => void;
    };

export type WorkbenchDialogKind = WorkbenchDialogRequest["kind"];

export type WorkbenchDialogResult =
  | { kind: "confirm"; value: boolean }
  | { kind: "alert" }
  | { kind: "prompt"; value: string | null };

export function enqueueDialogRequest(
  queue: readonly WorkbenchDialogRequest[],
  request: WorkbenchDialogRequest
): WorkbenchDialogRequest[] {
  return [...queue, request];
}

export function removeDialogRequest(
  queue: readonly WorkbenchDialogRequest[],
  id: string
): WorkbenchDialogRequest[] {
  return queue.filter((request) => request.id !== id);
}

/** The request currently on screen: always the oldest pending one. */
export function activeDialogRequest(
  queue: readonly WorkbenchDialogRequest[]
): WorkbenchDialogRequest | null {
  return queue[0] ?? null;
}

/**
 * Resolve a request with the value a user dismissal produces (Escape, backdrop
 * click, Android back, Cancel button, or provider unmount).
 */
export function cancelDialogRequest(request: WorkbenchDialogRequest): void {
  switch (request.kind) {
    case "confirm":
      request.resolve(false);
      return;
    case "alert":
      request.resolve();
      return;
    case "prompt":
      request.resolve(null);
      return;
  }
}

/**
 * Resolve a request with an explicit result. A result whose kind does not match
 * the request is treated as a cancel so no promise is ever left dangling.
 */
export function resolveDialogRequest(
  request: WorkbenchDialogRequest,
  result: WorkbenchDialogResult
): void {
  if (request.kind === "confirm" && result.kind === "confirm") {
    request.resolve(result.value);
    return;
  }
  if (request.kind === "alert" && result.kind === "alert") {
    request.resolve();
    return;
  }
  if (request.kind === "prompt" && result.kind === "prompt") {
    request.resolve(result.value);
    return;
  }
  cancelDialogRequest(request);
}

/** Cancel every pending request (provider teardown). Returns the empty queue. */
export function cancelAllDialogRequests(
  queue: readonly WorkbenchDialogRequest[]
): WorkbenchDialogRequest[] {
  for (const request of queue) {
    cancelDialogRequest(request);
  }
  return [];
}

/** Normalize prompt input before validation/resolution. */
export function normalizePromptValue(value: string): string {
  return value.trim();
}

/**
 * Validate a prompt submission. Returns an error message to show, or `null`
 * when the (normalized) value may be submitted.
 */
export function validatePromptValue(
  options: Pick<WorkbenchPromptOptions, "allowEmpty" | "validate">,
  rawValue: string
): string | null {
  const value = normalizePromptValue(rawValue);
  if (!value && !options.allowEmpty) {
    return "Enter a value to continue.";
  }
  return options.validate?.(value) ?? null;
}
