"use client";

import { useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronRight,
  Check,
  Search,
  Hexagon,
  Sparkles,
  Box,
} from "lucide-react";
import { useClickOutside } from "@/hooks/useClickOutside";
import { usePopover } from "@/hooks/usePopover";
import type { ModelInfo } from "@/lib/types";
import type { AgentBackendId, AgentBackendInfo } from "@/lib/agent-types";
import { AgentBackendIcon } from "./AgentBackendIcon";
import { recordPerfSample } from "@/lib/dev-perf";

const providerIcon: Record<ModelInfo["provider"], typeof Box> = {
  openai: Sparkles,
  anthropic: Hexagon,
  google: Box,
  auto: Box,
  cursor: Sparkles,
  opencode: Box,
  codex: Sparkles,
  claude: Hexagon,
  fixture: Box,
};

const popoverSurface =
  "rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)]";

/** Shared pill row chrome for harness + model rows (new design consistency). */
function pickerOptionRowClass(active: boolean, keyboardHighlight: boolean): string {
  const base =
    "flex w-full gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[4px] text-left transition-colors";
  if (active) {
    return `${base} bg-[var(--accent-bg)]`;
  }
  if (keyboardHighlight) {
    return `${base} bg-[var(--accent-bg)]/60`;
  }
  return `${base} hover:bg-[var(--accent-bg)]/60`;
}

interface ModelDropdownProps {
  model: ModelInfo;
  models: ModelInfo[];
  onModelChange?: (model: ModelInfo) => void;
  popoverPlacement?: "above" | "below";
  disabled?: boolean;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * New-design only: harness row above search; harness list opens in a portaled
   * flyout so it is not clipped. Classic composer omits these.
   */
  backendId?: AgentBackendId;
  backends?: AgentBackendInfo[];
  onBackendChange?: (backendId: AgentBackendId) => void;
}

