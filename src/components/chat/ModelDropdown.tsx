"use client";

import {
  memo,
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
  useLayoutEffect,
  useDeferredValue,
} from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Box,
  ChevronDown,
  ChevronRight,
  Check,
  Search,
  Pencil,
  Settings,
} from "lucide-react";
import { useClickOutside } from "@/hooks/useClickOutside";
import { useHoverCapable } from "@/hooks/useHoverCapable";
import { usePopover } from "@/hooks/usePopover";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { useShellView } from "@/components/layout/ShellViewContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import type { ModelInfo } from "@/lib/types";
import { composerVisibleHarnesses } from "@cesium/core";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import type { AgentBackendId, AgentBackendInfo } from "@/lib/agent-types";
import { shouldAutoFocusTextInput } from "@/lib/mobile-autofocus";
import { resolveModelBrandIcon } from "@/lib/model-brand-icons";
import { AgentBackendIcon } from "./AgentBackendIcon";
import { ModelBrandIcon } from "./ModelBrandIcon";
import { scrollEdgeMaskStyle } from "./scroll-edge-mask";
import { measureDev, recordPerfSample } from "@/lib/dev-perf";
import {
  applySelectedToGroup as applyCapabilitySelection,
  buildBaseModelPickerGroups as buildCapabilityGroups,
  canSelectBooleanValue,
  selectVariantForParameter,
  type BaseModelPickerGroup as CapabilityBaseModelPickerGroup,
  type ModelPickerGroup as CapabilityModelPickerGroup,
} from "./model-picker-variants";

/** Row height for @tanstack/react-virtual (py-[4px] + 13px text). */
const MODEL_ROW_ESTIMATE_PX = 30;
/** Virtualize before larger catalogs can jank low-power devices. */
const MODEL_LIST_VIRTUALIZE_THRESHOLD = 24;

const popoverSurface =
  "rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)]";

function settingsNavForBackend(): string {
  return "agents";
}

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

type ModelPickerSearchEntry = {
  group: CapabilityBaseModelPickerGroup;
  /** Lowercased haystack built once when the catalog loads. */
  haystack: string;
};

function buildModelPickerSearchIndex(groups: CapabilityBaseModelPickerGroup[]): ModelPickerSearchEntry[] {
  return measureDev("chat.model_dropdown.build_search_index", () =>
    groups.map((group) => {
      const parts = [group.name, group.detail];
      for (const variant of group.variants) {
        const m = variant.model;
        parts.push(m.name, m.id, m.modelValue, m.detail, m.description);
      }
      return {
        group,
        haystack: parts
          .filter((part): part is string => typeof part === "string" && part.length > 0)
          .join("\0")
          .toLowerCase(),
      };
    })
  );
}

function filterModelPickerGroups(
  searchIndex: ModelPickerSearchEntry[],
  query: string
): CapabilityBaseModelPickerGroup[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return searchIndex.map((entry) => entry.group);
  }
  const q = trimmed.toLowerCase();
  const out: CapabilityBaseModelPickerGroup[] = [];
  for (const entry of searchIndex) {
    if (entry.haystack.includes(q)) {
      out.push(entry.group);
    }
  }
  return out;
}

type ModelPickerRowProps = {
  group: CapabilityModelPickerGroup;
  index: number;
  highlightedIndex: number;
  onSelect: (model: ModelInfo) => void;
  onHighlight: (index: number) => void;
  onEdit: (group: CapabilityModelPickerGroup, anchor: HTMLElement) => void;
};

