"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Quote } from "lucide-react";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";

function selectionPlainPreview(range: Range): string {
  const frag = range.cloneContents();
  const probe = document.createElement("div");
  probe.appendChild(frag);
  return (probe.textContent ?? "").replace(/\s+/g, " ").trim();
}

function rangeToHtmlFragment(range: Range): string {
  const wrapper = document.createElement("div");
  wrapper.appendChild(range.cloneContents());
  return wrapper.innerHTML;
}

export function MessageTextSelectionCite({
  composerDraftId,
  children,
  className,
}: {
  composerDraftId?: string | null;
  children: ReactNode;
  className?: string;
}) {
  const { applyMessageCitationToDraft } = useOpenInEditor();
  const rootRef = useRef<HTMLDivElement>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const [toolbar, setToolbar] = useState<{ top: number; left: number } | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const dismiss = useCallback(() => {
    savedRangeRef.current = null;
    setToolbar(null);
  }, []);

  const syncToolbar = useCallback(() => {
    if (!composerDraftId) {
      dismiss();
      return;
    }
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      dismiss();
      return;
    }
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) {
      dismiss();
      return;
    }
    const preview = selectionPlainPreview(range);
    if (!preview) {
      dismiss();
      return;
    }
    savedRangeRef.current = range.cloneRange();
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      dismiss();
      return;
    }
    setToolbar({
      top: rect.top,
      left: rect.left + rect.width / 2,
    });
  }, [composerDraftId, dismiss]);

  useEffect(() => {
    if (!composerDraftId) {
      return;
    }
    const onSel = () => {
      requestAnimationFrame(syncToolbar);
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, [composerDraftId, syncToolbar]);

  useEffect(() => {
    const onScroll = () => dismiss();
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, [dismiss]);

  const onCite = useCallback(() => {
    if (!composerDraftId) {
      return;
    }
    const range = savedRangeRef.current;
    if (!range) {
      return;
    }
    const plain = selectionPlainPreview(range);
    if (!plain) {
      dismiss();
      return;
    }
    const label = plain.length > 90 ? `${plain.slice(0, 87)}…` : plain;
    const htmlFragment = rangeToHtmlFragment(range);
    applyMessageCitationToDraft(composerDraftId, { label, htmlFragment });
    dismiss();
    document.getSelection()?.removeAllRanges();
  }, [applyMessageCitationToDraft, composerDraftId, dismiss]);

  if (!composerDraftId) {
    return <>{children}</>;
  }

  return (
    <>
      <div
        ref={rootRef}
        className={className}
        onMouseUp={() => requestAnimationFrame(syncToolbar)}
      >
        {children}
      </div>
      {mounted && toolbar
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[10050] flex flex-col items-center"
              style={{
                top: toolbar.top,
                left: toolbar.left,
                transform: "translate(-50%, calc(-100% - 6px))",
              }}
            >
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  onCite();
                }}
                className="pointer-events-auto flex items-center gap-[6px] rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-card)] px-[10px] py-[5px] font-sans text-[12.5px] font-medium text-[var(--text-primary)] shadow-md transition-colors hover:bg-[var(--bg-card-hover)]"
                aria-label="Cite selection in composer"
              >
                <Quote className="size-[13px] shrink-0" strokeWidth={1.75} aria-hidden />
                Cite
              </button>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
