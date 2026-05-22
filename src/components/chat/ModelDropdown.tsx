"use client";

import {
  memo,
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
  useLayoutEffect,
} from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDown,
  ChevronRight,
  Check,
  Search,
  Pencil,
  Settings,
} from "lucide-react";
import { useClickOutside } from "@/hooks/useClickOutside";
import { usePopover } from "@/hooks/usePopover";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { useShellView } from "@/components/layout/ShellViewContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import type { ModelInfo } from "@/lib/types";
import type { AgentBackendId, AgentBackendInfo } from "@/lib/agent-types";
import { shouldAutoFocusTextInput } from "@/lib/mobile-autofocus";
import { isAutoModel } from "@/lib/model-brand-icons";
import { AgentBackendIcon } from "./AgentBackendIcon";
import { ModelBrandIcon } from "./ModelBrandIcon";
import { measureDev, recordPerfSample } from "@/lib/dev-perf";

/** Row height for @tanstack/react-virtual (py-[4px] + 13px text). */
const MODEL_ROW_ESTIMATE_PX = 30;
/** Virtualize when the filtered catalog exceeds this many groups. */
const MODEL_LIST_VIRTUALIZE_THRESHOLD = 48;

const popoverSurface =
  "rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)]";

function settingsNavForBackend(_backendId: AgentBackendId): string {
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

type PickerVariantParams = {
  context?: string;
  reasoning?: string;
  fast?: boolean;
};

type ModelPickerVariant = {
  model: ModelInfo;
  params: PickerVariantParams;
  defaultish: boolean;
};

type ModelPickerGroup = {
  key: string;
  name: string;
  provider: ModelInfo["provider"];
  detail?: string;
  variants: ModelPickerVariant[];
  selectedVariant: ModelPickerVariant | null;
  defaultVariant: ModelPickerVariant;
  contextOptions: string[];
  reasoningOptions: string[];
  hasFastOption: boolean;
};

const REASONING_ORDER = ["none", "low", "medium", "high", "extra high", "max", "thinking"];

function normalizeVariantToken(value: string): string {
  return value.trim().toLowerCase().replace(/[-_]+/g, " ");
}

function formatContextLabel(value: string): string {
  const trimmed = value.trim();
  if (/^\d+\s*k$/i.test(trimmed)) {
    return trimmed.replace(/\s+/g, "").toUpperCase();
  }
  if (/^\d+\s*m$/i.test(trimmed)) {
    return trimmed.replace(/\s+/g, "").toUpperCase();
  }
  return trimmed;
}

function formatReasoningLabel(value: string): string {
  const normalized = normalizeVariantToken(value);
  if (!normalized || normalized === "default" || normalized === "auto") return "None";
  if (normalized === "xhigh" || normalized === "extra high") return "Extra High";
  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function contextSortValue(value: string): number {
  const normalized = value.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)([km])$/.exec(normalized);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const amount = Number.parseFloat(match[1]);
  return amount * (match[2] === "m" ? 1000 : 1);
}

function sortReasoningValues(values: string[]): string[] {
  return [...values].sort((a, b) => {
    const ai = REASONING_ORDER.indexOf(normalizeVariantToken(a));
    const bi = REASONING_ORDER.indexOf(normalizeVariantToken(b));
    if (ai !== -1 || bi !== -1) {
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    }
    return a.localeCompare(b);
  });
}

function parseBracketParams(value: string): PickerVariantParams {
  const out: PickerVariantParams = {};
  const match = /^(.*)\[(.*)\]$/.exec(value.trim());
  if (!match) return out;
  for (const rawEntry of (match[2] ?? "").split(",")) {
    const [rawKey, ...rawValueParts] = rawEntry.split("=");
    const key = normalizeVariantToken(rawKey ?? "");
    const rawValue = rawValueParts.join("=").trim();
    const normalizedValue = normalizeVariantToken(rawValue);
    if (!key || !rawValue) continue;
    if (/context|length|window|token/.test(key)) {
      out.context = formatContextLabel(rawValue);
    } else if (/reason|effort|thinking/.test(key)) {
      out.reasoning = formatReasoningLabel(rawValue);
    } else if (/speed|fast/.test(key)) {
      out.fast = normalizedValue === "fast" || normalizedValue === "true";
    }
  }
  return out;
}

function applyConfigSelectionParams(
  params: PickerVariantParams,
  selections: ModelInfo["configSelections"]
): PickerVariantParams {
  if (!selections?.length) return params;
  const next = { ...params };
  for (const selection of selections) {
    const key = normalizeVariantToken(selection.configId);
    const value = selection.value;
    const normalizedValue = normalizeVariantToken(value);
    if (/context|length|window|token/.test(key)) {
      next.context = formatContextLabel(value);
    } else if (/reason|effort|thinking/.test(key)) {
      next.reasoning = formatReasoningLabel(value);
    } else if (/speed|fast/.test(key)) {
      next.fast = normalizedValue === "fast" || normalizedValue === "true";
    }
  }
  return next;
}

function consumeTrailingVariantToken(words: string[]): { key: keyof PickerVariantParams; value: string } | null {
  const last = words.at(-1);
  if (!last) return null;
  const normalizedLast = normalizeVariantToken(last);
  if (normalizedLast === "true") {
    words.pop();
    return { key: "fast", value: "true" };
  }
  if (normalizedLast === "false") {
    words.pop();
    if (normalizeVariantToken(words.at(-1) ?? "") === "fast") {
      words.pop();
    }
    return { key: "fast", value: "false" };
  }
  if (normalizedLast === "fast") {
    words.pop();
    return { key: "fast", value: "true" };
  }
  if (/^\d+\s*[km]$/i.test(last)) {
    words.pop();
    return { key: "context", value: formatContextLabel(last) };
  }
  if (normalizedLast === "extra" && normalizeVariantToken(words.at(-2) ?? "") === "high") {
    return null;
  }
  const prev = normalizeVariantToken(words.at(-2) ?? "");
  if (prev === "extra" && normalizedLast === "high") {
    words.pop();
    words.pop();
    return { key: "reasoning", value: "Extra High" };
  }
  if (["none", "low", "medium", "high", "xhigh", "max", "thinking"].includes(normalizedLast)) {
    words.pop();
    return { key: "reasoning", value: formatReasoningLabel(last) };
  }
  return null;
}

function parseNameVariant(modelName: string): { baseName: string; params: PickerVariantParams; defaultish: boolean } {
  const params: PickerVariantParams = {};
  const defaultish = /\bdefault\b/i.test(modelName);
  const nameWithoutDefault = modelName.replace(/\s*\((?:default|current)\)\s*$/i, "").trim();
  const paren = /^(.*)\(([^)]*)\)\s*$/.exec(nameWithoutDefault);
  let baseName = (paren?.[1] ?? nameWithoutDefault).trim();
  if (paren) {
    for (const part of (paren[2] ?? "").split(",")) {
      const token = part.trim();
      const normalized = normalizeVariantToken(token);
      if (!token || normalized === "none" || normalized === "default" || normalized === "auto") continue;
      if (/^\d+\s*[km]$/i.test(token)) params.context = formatContextLabel(token);
      else if (normalized === "fast") params.fast = true;
      else if (["low", "medium", "high", "xhigh", "extra high", "max", "thinking"].includes(normalized)) {
        params.reasoning = formatReasoningLabel(token);
      }
    }
  }
  const words = baseName.split(/\s+/).filter(Boolean);
  for (;;) {
    const consumed = consumeTrailingVariantToken(words);
    if (!consumed) break;
    if (consumed.key === "fast") params.fast = true;
    if (consumed.key === "context") params.context = consumed.value;
    if (consumed.key === "reasoning") params.reasoning = consumed.value;
  }
  baseName = words.join(" ").trim() || baseName;
  return { baseName, params, defaultish };
}