const ModelPickerRow = memo(function ModelPickerRow({
  group,
  index,
  highlightedIndex,
  onSelect,
  onHighlight,
  onEdit,
}: ModelPickerRowProps) {
  const rowModel = group.selectedVariant?.model ?? group.defaultVariant.model;
  const active = group.selectedVariant != null;
  const editable = group.parameters.length > 0;
  const detail =
    group.detail ??
    group.selectedVariant?.model.detail ??
    group.selectedVariant?.model.description ??
    group.defaultVariant.model.detail ??
    group.defaultVariant.model.description;
  const kbdHi = index === highlightedIndex && !active;
  const reserveRight =
    editable && active ? "pr-[40px]" : editable ? "pr-[28px]" : active ? "pr-[20px]" : "";

  return (
    <div
      data-index={index}
      title={detail}
      onMouseEnter={() => onHighlight(index)}
      className={`group relative items-center ${pickerOptionRowClass(active, kbdHi)} w-full`}
      aria-selected={index === highlightedIndex}
    >
      <button
        type="button"
        onClick={() => onSelect(group.defaultVariant.model)}
        className={`flex min-w-0 flex-1 items-center gap-[8px] text-left ${reserveRight}`}
      >
        <ModelBrandIcon model={rowModel} className="size-[14px] shrink-0" strokeWidth={1.5} />
        <span
          className="min-w-0 flex-1 truncate font-sans text-[13px] font-normal leading-snug"
          style={{
            color: active ? "var(--text-primary)" : "var(--text-secondary)",
          }}
        >
          {group.name}
        </span>
      </button>
      <div className="pointer-events-none absolute right-[6px] top-1/2 z-[1] flex -translate-y-1/2 items-center gap-[2px]">
        {editable ? (
          <button
            type="button"
            aria-label={`Edit ${group.name} parameters`}
            title={`Edit ${group.name}`}
            className={`pointer-events-auto flex size-[22px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] transition-opacity duration-150 focus-visible:opacity-100 ${
              index === highlightedIndex
                ? "opacity-100"
                : // pointer-coarse: hover never fires on touch, so the edit
                  // affordance must stay visible there or it is unreachable.
                  "opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100"
            } ${
              active
                ? "text-[var(--text-primary)]"
                : "text-[var(--text-disabled)] hover:text-[var(--text-primary)]"
            }`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onEdit(group, e.currentTarget);
            }}
          >
            <Pencil className="size-[12px] shrink-0" strokeWidth={2} aria-hidden />
          </button>
        ) : null}
        {active ? (
          <Check
            className="pointer-events-none size-[14px] shrink-0 text-[var(--text-primary)]"
            strokeWidth={2}
            aria-hidden
          />
        ) : null}
      </div>
    </div>
  );
});

function ModelListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-[2px] px-[4px] py-[4px]" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex h-[30px] items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px]"
        >
          <div className="size-[14px] shrink-0 animate-pulse rounded-full bg-[var(--accent-bg)]/70" />
          <div
            className="h-[12px] animate-pulse rounded-[4px] bg-[var(--accent-bg)]/70"
            style={{ width: `${48 + (i % 4) * 14}%` }}
          />
        </div>
      ))}
    </div>
  );
}