export function ModelDropdown({
  model,
  models,
  onModelChange,
  popoverPlacement = "above",
  disabled = false,
  isOpen: controlledIsOpen,
  onOpenChange,
  backendId,
  backends,
  onBackendChange,
}: ModelDropdownProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledIsOpen !== undefined;
  const open = isControlled ? controlledIsOpen ?? false : internalOpen;

  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [harnessFlyoutOpen, setHarnessFlyoutOpen] = useState(false);
  const [harnessFlyoutPos, setHarnessFlyoutPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const harnessAnchorRef = useRef<HTMLDivElement>(null);
  const harnessFlyoutRef = useRef<HTMLDivElement>(null);
  const harnessCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (isControlled) {
        onOpenChange?.(nextOpen);
      } else {
        setInternalOpen(nextOpen);
      }
      if (nextOpen) {
        recordPerfSample("chat.model_dropdown.open_visible", performance.now(), {
          backendId: backendId ?? null,
          models: models.length,
        });
        setQuery("");
        setHighlightedIndex(0);
        setHarnessFlyoutOpen(false);
      } else {
        setHarnessFlyoutOpen(false);
        setHarnessFlyoutPos(null);
        if (harnessCloseTimerRef.current) {
          clearTimeout(harnessCloseTimerRef.current);
          harnessCloseTimerRef.current = null;
        }
      }
    },
    [backendId, isControlled, models.length, onOpenChange]
  );

  const openDropdown = useCallback(() => {
    handleOpenChange(true);
  }, [handleOpenChange]);

  const close = useCallback(() => {
    handleOpenChange(false);
  }, [handleOpenChange]);

  const clearHarnessCloseTimer = useCallback(() => {
    if (harnessCloseTimerRef.current) {
      clearTimeout(harnessCloseTimerRef.current);
      harnessCloseTimerRef.current = null;
    }
  }, []);

  const showHarnessFlyoutUi = Boolean(
    backends && backends.length > 1 && onBackendChange
  );

  const activeHarness = useMemo(() => {
    if (!backends || backendId == null) return null;
    return backends.find((b) => b.id === backendId) ?? null;
  }, [backends, backendId]);

  const repositionHarnessFlyout = useCallback(() => {
    const anchor = harnessAnchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const gap = 6;
    const panelWidth = 248;
    const pad = 8;
    let left = rect.right + gap;
    if (left + panelWidth > window.innerWidth - pad) {
      left = Math.max(pad, rect.left - panelWidth - gap);
    }
    if (left < pad) left = pad;
    setHarnessFlyoutPos({ top: rect.top, left });
  }, []);

  const openHarnessFlyoutNow = useCallback(() => {
    clearHarnessCloseTimer();
    repositionHarnessFlyout();
    setHarnessFlyoutOpen(true);
  }, [clearHarnessCloseTimer, repositionHarnessFlyout]);

  const scheduleCloseHarnessFlyout = useCallback(() => {
    clearHarnessCloseTimer();
    harnessCloseTimerRef.current = setTimeout(() => {
      setHarnessFlyoutOpen(false);
      setHarnessFlyoutPos(null);
      harnessCloseTimerRef.current = null;
    }, 240);
  }, [clearHarnessCloseTimer]);

  const toggleHarnessFlyout = useCallback(() => {
    clearHarnessCloseTimer();
    if (harnessFlyoutOpen) {
      setHarnessFlyoutOpen(false);
      setHarnessFlyoutPos(null);
    } else {
      repositionHarnessFlyout();
      setHarnessFlyoutOpen(true);
    }
  }, [
    clearHarnessCloseTimer,
    repositionHarnessFlyout,
    harnessFlyoutOpen,
  ]);

  const { triggerRef, popoverRef, position, ready } = usePopover(open, {
    placement: popoverPlacement,
  });

  useClickOutside(triggerRef, close, open, [popoverRef, harnessFlyoutRef]);

  useEffect(() => {
    if (open && ready && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [open, ready]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [query]);

  const ProviderIcon = providerIcon[model.provider];

  const filtered = useMemo(() => {
    if (!query.trim()) return models;
    const q = query.toLowerCase();
    return models.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.detail?.toLowerCase().includes(q) ||
        m.description?.toLowerCase().includes(q)
    );
  }, [models, query]);

  useEffect(() => {
    setHighlightedIndex((prev) =>
      filtered.length === 0 ? 0 : Math.min(prev, filtered.length - 1)
    );
  }, [filtered.length]);

  const listMaxHeight = Math.max(
    96,
    Math.min(340, position.maxHeight - (showHarnessFlyoutUi ? 92 : 44))
  );

  const isActiveChoice = useCallback(
    (m: ModelInfo) => {
      if (m.id === model.id) return true;
      const mv = m.modelValue ?? m.id;
      const cur = model.modelValue ?? model.id;
      if (mv !== cur) return false;
      const a =
        m.configSelections?.map((s) => `${s.configId}:${s.value}`).sort().join("|") ?? "";
      const b =
        model.configSelections?.map((s) => `${s.configId}:${s.value}`).sort().join("|") ?? "";
      return a === b;
    },
    [model]
  );

  const selectModel = useCallback(
    (m: ModelInfo) => {
      onModelChange?.(m);
      close();
    },
    [onModelChange, close]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightedIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : prev));
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : prev));
          break;
        case "Enter":
          e.preventDefault();
          if (filtered[highlightedIndex]) {
            selectModel(filtered[highlightedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          if (harnessFlyoutOpen) {
            clearHarnessCloseTimer();
            setHarnessFlyoutOpen(false);
            setHarnessFlyoutPos(null);
          } else {
            close();
          }
          break;
      }
    },
    [open, filtered, highlightedIndex, selectModel, close, harnessFlyoutOpen, clearHarnessCloseTimer]
  );

  useLayoutEffect(() => {
    if (!open || !harnessFlyoutOpen) return;
    repositionHarnessFlyout();
    const opts: AddEventListenerOptions = { capture: true };
    window.addEventListener("scroll", repositionHarnessFlyout, opts);
    window.addEventListener("resize", repositionHarnessFlyout);
    return () => {
      window.removeEventListener("scroll", repositionHarnessFlyout, opts);
      window.removeEventListener("resize", repositionHarnessFlyout);
    };
  }, [open, harnessFlyoutOpen, repositionHarnessFlyout, ready]);

  useEffect(() => {
    if (listRef.current && open) {
      const highlightedEl = listRef.current.querySelector(`[data-index="${highlightedIndex}"]`);
      if (highlightedEl) {
        highlightedEl.scrollIntoView({ block: "nearest" });
      }
    }
  }, [highlightedIndex, open]);

  return (
    <>
      <div ref={triggerRef} className="inline-flex max-w-full min-w-0 align-middle">
        <button
          type="button"
          disabled={disabled}
          onClick={() => (open ? close() : openDropdown())}
          className="inline-flex max-w-full min-w-0 items-center gap-[4px] overflow-hidden text-left transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ProviderIcon
            className="size-[14px] shrink-0 text-[var(--text-secondary)]"
            strokeWidth={1.5}
          />
          <span
            className="min-w-0 max-w-[min(280px,45vw)] truncate font-sans text-[13px] font-normal text-[var(--text-secondary)]"
            title={model.name}
          >
            {model.name}
          </span>
          <ChevronDown className="size-[8px] shrink-0 text-[var(--text-secondary)]" strokeWidth={2.5} />
        </button>
      </div>

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className={`fixed z-[9999] flex min-w-[260px] w-[min(320px,calc(100vw-24px))] max-w-[min(320px,calc(100vw-24px))] flex-col text-left ${popoverSurface} transition-opacity`}
            data-ide-input-sink
            data-ide-composer-floating-popover
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            style={{
              ...(position.top != null
                ? { top: position.top }
                : { bottom: position.bottom ?? 0 }),
              left: position.left,
              opacity: ready ? 1 : 0,
              maxHeight: position.maxHeight,
              overflow: "hidden",
            }}
            onKeyDown={handleKeyDown}
          >
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
              {showHarnessFlyoutUi && backendId != null ? (
                <div
                  ref={harnessAnchorRef}
                  className="flex min-w-0 shrink-0 items-center gap-[8px] border-b border-[var(--border-card)] px-[10px] py-[7px]"
                  onMouseEnter={openHarnessFlyoutNow}
                  onMouseLeave={scheduleCloseHarnessFlyout}
                >
                  <AgentBackendIcon
                    backendId={backendId}
                    className="size-[14px] shrink-0"
                  />
                  <span
                    className="min-w-0 flex-1 truncate font-sans text-[12.5px] font-normal text-[var(--text-primary)]"
                    title={activeHarness?.label ?? backendId}
                  >
                    {activeHarness?.label ?? backendId}
                  </span>
                  <button
                    type="button"
                    aria-label="Choose harness"
                    aria-expanded={harnessFlyoutOpen}
                    aria-haspopup="menu"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleHarnessFlyout();
                    }}
                    className="flex size-[28px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)]/60"
                  >
                    <ChevronRight className="size-[14px] shrink-0" strokeWidth={2.25} />
                  </button>
                </div>
              ) : null}
              <div className="flex min-w-0 shrink-0 items-center gap-[6px] border-b border-[var(--border-card)] px-[10px] py-[6px]">
                <Search className="size-[13px] shrink-0 text-[var(--text-disabled)]" strokeWidth={1.5} />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search models"
                  className="min-w-0 flex-1 bg-transparent font-sans text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
                  aria-label="Search models"
                />
              </div>
              <div
                ref={listRef}
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[4px] py-[4px]"
                style={{ maxHeight: listMaxHeight, overscrollBehaviorY: "contain" }}
                onWheel={(e) => {
                  const el = e.currentTarget;
                  const atTop = el.scrollTop <= 0;
                  const atBottom =
                    el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
                  if ((atTop && e.deltaY < 0) || (atBottom && e.deltaY > 0)) {
                    e.preventDefault();
                  }
                }}
              >
                {filtered.length === 0 && (
                  <p className="px-[8px] py-[6px] font-sans text-[13px] text-[var(--text-disabled)]">
                    No models found
                  </p>
                )}
                {filtered.map((m, index) => {
                  const Icon = providerIcon[m.provider];
                  const active = isActiveChoice(m);
                  const detail = m.detail ?? m.description;
                  const kbdHi = index === highlightedIndex && !active;
                  return (
                    <button
                      key={m.id}
                      data-index={index}
                      type="button"
                      title={detail}
                      onClick={() => selectModel(m)}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      className={`items-start ${pickerOptionRowClass(active, kbdHi)} w-full`}
                      aria-selected={index === highlightedIndex}
                    >
                      <Icon
                        className="mt-[2px] size-[14px] shrink-0 text-[var(--text-secondary)]"
                        strokeWidth={1.5}
                      />
                      <span
                        className="min-w-0 flex-1 break-words font-sans text-[13px] font-normal leading-snug"
                        style={{
                          color: active ? "var(--text-primary)" : "var(--text-secondary)",
                        }}
                      >
                        {m.name}
                      </span>
                      {active ? (
                        <Check
                          className="mt-[2px] size-[14px] shrink-0 text-[var(--text-primary)]"
                          strokeWidth={2}
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>,
          document.body
        )}

      {open &&
        harnessFlyoutOpen &&
        showHarnessFlyoutUi &&
        harnessFlyoutPos &&
        createPortal(
          <div
            ref={harnessFlyoutRef}
            role="menu"
            aria-label="Harnesses"
            data-ide-input-sink
            className={`fixed z-[10001] flex w-[min(248px,calc(100vw-16px))] min-w-[200px] flex-col py-[4px] ${popoverSurface} shadow-lg`}
            style={{
              top: harnessFlyoutPos.top,
              left: harnessFlyoutPos.left,
              maxHeight: "min(320px, calc(100vh - 24px))",
            }}
            onMouseEnter={openHarnessFlyoutNow}
            onMouseLeave={scheduleCloseHarnessFlyout}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <span className="px-[10px] pb-[3px] pt-[2px] font-sans text-[11px] font-medium text-[var(--text-disabled)]">
              Harnesses
            </span>
            <div className="max-h-[min(268px,calc(100vh-80px))] overflow-y-auto overscroll-contain px-[4px]">
              {(backends ?? []).map((backend) => {
                const harnessActive = backend.id === backendId;
                const available = backend.available !== false;
                return (
                  <button
                    key={backend.id}
                    role="menuitem"
                    type="button"
                    disabled={!available}
                    onClick={() => {
                      recordPerfSample(
                        "chat.model_dropdown.backend_select_visible",
                        performance.now(),
                        { backendId: backend.id }
                      );
                      onBackendChange?.(backend.id);
                    }}
                    className={`items-center ${pickerOptionRowClass(harnessActive, false)} disabled:cursor-not-allowed disabled:opacity-50`}
                    aria-pressed={harnessActive}
                  >
                    <AgentBackendIcon
                      backendId={backend.id}
                      className="size-[13px] shrink-0"
                    />
                    <span
                      className="min-w-0 flex-1 truncate font-sans text-[12.5px] font-normal"
                      style={{
                        color: harnessActive
                          ? "var(--text-primary)"
                          : "var(--text-secondary)",
                      }}
                    >
                      {backend.label}
                    </span>
                    {harnessActive ? (
                      <Check
                        className="size-[13px] shrink-0 text-[var(--text-primary)]"
                        strokeWidth={2}
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}