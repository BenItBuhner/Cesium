"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, HelpCircle, Info, PencilLine } from "lucide-react";
import {
  dialogBackdropClass,
  dialogDangerButtonClass,
  dialogDetailClass,
  dialogFooterClass,
  dialogInputClass,
  dialogInputErrorClass,
  dialogLayerClass,
  dialogMessageClass,
  dialogPanelClass,
  dialogPrimaryButtonClass,
  dialogSecondaryButtonClass,
  dialogTitleClass,
} from "@/components/dialogs/workbench-dialog-ui";
import { BACK_INTENT_PRIORITY, useBackHandler } from "@/components/mobile/BackIntentContext";
import {
  normalizePromptValue,
  validatePromptValue,
  type WorkbenchDialogRequest,
  type WorkbenchDialogResult,
  type WorkbenchDialogTone,
} from "@/lib/workbench-dialog-queue";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function ToneIcon({
  kind,
  tone,
}: {
  kind: WorkbenchDialogRequest["kind"];
  tone: WorkbenchDialogTone;
}) {
  const danger = tone === "danger";
  const color = danger ? "var(--status-error)" : "var(--text-secondary)";
  const Icon = danger
    ? AlertTriangle
    : kind === "confirm"
      ? HelpCircle
      : kind === "prompt"
        ? PencilLine
        : Info;
  return (
    <div
      aria-hidden
      className="mt-[1px] flex size-[28px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] border"
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 28%, var(--border-card))`,
        backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
      }}
    >
      <Icon className="size-[15px]" strokeWidth={1.8} />
    </div>
  );
}

type WorkbenchDialogProps = {
  request: WorkbenchDialogRequest;
  onSettle: (id: string, result: WorkbenchDialogResult) => void;
};

/**
 * Renders one queued dialog request as a modal. Handles focus capture and
 * restore, Tab trapping, Escape / backdrop / Android-back cancellation, and
 * Enter-to-submit for prompts. Remount (`key={request.id}`) per request.
 */
export function WorkbenchDialog({ request, onSettle }: WorkbenchDialogProps) {
  const { id, kind, options } = request;
  const tone = options.tone ?? "default";
  const titleId = useId();
  const messageId = useId();
  const errorId = useId();
  const panelRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const [entered, setEntered] = useState(false);
  const [value, setValue] = useState(
    request.kind === "prompt" ? (request.options.defaultValue ?? "") : ""
  );
  const [error, setError] = useState<string | null>(null);
  const selectOnOpen = request.kind === "prompt" ? request.options.selectOnOpen !== false : false;

  const cancel = useCallback(() => {
    switch (kind) {
      case "confirm":
        onSettle(id, { kind: "confirm", value: false });
        return;
      case "alert":
        onSettle(id, { kind: "alert" });
        return;
      case "prompt":
        onSettle(id, { kind: "prompt", value: null });
        return;
    }
  }, [id, kind, onSettle]);

  const submit = useCallback(() => {
    switch (request.kind) {
      case "confirm":
        onSettle(request.id, { kind: "confirm", value: true });
        return;
      case "alert":
        onSettle(request.id, { kind: "alert" });
        return;
      case "prompt": {
        const problem = validatePromptValue(request.options, value);
        if (problem) {
          setError(problem);
          inputRef.current?.focus();
          return;
        }
        onSettle(request.id, { kind: "prompt", value: normalizePromptValue(value) });
        return;
      }
    }
  }, [onSettle, request, value]);

  useBackHandler(true, BACK_INTENT_PRIORITY.overlay, () => {
    cancel();
    return true;
  });

  // Capture focus on open, restore it on close.
  useLayoutEffect(() => {
    const previous =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const frame = requestAnimationFrame(() => {
      setEntered(true);
      if (kind === "prompt" && inputRef.current) {
        inputRef.current.focus();
        if (selectOnOpen) {
          inputRef.current.select();
        }
        return;
      }
      initialFocusRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      if (previous && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [kind, selectOnOpen]);

  // Escape cancels; Tab cycles inside the panel. Registered in the capture
  // phase so workbench-wide shortcut layers never see keys meant for the modal.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const panel = panelRef.current;
      if (!panel) {
        return;
      }
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const current = document.activeElement;
      if (!panel.contains(current)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cancel]);

  if (typeof document === "undefined") {
    return null;
  }

  let confirmLabel: string;
  let cancelLabel: string | null;
  switch (request.kind) {
    case "confirm":
      confirmLabel = request.options.confirmLabel ?? "Confirm";
      cancelLabel = request.options.cancelLabel ?? "Cancel";
      break;
    case "alert":
      confirmLabel = request.options.dismissLabel ?? "OK";
      cancelLabel = null;
      break;
    case "prompt":
      confirmLabel = request.options.confirmLabel ?? "OK";
      cancelLabel = request.options.cancelLabel ?? "Cancel";
      break;
  }
  const primaryClass = tone === "danger" ? dialogDangerButtonClass : dialogPrimaryButtonClass;
  // Destructive confirms start on the safe button so a stray Enter cannot delete.
  const focusPrimaryFirst = !(kind === "confirm" && tone === "danger");
  const hasMessage = options.message != null && options.message !== "";

  let promptField: ReactNode = null;
  if (request.kind === "prompt") {
    const promptOptions = request.options;
    promptField = (
      <>
        <label htmlFor={`${titleId}-input`} className="sr-only">
          {promptOptions.inputLabel ?? promptOptions.title}
        </label>
        <input
          ref={inputRef}
          id={`${titleId}-input`}
          type="text"
          value={value}
          placeholder={promptOptions.placeholder}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : hasMessage ? messageId : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) {
              setError(null);
            }
          }}
          className={`${dialogInputClass} ${promptOptions.monospace ? "font-mono" : "font-sans"}`}
        />
        {error ? (
          <p id={errorId} role="alert" className={dialogInputErrorClass}>
            {error}
          </p>
        ) : null}
      </>
    );
  }

  const onFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };

  const primaryButton = (
    <button
      ref={focusPrimaryFirst ? initialFocusRef : undefined}
      type="submit"
      className={primaryClass}
      data-dialog-action="confirm"
    >
      {confirmLabel}
    </button>
  );
  const cancelButton =
    cancelLabel !== null ? (
      <button
        ref={focusPrimaryFirst ? undefined : initialFocusRef}
        type="button"
        onClick={cancel}
        className={dialogSecondaryButtonClass}
        data-dialog-action="cancel"
      >
        {cancelLabel}
      </button>
    ) : null;

  return createPortal(
    <div
      className={`${dialogLayerClass} flex items-end justify-center p-[10px] sm:items-center sm:p-[16px]`}
      role="presentation"
      data-workbench-dialog={kind}
      data-ide-palette
    >
      <div
        className={`${dialogBackdropClass} transition-opacity duration-150 ${entered ? "opacity-100" : "opacity-0"}`}
        aria-hidden
        onPointerDown={(event) => {
          event.preventDefault();
          cancel();
        }}
      />
      <form
        ref={panelRef}
        role={kind === "prompt" ? "dialog" : "alertdialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hasMessage ? messageId : undefined}
        onSubmit={onFormSubmit}
        noValidate
        className={`${dialogPanelClass} w-full max-w-[440px] transition-[transform,opacity] duration-150 ease-out will-change-transform ${
          entered ? "translate-y-0 scale-100 opacity-100" : "translate-y-2 scale-[0.98] opacity-0"
        }`}
      >
        <div className="flex items-start gap-[12px] px-[16px] pb-[14px] pt-[16px]">
          <ToneIcon kind={kind} tone={tone} />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className={dialogTitleClass}>
              {options.title}
            </h2>
            {hasMessage ? (
              <p id={messageId} className={dialogMessageClass}>
                {options.message}
              </p>
            ) : null}
            {options.detail ? <code className={dialogDetailClass}>{options.detail}</code> : null}
            {promptField}
          </div>
        </div>
        <div className={dialogFooterClass}>
          {cancelButton}
          {primaryButton}
        </div>
      </form>
    </div>,
    document.body
  );
}