function mergeParams(...parts: PickerVariantParams[]): PickerVariantParams {
  return Object.assign({}, ...parts);
}

function modelGroupKey(model: ModelInfo, baseName: string): string {
  return `${model.backendId ?? ""}:${model.provider}:${baseName.toLowerCase()}`;
}

function isSameModelChoice(a: ModelInfo, b: ModelInfo): boolean {
  const av = a.modelValue ?? a.id;
  const bv = b.modelValue ?? b.id;
  if (av !== bv) return false;
  const ac = a.configSelections?.map((s) => `${s.configId}:${s.value}`).sort().join("|") ?? "";
  const bc = b.configSelections?.map((s) => `${s.configId}:${s.value}`).sort().join("|") ?? "";
  return ac === bc;
}

type BaseModelPickerGroup = Omit<ModelPickerGroup, "selectedVariant">;

type ModelPickerSearchEntry = {
  group: BaseModelPickerGroup;
  /** Lowercased haystack built once when the catalog loads. */
  haystack: string;
};

function finalizeModelPickerGroup(
  key: string,
  group: {
    name: string;
    provider: ModelInfo["provider"];
    detail?: string;
    variants: ModelPickerVariant[];
  }
): BaseModelPickerGroup {
  const defaultVariant =
    group.variants.find((variant) => variant.defaultish) ?? group.variants[0];
  const contextOptions = [
    ...new Set(group.variants.map((variant) => variant.params.context).filter(Boolean) as string[]),
  ].sort((a, b) => contextSortValue(a) - contextSortValue(b) || a.localeCompare(b));
  const reasoningOptions = sortReasoningValues([
    ...new Set(
      group.variants.map((variant) => variant.params.reasoning ?? "None").filter(Boolean)
    ),
  ]);
  const hasFast = group.variants.some((variant) => variant.params.fast === true);
  const hasSlow = group.variants.some((variant) => variant.params.fast !== true);
  return {
    key,
    name: group.name,
    provider: group.provider,
    detail: group.detail,
    variants: group.variants,
    defaultVariant,
    contextOptions,
    reasoningOptions: reasoningOptions.length > 1 ? reasoningOptions : [],
    hasFastOption: hasFast && hasSlow,
  };
}

