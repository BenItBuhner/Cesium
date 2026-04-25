"use client";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  Check,
  Search,
  Hexagon,
  Sparkles,
  Box,
} from "lucide-react";
import { useClickOutside } from "@/hooks/useClickOutside";
import { usePopover } from "@/hooks/usePopover";
import type { ModelInfo } from "@/lib/types";

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

interface ModelDropdownProps {
  model: ModelInfo;
  models: ModelInfo[];
  onModelChange?: (model: ModelInfo) => void;
  popoverPlacement?: "above" | "below";
  disabled?: boolean;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ModelDropdown({
  model,
  models,
  onModelChange,
  popoverPlacement = "above",
  disabled = false,
  isOpen: controlledIsOpen,
  onOpenChange,
}: ModelDropdownProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledIsOpen !== undefined;
  const open = isControlled ? controlledIsOpen ?? false : internalOpen;

  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (isControlled) {
        onOpenChange?.(nextOpen);
      } else {
        setInternalOpen(nextOpen);
      }
      if (nextOpen) {
        setQuery("");
        setHighlightedIndex(0);
      }
    },
    [isControlled, onOpenChange]
  );

  const openDropdown = useCallback(() => {
    handleOpenChange(true);
  }, [handleOpenChange]);

  const close = useCallback(() => {
    handleOpenChange(false);
  }, [handleOpenChange]);

  const { triggerRef, popoverRef, position, ready } = usePopover(open, {
    placement: popoverPlacement,
  });

  useClickOutside(triggerRef, close, open, [popoverRef]);

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

  const listMaxHeight = Math.max(96, Math.min(340, position.maxHeight - 44));

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
          close();
          break;
      }
    },
    [open, filtered, highlightedIndex, selectModel, close]
  );

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
            <div className="flex shrink-0 items-center gap-[6px] border-b border-[var(--border-card)] px-[10px] py-[6px]">
              <Search className="size-[13px] shrink-0 text-[var(--text-disabled)]" strokeWidth={1.5} />
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models"
                className="flex-1 bg-transparent font-sans text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
                aria-label="Search models"
              />
            </div>
            <div
              ref={listRef}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-[2px]"
              style={{ maxHeight: listMaxHeight, overscrollBehaviorY: "contain" }}
              onWheel={(e) => {
                const el = e.currentTarget;
                const atTop = el.scrollTop <= 0;
                const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
                if ((atTop && e.deltaY < 0) || (atBottom && e.deltaY > 0)) {
                  e.preventDefault();
                }
              }}
            >
              {filtered.length === 0 && (
                <p className="px-[10px] py-[8px] font-sans text-[13px] text-[var(--text-disabled)]">
                  No models found
                </p>
              )}
              {filtered.map((m, index) => {
                const Icon = providerIcon[m.provider];
                const active = isActiveChoice(m);
                const detail = m.detail ?? m.description;
                return (
                  <button
                    key={m.id}
                    data-index={index}
                    type="button"
                    title={detail}
                    onClick={() => selectModel(m)}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    className={`flex w-full items-start gap-[8px] px-[10px] py-[5px] text-left transition-colors ${
                      index === highlightedIndex
                        ? "bg-[var(--accent-bg)] ring-1 ring-[var(--accent)]/35"
                        : "hover:bg-[var(--accent-bg)]/60"
                    }`}
                    aria-selected={index === highlightedIndex}
                  >
                    <Icon
                      className="mt-[2px] size-[14px] shrink-0 text-[var(--text-secondary)]"
                      strokeWidth={1.5}
                    />
                    <span
                      className="min-w-0 flex-1 break-words font-sans text-[13px] font-normal leading-snug"
                      style={{ color: active ? "var(--text-primary)" : "var(--text-secondary)" }}
                    >
                      {m.name}
                    </span>
                    {active && (
                      <Check className="mt-[2px] size-[14px] shrink-0 text-[var(--text-primary)]" strokeWidth={2} />
                    )}
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