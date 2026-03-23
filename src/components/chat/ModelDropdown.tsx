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
import { useClickOutside } from "@/hooks/useClickOutside";
import { usePopover } from "@/hooks/usePopover";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import type { ModelInfo } from "@/lib/types";

const providerIcon: Record<ModelInfo["provider"], typeof Box> = {
  openai: Sparkles,
  anthropic: Hexagon,
  google: Box,
  auto: Box,
};

const popoverSurface =
  "rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)]";

interface ModelDropdownProps {
  model: ModelInfo;
  models: ModelInfo[];
  onModelChange?: (model: ModelInfo) => void;
  popoverPlacement?: "above" | "below";
}

export function ModelDropdown({
  model,
  models,
  onModelChange,
  popoverPlacement = "above",
}: ModelDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [maxMode, setMaxMode] = useState(true);

  const close = useCallback(() => { setOpen(false); setQuery(""); }, []);
  const { triggerRef, popoverRef, position, ready } = usePopover(open, {
    placement: popoverPlacement,
  });

  useClickOutside(triggerRef, close, open, [popoverRef]);

  const ProviderIcon = providerIcon[model.provider];

  const filtered = useMemo(() => {
    if (!query.trim()) return models;
    const q = query.toLowerCase();
    return models.filter((m) => m.name.toLowerCase().includes(q));
  }, [models, query]);

  return (
    <div ref={triggerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-[4px] transition-opacity hover:opacity-80"
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
            className={`fixed z-[9999] w-[260px] ${popoverSurface} transition-opacity`}
            style={{
              ...(position.top != null
                ? { top: position.top }
                : { bottom: position.bottom ?? 0 }),
              left: position.left,
              opacity: ready ? 1 : 0,
              maxHeight: position.maxHeight,
              overflow: "auto",
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className={`flex items-center gap-[6px] border-b border-[var(--border-card)] px-[10px] py-[6px]`}>
              <Search className="size-[13px] shrink-0 text-[var(--text-disabled)]" strokeWidth={1.5} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models"
                className="flex-1 bg-transparent font-sans text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
                autoFocus
              />
            </div>

            <div className="border-b border-[var(--border-card)] px-[12px] py-[6px]">
              <div className="flex items-center justify-between py-[3px]">
                <span className="font-sans text-[13px] text-[var(--text-primary)]">MAX Mode</span>
                <ToggleSwitch checked={maxMode} onChange={setMaxMode} size="sm" />
              </div>
            </div>

            <div className="max-h-[220px] overflow-y-auto py-[2px]">
              {filtered.length === 0 && (
                <p className="px-[12px] py-[8px] font-sans text-[13px] text-[var(--text-disabled)]">
                  No models found
                </p>
              )}
              {filtered.map((m) => {
                const Icon = providerIcon[m.provider];
                const active = m.id === model.id;
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
                    <span
                      className="flex-1 font-sans text-[13px] font-normal"
                      style={{ color: active ? "var(--text-primary)" : "var(--text-secondary)" }}
                    >
                      {m.name}
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