/** Build grouped catalog once per models array — no selected-model dependency. */
function buildBaseModelPickerGroups(models: ModelInfo[]): BaseModelPickerGroup[] {
  return measureDev("chat.model_dropdown.build_base_groups", () => {
    const byKey = new Map<
      string,
      { name: string; provider: ModelInfo["provider"]; detail?: string; variants: ModelPickerVariant[] }
    >();
    for (const model of models) {
      const nameParsed = parseNameVariant(model.name);
      const encodedParams = parseBracketParams(model.modelValue ?? model.id);
      const params = mergeParams(nameParsed.params, encodedParams);
      const baseName = isAutoModel(model) ? "Auto" : nameParsed.baseName;
      const key = modelGroupKey(model, baseName);
      const group = byKey.get(key) ?? {
        name: baseName,
        provider: model.provider,
        detail: model.detail,
        variants: [],
      };
      group.variants.push({
        model,
        params,
        defaultish: nameParsed.defaultish || isAutoModel(model) || Object.keys(params).length === 0,
      });
      byKey.set(key, group);
    }

    return [...byKey.entries()]
      .map(([key, group]) => finalizeModelPickerGroup(key, group))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

function buildModelPickerSearchIndex(groups: BaseModelPickerGroup[]): ModelPickerSearchEntry[] {
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

function applySelectedToGroups(
  groups: BaseModelPickerGroup[],
  selected: ModelInfo
): ModelPickerGroup[] {
  return groups.map((group) => ({
    ...group,
    selectedVariant:
      group.variants.find((variant) => isSameModelChoice(variant.model, selected)) ?? null,
  }));
}

function filterModelPickerGroups(
  searchIndex: ModelPickerSearchEntry[],
  query: string
): BaseModelPickerGroup[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return searchIndex.map((entry) => entry.group);
  }
  const q = trimmed.toLowerCase();
  const out: BaseModelPickerGroup[] = [];
  for (const entry of searchIndex) {
    if (entry.haystack.includes(q)) {
      out.push(entry.group);
    }
  }
  return out;
}

function findVariantForParams(
  group: ModelPickerGroup,
  current: PickerVariantParams,
  patch: PickerVariantParams
): ModelPickerVariant {
  const desired = { ...current, ...patch };
  const fields: Array<keyof PickerVariantParams> = [];
  if (group.contextOptions.length > 0) fields.push("context");
  if (group.reasoningOptions.length > 0) fields.push("reasoning");
  if (group.hasFastOption) fields.push("fast");

  const exact = group.variants.find((variant) =>
    fields.every((field) => {
      const wanted = field === "reasoning" ? desired.reasoning ?? "None" : desired[field];
      const got =
        field === "reasoning"
          ? variant.params.reasoning ?? "None"
          : field === "fast"
            ? variant.params.fast === true
            : variant.params[field];
      return got === wanted;
    })
  );
  if (exact) return exact;

  return [...group.variants].sort((a, b) => {
    const score = (variant: ModelPickerVariant) =>
      fields.reduce((sum, field) => {
        const wanted = field === "reasoning" ? desired.reasoning ?? "None" : desired[field];
        const got =
          field === "reasoning"
            ? variant.params.reasoning ?? "None"
            : field === "fast"
              ? variant.params.fast === true
              : variant.params[field];
        return sum + (got === wanted ? 1 : 0);
      }, 0);
    return score(b) - score(a);
  })[0] ?? group.defaultVariant;
}

type ModelPickerRowProps = {
  group: ModelPickerGroup;
  index: number;
  highlightedIndex: number;
  onSelect: (model: ModelInfo) => void;
  onHighlight: (index: number) => void;
  onEdit: (group: ModelPickerGroup, anchor: HTMLElement) => void;
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
  const editable =
    group.contextOptions.length > 0 ||
    group.reasoningOptions.length > 0 ||
    group.hasFastOption;
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
                : "opacity-0 group-hover:opacity-100"
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
  const { openSettingsView } = useShellView();
  const { updateWorkspaceSession } = useWorkspace();
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

  const showHarnessFlyoutUi = Boolean(
    backends && backends.length > 1 && onBackendChange
  );

  const openBackendSettings = useCallback(
    (targetBackendId: AgentBackendId) => {
      updateWorkspaceSession((current) => ({
        ...current,
        settingsView: {
          ...current.settingsView,
          activeNav: settingsNavForBackend(targetBackendId),
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

  useClickOutside(triggerRef, close, open, [popoverRef, harnessFlyoutRef, modelEditFlyoutRef]);

  useEffect(() => {
    if (open && ready && searchInputRef.current && shouldAutoFocusTextInput()) {
      searchInputRef.current.focus();
    }
  }, [open, ready]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [query]);

  /** Pre-index catalog when models change — not recomputed on each open/filter keystroke. */
  const searchIndex = useMemo(() => {
    const baseGroups = buildBaseModelPickerGroups(models);
    return buildModelPickerSearchIndex(baseGroups);
  }, [models]);

  const filteredBase = useMemo(
    () => filterModelPickerGroups(searchIndex, query),
    [searchIndex, query]
  );

  const filtered = useMemo(
    () => applySelectedToGroups(filteredBase, model),
    [filteredBase, model]
  );

  const modelGroups = useMemo(
    () => applySelectedToGroups(searchIndex.map((entry) => entry.group), model),
    [searchIndex, model]
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
      filtered.length === 0 ? 0 : Math.min(prev, filtered.length - 1)
    );
  }, [filtered.length]);

  const listMaxHeight = Math.max(
    96,
    Math.min(340, position.maxHeight - (showHarnessFlyoutUi ? 92 : 44))
  );

  const useVirtualList =
    listContentReady && filtered.length >= MODEL_LIST_VIRTUALIZE_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: useVirtualList ? filtered.length : 0,
    getScrollElement: () => listRef.current,
    estimateSize: () => MODEL_ROW_ESTIMATE_PX,
    overscan: 10,
    getItemKey: (index) => filtered[index]?.key ?? String(index),
  });

  useEffect(() => {
    if (!open || !listContentReady || openPerfRef.current == null) {
      return;
    }
    recordPerfSample("chat.model_dropdown.list_ready", openPerfRef.current, {
      backendId: backendId ?? null,
      groups: filtered.length,
      virtualized: useVirtualList,
    });
    openPerfRef.current = null;
  }, [backendId, filtered.length, listContentReady, open, useVirtualList]);

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
  }, [filtered.length, listContentReady, listMaxHeight, open, updateModelListFade, useVirtualList]);

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
          setHighlightedIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : prev));
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : prev));
          break;
        case "Enter":
          e.preventDefault();
          if (filtered[highlightedIndex]) {
            selectModel(filtered[highlightedIndex].defaultVariant.model);
          }
          break;
        case "Escape":
          e.preventDefault();
          if (modelEditFlyout) {
            setModelEditFlyout(null);
          } else if (harnessFlyoutOpen) {
            clearHarnessCloseTimer();
            setHarnessFlyoutOpen(false);
            setHarnessFlyoutPos(null);
          } else {
            close();
          }
          break;
      }
    },
    [
      open,
      filtered,
      highlightedIndex,
      selectModel,
      close,
      modelEditFlyout,
      harnessFlyoutOpen,
      clearHarnessCloseTimer,
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
    () => modelGroups.find((group) => group.key === modelEditFlyout?.groupKey) ?? null,
    [modelEditFlyout?.groupKey, modelGroups]
  );
  const activeEditGroupHasContext = (activeEditGroup?.contextOptions.length ?? 0) > 0;
  const activeEditGroupHasReasoning = (activeEditGroup?.reasoningOptions.length ?? 0) > 0;
  const activeEditGroupHasFast = activeEditGroup?.hasFastOption === true;

  const openModelEditFlyout = useCallback((group: ModelPickerGroup, anchor: HTMLElement) => {
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

  const selectedParamsForGroup = activeEditGroup?.selectedVariant?.params ??
    activeEditGroup?.defaultVariant.params ??
    {};

  const selectVariantParam = useCallback(
    (group: ModelPickerGroup, patch: PickerVariantParams) => {
      const current = group.selectedVariant?.params ?? group.defaultVariant.params;
      const next = findVariantForParams(group, current, patch);
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
        >
          <ModelBrandIcon model={model} className="size-[14px] shrink-0" strokeWidth={1.5} />
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
                  className="group min-w-0 shrink-0 border-b border-[var(--border-card)] p-[4px]"
                  onMouseEnter={openHarnessFlyoutNow}
                  onMouseLeave={scheduleCloseHarnessFlyout}
                >
                  <div className="flex min-w-0 items-center gap-[8px] rounded-[var(--radius-tab)] px-[6px] py-[3px] transition-colors group-hover:bg-[var(--accent-bg)]/60">
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
                {modelListFade.top ? (
                  <div
                    className="pointer-events-none absolute inset-x-0 top-0 z-[2] h-[24px]"
                    style={{
                      backgroundImage: "linear-gradient(to bottom, var(--bg-panel), transparent)",
                    }}
                    aria-hidden
                  />
                ) : null}
                {modelListFade.bottom ? (
                  <div
                    className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] h-[24px]"
                    style={{
                      backgroundImage: "linear-gradient(to top, var(--bg-panel), transparent)",
                    }}
                    aria-hidden
                  />
                ) : null}
                <div
                  ref={listRef}
                  className="hide-scrollbar-y min-h-0 flex-1 overflow-y-auto overscroll-contain px-[4px] py-[4px]"
                  style={{ maxHeight: listMaxHeight, overscrollBehaviorY: "contain" }}
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
                  ) : filtered.length === 0 ? (
                    <p className="px-[8px] py-[6px] font-sans text-[13px] text-[var(--text-disabled)]">
                      No models found
                    </p>
                  ) : useVirtualList ? (
                    <div
                      className="relative w-full"
                      style={{ height: `${virtualizer.getTotalSize()}px` }}
                    >
                      {virtualizer.getVirtualItems().map((item) => {
                        const group = filtered[item.index];
                        if (!group) {
                          return null;
                        }
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
                    filtered.map((group, index) => (
                      <ModelPickerRow
                        key={group.key}
                        group={group}
                        index={index}
                        highlightedIndex={highlightedIndex}
                        onSelect={selectModel}
                        onHighlight={setHighlightedIndex}
                        onEdit={openModelEditFlyout}
                      />
                    ))
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
            {activeEditGroupHasContext ? (
              <div
                className={`px-[4px] ${
                  activeEditGroupHasReasoning || activeEditGroupHasFast
                    ? "border-b border-[var(--border-card)] pb-[6px]"
                    : ""
                }`}
              >
                <div className="px-[8px] pb-[3px] font-sans text-[11px] font-medium text-[var(--text-disabled)]">
                  Context
                </div>
                {activeEditGroup.contextOptions.map((value) => {
                  const selected = selectedParamsForGroup.context === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      className={pickerOptionRowClass(selected, false)}
                      onClick={() => selectVariantParam(activeEditGroup, { context: value })}
                    >
                      <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-[var(--text-primary)]">
                        {value}
                      </span>
                      {selected ? <Check className="size-[13px]" strokeWidth={2} /> : null}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {activeEditGroupHasReasoning ? (
              <div
                className={`px-[4px] ${
                  activeEditGroupHasContext ? "pt-[6px]" : ""
                } ${activeEditGroupHasFast ? "border-b border-[var(--border-card)] pb-[6px]" : ""}`}
              >
                <div className="px-[8px] pb-[3px] font-sans text-[11px] font-medium text-[var(--text-disabled)]">
                  Reasoning
                </div>
                {activeEditGroup.reasoningOptions.map((value) => {
                  const selected = (selectedParamsForGroup.reasoning ?? "None") === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      className={pickerOptionRowClass(selected, false)}
                      onClick={() => selectVariantParam(activeEditGroup, { reasoning: value })}
                    >
                      <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-[var(--text-primary)]">
                        {value}
                      </span>
                      {selected ? <Check className="size-[13px]" strokeWidth={2} /> : null}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {activeEditGroupHasFast ? (
              <div className="px-[4px] pt-[6px]">
                <div className="px-[8px] pb-[3px] font-sans text-[11px] font-medium text-[var(--text-disabled)]">
                  Options
                </div>
                <div
                  className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[4px] text-left transition-colors hover:bg-[var(--accent-bg)]/60"
                >
                  <span
                    id="model-picker-fast-label"
                    className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-[var(--text-primary)]"
                  >
                    Fast
                  </span>
                  <ToggleSwitch
                    checked={selectedParamsForGroup.fast === true}
                    onChange={(checked) =>
                      selectVariantParam(activeEditGroup, { fast: checked })
                    }
                    size="sm"
                    labelledBy="model-picker-fast-label"
                  />
                </div>
              </div>
            ) : null}
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
            onMouseEnter={openHarnessFlyoutNow}
            onMouseLeave={scheduleCloseHarnessFlyout}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <span className="px-[10px] pb-[3px] pt-[2px] font-sans text-[11px] font-medium text-[var(--text-disabled)]">
              Harnesses
            </span>
            <div className="relative min-h-0 min-w-0">
              {harnessListFade.top ? (
                <div
                  className="pointer-events-none absolute inset-x-0 top-0 z-[2] h-[24px]"
                  style={{
                    backgroundImage:
                      "linear-gradient(to bottom, var(--bg-panel), transparent)",
                  }}
                  aria-hidden
                />
              ) : null}
              {harnessListFade.bottom ? (
                <div
                  className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] h-[24px]"
                  style={{
                    backgroundImage:
                      "linear-gradient(to top, var(--bg-panel), transparent)",
                  }}
                  aria-hidden
                />
              ) : null}
              <div
                ref={harnessListRef}
                className="hide-scrollbar-y max-h-[min(268px,calc(100vh-80px))] min-h-0 overflow-y-auto overscroll-contain px-[4px] py-[2px]"
                onScroll={updateHarnessListFade}
              >
              {(backends ?? []).map((backend) => {
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
                        onClick={() => openBackendSettings(backend.id)}
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
          </div>,
          document.body
        )}
    </>
  );
}