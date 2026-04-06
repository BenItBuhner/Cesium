"use client";

import { useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  Check,
  Search,
  Hexagon,
  Sparkles,
  Box,
} from "lucide-react";
import { HardwareAwareTextInput } from "@/components/input/HardwareAwareTextField";
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
}

export function ModelDropdown({
  model,
  models,
  onModelChange,
  popoverPlacement = "above",
  disabled = false,
}: ModelDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const close = useCallback(() => { setOpen(false); setQuery(""); }, []);
  const { triggerRef, popoverRef, position, ready } = usePopover(open, {
    placement: popoverPlacement,
  });

  useClickOutside(triggerRef, close, open, [popoverRef]);

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

  const listMaxHeight = Math.max(96, Math.min(220, position.maxHeight - 44));

  const isActiveChoice = useCallback((m: ModelInfo) => {
    if (m.id === model.id) return true;
    const mv = m.modelValue ?? m.id;
    const cur = model.modelValue ?? model.id;
    if (mv !== cur) return false;
    const a = m.configSelections?.map((s) => `${s.configId}:${s.value}`).sort().join("|") ?? "";
    const b = model.configSelections?.map((s) => `${s.configId}:${s.value}`).sort().join("|") ?? "";
    return a === b;
  }, [model]);

  return (
    <div ref={triggerRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-[4px] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ProviderIcon className="size-[14px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.5} />
        <span className="font-sans text-[13px] font-normal text-[var(--text-secondary)]">
          {model.name}
        </span>
        <ChevronDown className="size-[8px] shrink-0 text-[var(--text-secondary)]" strokeWidth={2.5} />
      </button>

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className={`fixed z-[9999] flex w-[260px] flex-col ${popoverSurface} transition-opacity`}
            data-ide-input-sink
            style={{
              ...(position.top != null
                ? { top: position.top }
                : { bottom: position.bottom ?? 0 }),
              left: position.left,
              opacity: ready ? 1 : 0,
              maxHeight: position.maxHeight,
              overflow: "hidden",
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div
              className={`flex shrink-0 items-center gap-[6px] border-b border-[var(--border-card)] px-[10px] py-[6px]`}
            >
              <Search className="size-[13px] shrink-0 text-[var(--text-disabled)]" strokeWidth={1.5} />
              <HardwareAwareTextInput
                type="text"
                value={query}
                onChange={setQuery}
                placeholder="Search models"
                className="flex-1 bg-transparent font-sans text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
                ariaLabel="Search models"
                autoFocus
              />
            </div>
            <div
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-[2px]"
              style={{ maxHeight: listMaxHeight }}
              onWheel={(e) => e.stopPropagation()}
            >
              {filtered.length === 0 && (
                <p className="px-[12px] py-[8px] font-sans text-[13px] text-[var(--text-disabled)]">
                  No models found
                </p>
              )}
              {filtered.map((m) => {
                const Icon = providerIcon[m.provider];
                const active = isActiveChoice(m);
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      onModelChange?.(m);
                      setOpen(false);
                      setQuery("");
                    }}
                    className="flex w-full items-center gap-[8px] px-[12px] py-[5px] text-left transition-colors hover:bg-white/[0.06]"
                  >
                    <Icon
                      className="size-[14px] shrink-0 text-[var(--text-secondary)]"
                      strokeWidth={1.5}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate font-sans text-[13px] font-normal"
                        style={{ color: active ? "var(--text-primary)" : "var(--text-secondary)" }}
                      >
                        {m.name}
                      </span>
                      {(m.detail || m.description) && (
                        <span className="block truncate font-sans text-[11px] text-[var(--text-disabled)]">
                          {m.detail ?? m.description}
                        </span>
                      )}
                    </span>
                    {active && (
                      <Check className="size-[14px] shrink-0 text-[var(--text-primary)]" strokeWidth={2} />
                    )}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