interface ModelDropdownProps {
  model: ModelInfo;
  models: ModelInfo[];
  onModelChange?: (model: ModelInfo) => void;
  popoverPlacement?: "above" | "below";
  disabled?: boolean;
  /**
   * Icon-only trigger (brand mark + chevron, no model name) for narrow
   * single-line composers where the full label would crowd out the editor.
   */
  compact?: boolean;
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
  compact = false,
  isOpen: controlledIsOpen,
  onOpenChange,
  backendId,
  backends,
  onBackendChange,
}: ModelDropdownProps) {
  const { openSettingsView } = useShellView();
  const { updateWorkspaceSession } = useWorkspace();
  const { settings } = useGlobalSettings();
  /**
   * Touch taps synthesize mouseenter/mouseleave bursts; hover-open + click
   * -toggle on the same target makes the harness flyout open and instantly
   * close on Android. Only run hover open/close logic on hover-capable
   * pointers; touch relies on explicit tap-to-toggle.
   */
  const hoverCapable = useHoverCapable();
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledIsOpen !== undefined;
  const open = isControlled ? controlledIsOpen ?? false : internalOpen;

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [harnessFlyoutOpen, setHarnessFlyoutOpen] = useState(false);
  const [harnessFlyoutPos, setHarnessFlyoutPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [modelEditFlyout, setModelEditFlyout] = useState<{
    groupKey: string;
    top: number;
    left: number;
  } | null>(null);
  const [modelListFade, setModelListFade] = useState({ top: false, bottom: false });
  const [harnessListFade, setHarnessListFade] = useState({ top: false, bottom: false });
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const harnessListRef = useRef<HTMLDivElement>(null);
  const harnessAnchorRef = useRef<HTMLDivElement>(null);
  const harnessFlyoutRef = useRef<HTMLDivElement>(null);
  const modelEditFlyoutRef = useRef<HTMLDivElement>(null);
  const harnessCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Dev perf: time from open click to list paint (see chat.model_dropdown.list_ready). */
  const openPerfRef = useRef<number | null>(null);
  const [listContentReady, setListContentReady] = useState(false);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (isControlled) {
        onOpenChange?.(nextOpen);
      } else {
        setInternalOpen(nextOpen);
      }
      if (nextOpen) {
        openPerfRef.current = performance.now();
        recordPerfSample("chat.model_dropdown.open_visible", openPerfRef.current, {
          backendId: backendId ?? null,
          models: models.length,
        });
        setQuery("");
        setHighlightedIndex(0);
        setHarnessFlyoutOpen(false);
        setModelEditFlyout(null);
      } else {
        openPerfRef.current = null;
        setHarnessFlyoutOpen(false);
        setHarnessFlyoutPos(null);
        setModelEditFlyout(null);
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

  const visibleBackends = useMemo(
    () =>
      composerVisibleHarnesses(backends ?? [], {
        currentBackendId: backendId,
        enabledHarnesses: settings.agents.enabledHarnesses,
        harnessTransports: settings.agents.harnessTransports,
      }),
    [
      backendId,
      backends,
      settings.agents.enabledHarnesses,
      settings.agents.harnessTransports,
    ]
  );

  const showHarnessFlyoutUi = Boolean(
    visibleBackends.length > 0 && onBackendChange
  );

  const openBackendSettings = useCallback(
    () => {
      updateWorkspaceSession((current) => ({
        ...current,
        settingsView: {
          ...current.settingsView,
          activeNav: settingsNavForBackend(),
          agentsHarnessId: null,
        },
      }));
      openSettingsView();
      handleOpenChange(false);
    },
    [handleOpenChange, openSettingsView, updateWorkspaceSession]
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

  const closeHarnessFlyoutNow = useCallback(() => {
    clearHarnessCloseTimer();
    setHarnessFlyoutOpen(false);
    setHarnessFlyoutPos(null);
  }, [clearHarnessCloseTimer]);

  const scheduleCloseHarnessFlyout = useCallback(() => {
    clearHarnessCloseTimer();
    harnessCloseTimerRef.current = setTimeout(() => {
      setHarnessFlyoutOpen(false);
      setHarnessFlyoutPos(null);
      harnessCloseTimerRef.current = null;
    }, 240);
  }, [clearHarnessCloseTimer]);

  const toggleHarnessFlyout = useCallback(() => {
    if (harnessFlyoutOpen) {
      closeHarnessFlyoutNow();
    } else {
      openHarnessFlyoutNow();
    }
  }, [closeHarnessFlyoutNow, harnessFlyoutOpen, openHarnessFlyoutNow]);

  /**
   * Row-level activation: hover-capable pointers already opened the flyout on
   * mouseenter, so a click only ensures it is open; touch taps (no hover
   * events run) toggle it so a second tap closes instead of reopening.
   */
  const handleHarnessRowClick = useCallback(() => {
    if (hoverCapable) {
      openHarnessFlyoutNow();
    } else {
      toggleHarnessFlyout();
    }
  }, [hoverCapable, openHarnessFlyoutNow, toggleHarnessFlyout]);

  const { triggerRef, popoverRef, position, ready } = usePopover(open, {
    placement: popoverPlacement,
  });

  useClickOutside(triggerRef, close, open, [popoverRef, harnessFlyoutRef, modelEditFlyoutRef]);

  useEffect(() => {
    if (open && ready && searchInputRef.current && shouldAutoFocusTextInput()) {
      searchInputRef.current.focus();
    }
  }, [open, ready]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [deferredQuery]);

  /** Pre-index catalog when models change — not recomputed on each open/filter keystroke. */
  const baseGroups = useMemo(
    () => measureDev("chat.model_dropdown.build_base_groups", () => buildCapabilityGroups(models)),
    [models]
  );
  const searchIndex = useMemo(() => buildModelPickerSearchIndex(baseGroups), [baseGroups]);

  const filteredBase = useMemo(
    () =>
      deferredQuery.trim()
        ? filterModelPickerGroups(searchIndex, deferredQuery)
        : baseGroups,
    [baseGroups, searchIndex, deferredQuery]
  );

  /** Defer heavy list mount so popover shell + search paint on the first frame. */
  useEffect(() => {
    if (!open) {
      setListContentReady(false);
      return;
    }
    let cancelled = false;
    const frameId = requestAnimationFrame(() => {
      if (!cancelled) {
        setListContentReady(true);
      }
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
    };
  }, [open]);

  useEffect(() => {
    setHighlightedIndex((prev) =>
      filteredBase.length === 0 ? 0 : Math.min(prev, filteredBase.length - 1)
    );
  }, [filteredBase.length]);

  const listMaxHeight = Math.max(
    96,
    Math.min(340, position.maxHeight - (showHarnessFlyoutUi ? 92 : 44))
  );

  const useVirtualList =
    listContentReady && filteredBase.length >= MODEL_LIST_VIRTUALIZE_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: useVirtualList ? filteredBase.length : 0,
    getScrollElement: () => listRef.current,
    estimateSize: () => MODEL_ROW_ESTIMATE_PX,
    overscan: 6,
    getItemKey: (index) => filteredBase[index]?.key ?? String(index),
  });

  useEffect(() => {
    if (!open || !listContentReady || openPerfRef.current == null) {
      return;
    }
    recordPerfSample("chat.model_dropdown.list_ready", openPerfRef.current, {
      backendId: backendId ?? null,
      groups: filteredBase.length,
      virtualized: useVirtualList,
    });
    openPerfRef.current = null;
  }, [backendId, filteredBase.length, listContentReady, open, useVirtualList]);

  const updateModelListFade = useCallback(() => {
    const el = listRef.current;
    if (!el) {
      return;
    }
    const maxScrollY = el.scrollHeight - el.clientHeight;
    setModelListFade({
      top: el.scrollTop > 2,
      bottom: maxScrollY > 2 && el.scrollTop < maxScrollY - 2,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setModelListFade({ top: false, bottom: false });
      return;
    }
    updateModelListFade();
  }, [filteredBase.length, listContentReady, listMaxHeight, open, updateModelListFade, useVirtualList]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || !open) {
      return;
    }
    const ro = new ResizeObserver(() => updateModelListFade());
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, updateModelListFade]);

  const updateHarnessListFade = useCallback(() => {
    const el = harnessListRef.current;
    if (!el) {
      return;
    }
    const maxScrollY = el.scrollHeight - el.clientHeight;
    setHarnessListFade({
      top: el.scrollTop > 2,
      bottom: maxScrollY > 2 && el.scrollTop < maxScrollY - 2,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open || !harnessFlyoutOpen) {
      setHarnessListFade({ top: false, bottom: false });
      return;
    }
    updateHarnessListFade();
  }, [
    backends?.length,
    harnessFlyoutOpen,
    harnessFlyoutPos?.left,
    harnessFlyoutPos?.top,
    open,
    updateHarnessListFade,
  ]);

  useLayoutEffect(() => {
    const el = harnessListRef.current;
    if (!el || !open || !harnessFlyoutOpen) {
      return;
    }
    const ro = new ResizeObserver(() => updateHarnessListFade());
    ro.observe(el);
    return () => ro.disconnect();
  }, [harnessFlyoutOpen, open, updateHarnessListFade]);

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
          setHighlightedIndex((prev) => (prev < filteredBase.length - 1 ? prev + 1 : prev));
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : prev));
          break;
        case "Enter":
          e.preventDefault();
          if (filteredBase[highlightedIndex]) {
            selectModel(filteredBase[highlightedIndex].defaultVariant.model);
          }
          break;
        case "Escape":
          e.preventDefault();
          if (modelEditFlyout) {
            setModelEditFlyout(null);
          } else if (harnessFlyoutOpen) {
            closeHarnessFlyoutNow();
          } else {
            close();
          }
          break;
      }
    },
    [
      open,
      filteredBase,
      highlightedIndex,
      selectModel,
      close,
      modelEditFlyout,
      harnessFlyoutOpen,
      closeHarnessFlyoutNow,
    ]
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
    if (!open || !listContentReady) {
      return;
    }
    if (useVirtualList) {
      virtualizer.scrollToIndex(highlightedIndex, { align: "auto" });
      return;
    }
    if (listRef.current) {
      const highlightedEl = listRef.current.querySelector(`[data-index="${highlightedIndex}"]`);
      highlightedEl?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex, listContentReady, open, useVirtualList, virtualizer]);

  const activeEditGroup = useMemo(
    () => {
      if (!modelEditFlyout?.groupKey) {
        return null;
      }
      const base = searchIndex.find((entry) => entry.group.key === modelEditFlyout.groupKey)?.group;
      return base ? applyCapabilitySelection(base, model) : null;
    },
    [model, modelEditFlyout?.groupKey, searchIndex]
  );
  const openModelEditFlyout = useCallback((group: CapabilityModelPickerGroup, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    const gap = 8;
    const panelWidth = 216;
    const pad = 8;
    let left = rect.right + gap;
    if (left + panelWidth > window.innerWidth - pad) {
      left = Math.max(pad, rect.left - panelWidth - gap);
    }
    setModelEditFlyout({
      groupKey: group.key,
      top: Math.min(rect.top - 8, window.innerHeight - 320),
      left,
    });
  }, []);

  const selectVariantParam = useCallback(
    (group: CapabilityModelPickerGroup, parameterId: string, value: string) => {
      const next = selectVariantForParameter(group, parameterId, value);
      onModelChange?.(next.model);
    },
    [onModelChange]
  );

  return (
    <>
      <div ref={triggerRef} className="inline-flex max-w-full min-w-0 align-middle">
        <button
          type="button"
          disabled={disabled}
          data-perf="chat-model-dropdown-trigger"
          onClick={() => (open ? close() : openDropdown())}
          className="inline-flex max-w-full min-w-0 items-center gap-[4px] overflow-hidden text-left transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={compact ? `Model: ${model.name}` : undefined}
          title={compact ? model.name : undefined}
        >
          {compact && resolveModelBrandIcon(model).kind === "none" ? (
            // Auto/Efficiency-style models render no brand mark; an icon-only
            // trigger still needs a visible glyph next to the chevron.
            <Box
              className="size-[14px] shrink-0 text-[var(--text-secondary)]"
              strokeWidth={1.5}
              aria-hidden
            />
          ) : (
            <ModelBrandIcon model={model} className="size-[14px] shrink-0" strokeWidth={1.5} />
          )}
          {compact ? null : (
            <span
              className="min-w-0 max-w-[min(280px,45vw)] truncate font-sans text-[13px] font-normal text-[var(--text-secondary)]"
              title={model.name}
            >
              {model.name}
            </span>
          )}
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
                  className="group min-w-0 shrink-0 border-b border-[var(--border-card)] p-[4px]"
                  onMouseEnter={hoverCapable ? openHarnessFlyoutNow : undefined}
                  onMouseLeave={hoverCapable ? scheduleCloseHarnessFlyout : undefined}
                >
                  <div
                    className="flex min-w-0 cursor-pointer items-center gap-[8px] rounded-[var(--radius-tab)] px-[6px] py-[3px] transition-colors group-hover:bg-[var(--accent-bg)]/60"
                    onClick={handleHarnessRowClick}
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
                      data-perf="chat-model-dropdown-harness-trigger"
                      aria-label="Choose harness"
                      aria-expanded={harnessFlyoutOpen}
                      aria-haspopup="menu"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleHarnessFlyout();
                      }}
                      className="flex size-[28px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)]"
                    >
                      <ChevronRight className="size-[14px] shrink-0" strokeWidth={2.25} />
                    </button>
                  </div>
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
              <div className="relative min-h-0 flex-1">
                <div
                  ref={listRef}
                  className="hide-scrollbar-y min-h-0 flex-1 overflow-y-auto overscroll-contain px-[4px] py-[4px]"
                  style={{
                    maxHeight: listMaxHeight,
                    overscrollBehaviorY: "contain",
                    ...scrollEdgeMaskStyle(modelListFade),
                  }}
                  onScroll={updateModelListFade}
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
                  {!listContentReady ? (
                    <ModelListSkeleton />
                  ) : filteredBase.length === 0 ? (
                    <p className="px-[8px] py-[6px] font-sans text-[13px] text-[var(--text-disabled)]">
                      No models found
                    </p>
                  ) : useVirtualList ? (
                    <div
                      className="relative w-full"
                      style={{ height: `${virtualizer.getTotalSize()}px` }}
                    >
                      {virtualizer.getVirtualItems().map((item) => {
                        const baseGroup = filteredBase[item.index];
                        if (!baseGroup) {
                          return null;
                        }
                        const group = applyCapabilitySelection(baseGroup, model);
                        return (
                          <div
                            key={group.key}
                            data-index={item.index}
                            className="absolute left-0 w-full"
                            style={{
                              top: item.start,
                              height: item.size,
                            }}
                          >
                            <ModelPickerRow
                              group={group}
                              index={item.index}
                              highlightedIndex={highlightedIndex}
                              onSelect={selectModel}
                              onHighlight={setHighlightedIndex}
                              onEdit={openModelEditFlyout}
                            />
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    filteredBase.map((baseGroup, index) => {
                      const group = applyCapabilitySelection(baseGroup, model);
                      return (
                        <ModelPickerRow
                          key={group.key}
                          group={group}
                          index={index}
                          highlightedIndex={highlightedIndex}
                          onSelect={selectModel}
                          onHighlight={setHighlightedIndex}
                          onEdit={openModelEditFlyout}
                        />
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}

      {open &&
        modelEditFlyout &&
        activeEditGroup &&
        createPortal(
          <div
            ref={modelEditFlyoutRef}
            role="dialog"
            aria-label={`Edit ${activeEditGroup.name} model parameters`}
            data-ide-input-sink
            className={`fixed z-[10002] w-[216px] py-[4px] ${popoverSurface} shadow-lg`}
            style={{
              top: Math.max(8, modelEditFlyout.top),
              left: modelEditFlyout.left,
              maxHeight: "min(340px, calc(100vh - 16px))",
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            {activeEditGroup.parameters.map((parameter, index) => {
              const current =
                (activeEditGroup.selectedVariant ?? activeEditGroup.defaultVariant).parameters.get(
                  parameter.id
                )?.value;
              const labelId = `model-picker-${parameter.id.replace(/[^a-z0-9_-]/gi, "-")}-label`;
              const isLast = index === activeEditGroup.parameters.length - 1;
              if (parameter.booleanValues) {
                const checked = current === parameter.booleanValues.trueValue;
                const targetValue = checked
                  ? parameter.booleanValues.falseValue
                  : parameter.booleanValues.trueValue;
                const available = canSelectBooleanValue(
                  activeEditGroup,
                  parameter.id,
                  targetValue
                );
                return (
                  <div
                    key={parameter.id}
                    className={`px-[4px] ${index > 0 ? "pt-[6px]" : ""} ${
                      isLast ? "" : "border-b border-[var(--border-card)] pb-[6px]"
                    }`}
                  >
                    <div className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[4px] text-left transition-colors hover:bg-[var(--accent-bg)]/60">
                      <span
                        id={labelId}
                        className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-[var(--text-primary)]"
                      >
                        {parameter.label}
                      </span>
                      <ToggleSwitch
                        checked={checked}
                        disabled={!available}
                        onChange={(nextChecked) =>
                          selectVariantParam(
                            activeEditGroup,
                            parameter.id,
                            nextChecked
                              ? parameter.booleanValues!.trueValue
                              : parameter.booleanValues!.falseValue
                          )
                        }
                        size="sm"
                        labelledBy={labelId}
                      />
                    </div>
                  </div>
                );
              }
              return (
                <div
                  key={parameter.id}
                  className={`px-[4px] ${index > 0 ? "pt-[6px]" : ""} ${
                    isLast ? "" : "border-b border-[var(--border-card)] pb-[6px]"
                  }`}
                >
                  <div className="px-[8px] pb-[3px] font-sans text-[11px] font-medium text-[var(--text-disabled)]">
                    {parameter.label}
                  </div>
                  {parameter.values.map((option) => {
                    const selected = current === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className={pickerOptionRowClass(selected, false)}
                        onClick={() =>
                          selectVariantParam(activeEditGroup, parameter.id, option.value)
                        }
                      >
                        <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-[var(--text-primary)]">
                          {option.label}
                        </span>
                        {selected ? <Check className="size-[13px]" strokeWidth={2} /> : null}
                      </button>
                    );
                  })}
                </div>
              );
            })}
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
            className={`fixed z-[10001] flex w-[min(248px,calc(100vw-16px))] min-w-[200px] flex-col overflow-hidden py-[4px] ${popoverSurface} shadow-lg`}
            style={{
              top: harnessFlyoutPos.top,
              left: harnessFlyoutPos.left,
              maxHeight: "min(320px, calc(100vh - 24px))",
            }}
            onMouseEnter={hoverCapable ? openHarnessFlyoutNow : undefined}
            onMouseLeave={hoverCapable ? scheduleCloseHarnessFlyout : undefined}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <span className="px-[10px] pb-[3px] pt-[2px] font-sans text-[11px] font-medium text-[var(--text-disabled)]">
              Harnesses
            </span>
            <div className="relative min-h-0 min-w-0">
              <div
                ref={harnessListRef}
                className="hide-scrollbar-y max-h-[min(268px,calc(100vh-80px))] min-h-0 overflow-y-auto overscroll-contain px-[4px] py-[2px]"
                style={scrollEdgeMaskStyle(harnessListFade)}
                onScroll={updateHarnessListFade}
              >
              {visibleBackends.map((backend) => {
                const harnessActive = backend.id === backendId;
                const available = backend.available !== false;
                return (
                  <div
                    key={backend.id}
                    role="menuitem"
                    className={`my-[1px] items-center ${pickerOptionRowClass(harnessActive, false)} ${
                      available ? "" : "opacity-55"
                    }`}
                    aria-pressed={harnessActive}
                    title={backend.description}
                  >
                    <button
                      type="button"
                      disabled={!available}
                      onClick={() => {
                        recordPerfSample(
                          "chat.model_dropdown.backend_select_visible",
                          performance.now(),
                          { backendId: backend.id }
                        );
                        onBackendChange?.(backend.id);
                        // Selection is done: close the flyout on every input
                        // type so touch users are not left with it covering
                        // the model list (no mouseleave ever fires on tap).
                        closeHarnessFlyoutNow();
                      }}
                      className="flex min-w-0 flex-1 items-center gap-[8px] text-left disabled:cursor-not-allowed"
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
                    </button>
                    {!available ? (
                      <button
                        type="button"
                        aria-label={`Configure ${backend.label}`}
                        title={`Configure ${backend.label}`}
                        onClick={() => openBackendSettings()}
                        className="flex size-[22px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
                      >
                        <Settings className="size-[12px]" strokeWidth={1.7} />
                      </button>
                    ) : harnessActive ? (
                      <Check
                        className="size-[13px] shrink-0 text-[var(--text-primary)]"
                        strokeWidth={2}
                      />
                    ) : null}
                  </div>
                );
              })}
              </div>
            </div>
            <div className="border-t border-[var(--border-card)] px-[4px] pt-[4px]">
              <button
                type="button"
                className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[5px] text-left font-sans text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
                onClick={() => openBackendSettings()}
              >
                <Settings className="size-[12px] shrink-0" strokeWidth={1.7} />
                Manage harnesses
              </button>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}