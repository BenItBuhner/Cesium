"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  FolderOpen,
  ScrollText,
} from "lucide-react";
import { CollapsibleHeight } from "./CollapsibleHeight";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import { inferEditorLanguageFromPath } from "@/lib/editor-language";
import { PermissionRequestCard } from "./PermissionRequestCard";
import { useAgentShellStateMaybe } from "@/components/agent/AgentShellStateContext";
import type { ChatMessage, WorkedSessionEntry, WorkedSessionEditPreview } from "@/lib/types";
import {
  formatToolFileLabel,
  resolveWorkspaceToolPath,
  toolPathBasename,
} from "@/lib/workspace-tool-path-display";

const iconWrap =
  "mt-[2px] flex size-[14px] shrink-0 items-center justify-center text-[var(--text-secondary)]";

const toolStatusClass: Record<
  NonNullable<Extract<WorkedSessionEntry, { kind: "tool" }>["status"]>,
  string
> = {
  pending:
    "border-[color-mix(in_srgb,var(--border-card)_80%,transparent)] bg-[color-mix(in_srgb,var(--bg-card)_82%,transparent)] text-[var(--text-secondary)]",
  running:
    "border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] text-[var(--accent-text)]",
  completed:
    "border-[color-mix(in_srgb,#4ade80_35%,transparent)] bg-[color-mix(in_srgb,#4ade80_12%,transparent)] text-[#86efac]",
  failed:
    "border-[color-mix(in_srgb,#fb7185_35%,transparent)] bg-[color-mix(in_srgb,#fb7185_12%,transparent)] text-[#fda4af]",
  cancelled:
    "border-[color-mix(in_srgb,#f59e0b_35%,transparent)] bg-[color-mix(in_srgb,#f59e0b_12%,transparent)] text-[#fcd34d]",
};

function isToolEntryActive(entry: WorkedSessionEntry): boolean {
  return (
    entry.kind === "tool" &&
    (entry.status === "pending" || entry.status === "running")
  );
}

interface WorkedSessionCardProps {
  label: string;
  entries: WorkedSessionEntry[];
  highlightedEntry?: Extract<WorkedSessionEntry, { kind: "tool" }>;
  /** When set with `onOpenChange`, expansion is controlled by the parent (persisted). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** @deprecated Use `open` + `onOpenChange`; still seeds uncontrolled initial state. */
  defaultOpen?: boolean;
  loading?: boolean;
  surface?: "panel" | "editor";
  /**
   * When false, header/tool loading shimmer only reflects local `loading` / active tools,
   * not “superseded” sessions after permission or a newer worked block.
   */
  isLiveWorkedTail?: boolean;
  /** Absolute workspace root; file lists show workspace-relative paths only. */
  workspaceRoot?: string | null;
  /**
   * When true (default), edit diffs highlighted for this card and optional embedded permission
   * render inside the collapsible tool list instead of above it in the main chat.
   */
  toolDetailsInWorkedCard?: boolean;
  /** Permission request message to render inside this card (adjacent in timeline). */
  embeddedPermission?: ChatMessage | null;
  onResolvePermission?: (requestId: string, optionId: string) => void;
  onCancelPermission?: (requestId: string) => void;
}

const ENTRY_LIST_MAX_HEIGHT = 240;
const TOOL_FILE_PREVIEW = 5;

const NEAR_BOTTOM_PX = 48;
const STICK_SETTLE_MS = 80;

/** Gray " (N found)" suffix when detail is only a match count (same line as title). */
function filesFoundSuffix(detail: string | undefined): string | null {
  if (!detail?.trim()) {
    return null;
  }
  const m = /^(\d+)\s+files?\s+matched$/i.exec(detail.trim());
  if (!m) {
    return null;
  }
  return ` (${m[1]} found)`;
}

/**
 * Formatted path strings already shown on the tool title line (Read/Update/Delete + path),
 * so listing them again under the title is redundant.
 */
function toolTitleDisplayedPathLabels(
  entry: Extract<WorkedSessionEntry, { kind: "tool" }>,
  workspaceRoot?: string | null
): Set<string> {
  const labels = new Set<string>();
  const t = entry.title.trim();
  const firstFile =
    entry.locations?.find((loc) => loc.path?.trim())?.path ??
    entry.files?.find((p) => p?.trim());
  const derivedRead =
    firstFile &&
    /^read file$/i.test(t) &&
    (formatToolFileLabel(firstFile, workspaceRoot ?? undefined) ?? toolPathBasename(firstFile));
  const derivedUpdate =
    firstFile &&
    /^update file$/i.test(t) &&
    (formatToolFileLabel(firstFile, workspaceRoot ?? undefined) ?? toolPathBasename(firstFile));
  const derivedDelete =
    firstFile &&
    /^delete file$/i.test(t) &&
    (formatToolFileLabel(firstFile, workspaceRoot ?? undefined) ?? toolPathBasename(firstFile));
  const effectiveTitle =
    (derivedRead && `Read ${derivedRead}`) ||
    (derivedUpdate && `Update ${derivedUpdate}`) ||
    (derivedDelete && `Delete ${derivedDelete}`) ||
    entry.title;
  const tEffective = effectiveTitle.trim();
  if (/^read file$/i.test(tEffective) || /^update file$/i.test(tEffective) || /^delete file$/i.test(tEffective)) {
    return labels;
  }
  const pathVerb = /^(Read|Update|Delete)\s+(.+)$/i.exec(tEffective);
  if (pathVerb?.[2]) {
    labels.add(pathVerb[2].trim());
  }
  return labels;
}

function renderToolTitleLine(
  entry: Extract<WorkedSessionEntry, { kind: "tool" }>,
  titleClass: string,
  workspaceRoot?: string | null
): ReactNode {
  const suffix = filesFoundSuffix(entry.detail);
  const t = entry.title.trim();
  /** If we have concrete paths but a generic verb-only title, derive a readable title. */
  const firstFile =
    entry.locations?.find((loc) => loc.path?.trim())?.path ??
    entry.files?.find((p) => p?.trim());
  const derivedRead =
    firstFile &&
    /^read file$/i.test(t) &&
    (formatToolFileLabel(firstFile, workspaceRoot ?? undefined) ?? toolPathBasename(firstFile));
  const derivedUpdate =
    firstFile &&
    /^update file$/i.test(t) &&
    (formatToolFileLabel(firstFile, workspaceRoot ?? undefined) ?? toolPathBasename(firstFile));
  const derivedDelete =
    firstFile &&
    /^delete file$/i.test(t) &&
    (formatToolFileLabel(firstFile, workspaceRoot ?? undefined) ?? toolPathBasename(firstFile));
  const effectiveTitle =
    (derivedRead && `Read ${derivedRead}`) ||
    (derivedUpdate && `Update ${derivedUpdate}`) ||
    (derivedDelete && `Delete ${derivedDelete}`) ||
    entry.title;
  const tEffective = effectiveTitle.trim();
  /** Avoid treating the literal word "file" as a path (generic "Read file" placeholder). */
  if (/^read file$/i.test(tEffective) || /^update file$/i.test(tEffective) || /^delete file$/i.test(tEffective)) {
    return (
      <p className={titleClass}>
        <span>{effectiveTitle}</span>
        {suffix ? (
          <span className="text-[var(--text-secondary)]">{suffix}</span>
        ) : null}
      </p>
    );
  }
  const pathVerb = /^(Read|Update|Delete)\s+(.+)$/i.exec(tEffective);
  if (pathVerb) {
    const verb = pathVerb[1]!;
    const pathPart = pathVerb[2]!;
    return (
      <p className={titleClass}>
        <span>{verb}</span>
        <span className="text-[var(--text-secondary)]"> {pathPart}</span>
        {suffix ? (
          <span className="text-[var(--text-secondary)]">{suffix}</span>
        ) : null}
      </p>
    );
  }

  const webDot = /^Web ·\s+(.+)$/i.exec(tEffective);
  if (webDot) {
    return (
      <p className={titleClass}>
        <span>Web · </span>
        <span className="text-[var(--text-secondary)]">{webDot[1]}</span>
        {suffix ? (
          <span className="text-[var(--text-secondary)]">{suffix}</span>
        ) : null}
      </p>
    );
  }

  return (
    <p className={titleClass}>
      <span>{effectiveTitle}</span>
      {suffix ? (
        <span className="text-[var(--text-secondary)]">{suffix}</span>
      ) : null}
    </p>
  );
}

function toolBlockDetail(entry: Extract<WorkedSessionEntry, { kind: "tool" }>): string | undefined {
  const d = entry.detail?.trim();
  if (!d) {
    return undefined;
  }
  if (/^updated\s+/i.test(d)) {
    return undefined;
  }
  if (filesFoundSuffix(entry.detail)) {
    return undefined;
  }
  return entry.detail;
}

function diffLineTone(kind: WorkedSessionEditPreview["lines"][number]["kind"]): string {
  switch (kind) {
    case "add":
      return "bg-[color-mix(in_srgb,var(--ask-accent)_24%,transparent)]";
    case "remove":
      return "bg-[color-mix(in_srgb,var(--debug-accent)_20%,transparent)]";
    case "gap":
      return "bg-[color-mix(in_srgb,var(--bg-card)_88%,transparent)] italic";
    default:
      return "";
  }
}

function diffLineTextClass(kind: WorkedSessionEditPreview["lines"][number]["kind"]): string {
  switch (kind) {
    case "add":
      return "text-[var(--ask-accent-dark)]";
    case "remove":
      return "text-[var(--debug-accent-dark)]";
    case "gap":
      return "text-[var(--text-secondary)]";
    default:
      return "text-[var(--text-secondary)]";
  }
}

function diffMarker(kind: WorkedSessionEditPreview["lines"][number]["kind"]): string {
  switch (kind) {
    case "add":
      return "+";
    case "remove":
      return "-";
    case "gap":
      return "\u2026";
    default:
      return "";
  }
}

function formatDiffLineNumber(value: number | undefined): string {
  return typeof value === "number" ? String(value) : "";
}

/** One column: no duplicate old/new gutters; context shows a single value or `old→new` when they diverge. */
function unifiedDiffLineNumber(line: WorkedSessionEditPreview["lines"][number]): string {
  switch (line.kind) {
    case "gap":
      return "";
    case "add":
      return formatDiffLineNumber(line.newLineNumber);
    case "remove":
      return formatDiffLineNumber(line.oldLineNumber);
    default: {
      const oldN = line.oldLineNumber;
      const newN = line.newLineNumber;
      if (typeof oldN === "number" && typeof newN === "number" && oldN !== newN) {
        return `${oldN}\u2192${newN}`;
      }
      return formatDiffLineNumber(oldN ?? newN);
    }
  }
}

function editPreviewPathLabel(preview: WorkedSessionEditPreview, workspaceRoot?: string | null): string | null {
  return preview.path
    ? formatToolFileLabel(preview.path, workspaceRoot ?? undefined) ?? toolPathBasename(preview.path)
    : null;
}

function filterFileRowsForEditPreview(
  rows: Array<{ raw: string; label: string }>,
  preview: WorkedSessionEditPreview | undefined,
  workspaceRoot?: string | null
): Array<{ raw: string; label: string }> {
  const primary = preview ? editPreviewPathLabel(preview, workspaceRoot) : null;
  if (!primary) {
    return rows;
  }
  return rows.filter((row) => row.label !== primary);
}

function ToolEditPreviewBlock({
  preview,
  workspaceRoot,
  onOpenFile,
}: {
  preview: WorkedSessionEditPreview;
  workspaceRoot?: string | null;
  onOpenFile?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const pathLabel = editPreviewPathLabel(preview, workspaceRoot);
  const defaultLines = 10;
  const showAll = expanded;
  const visibleLines = showAll ? preview.lines : preview.lines.slice(0, defaultLines);
  const hiddenLines = Math.max(0, preview.lines.length - visibleLines.length);
  const shellClass =
    "mt-[8px] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[color-mix(in_srgb,var(--bg-card)_82%,transparent)]";
  const openPath = preview.path ? resolveWorkspaceToolPath(preview.path, workspaceRoot ?? undefined) : null;

  return (
    <div className={shellClass}>
      <div className="flex items-center justify-between gap-[8px] border-b border-[var(--border-subtle)] px-[10px] py-[7px]">
        <div className="min-w-0 flex-1">
          {pathLabel && openPath && onOpenFile ? (
            <button
              type="button"
              onClick={() => onOpenFile(openPath)}
              className="truncate font-sans text-[12px] font-normal text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
              title={pathLabel}
            >
              {pathLabel}
            </button>
          ) : (
            <p className="truncate font-sans text-[12px] font-normal text-[var(--text-secondary)]">
              {pathLabel ?? "Edited file"}
            </p>
          )}
        </div>
        <div className="flex items-center gap-[6px] text-[11px]">
          <span className="font-mono text-[var(--ask-accent)]">+{preview.addedLines}</span>
          <span className="font-mono text-[var(--debug-accent)]">-{preview.removedLines}</span>
        </div>
      </div>
      {preview.lines.length > 0 ? (
        <div className="overflow-x-auto">
          <div className="min-w-full font-mono text-[12px] leading-relaxed">
            {visibleLines.map((line, index) => (
              <div
                key={`${line.kind}-${line.oldLineNumber ?? "x"}-${line.newLineNumber ?? "y"}-${index}`}
                className={`grid grid-cols-[0.875rem_minmax(2.25rem,max-content)_minmax(0,1fr)] items-baseline gap-x-[6px] py-[2px] pl-[6px] pr-[8px] ${diffLineTone(
                  line.kind
                )}`}
              >
                <span
                  className={`select-none text-right text-[11px] leading-[1.45] ${diffLineTextClass(line.kind)}`}
                >
                  {diffMarker(line.kind)}
                </span>
                <span
                  className={`select-none text-right tabular-nums text-[11px] leading-[1.45] text-[var(--text-secondary)] ${line.kind === "context" ? "opacity-90" : "opacity-95"}`}
                >
                  {unifiedDiffLineNumber(line)}
                </span>
                <pre
                  className={`min-w-0 whitespace-pre-wrap break-words text-[12px] leading-[1.45] text-[var(--text-primary)]`}
                >
                  {line.text || " "}
                </pre>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="px-[10px] py-[8px] font-sans text-[12px] text-[var(--text-secondary)]">
          Diff preview unavailable for this edit, but the change counts were captured.
        </p>
      )}
      {hiddenLines > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="w-full border-t border-[var(--border-subtle)] px-[10px] py-[7px] text-left font-sans text-[12px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        >
          {expanded ? "Show fewer diff lines" : `Show ${hiddenLines} more diff line${hiddenLines === 1 ? "" : "s"}`}
        </button>
      ) : null}
      {preview.truncated ? (
        <p className="border-t border-[var(--border-subtle)] px-[10px] py-[7px] font-sans text-[11px] text-[var(--text-tertiary)]">
          Diff preview was truncated to keep the transcript responsive.
        </p>
      ) : null}
    </div>
  );
}

function prefersScrollInstant(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function WorkedSessionCard({
  label,
  entries,
  highlightedEntry,
  open: controlledOpen,
  onOpenChange,
  defaultOpen = false,
  loading = false,
  surface = "panel",
  isLiveWorkedTail = true,
  workspaceRoot = null,
  toolDetailsInWorkedCard = true,
  embeddedPermission = null,
  onResolvePermission,
  onCancelPermission,
}: WorkedSessionCardProps) {
  const { openExplorerFile } = useOpenInEditor();
  const agentShell = useAgentShellStateMaybe();
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = isControlled ? controlledOpen! : uncontrolledOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (isControlled) {
        onOpenChange?.(next);
      } else {
        setUncontrolledOpen(next);
      }
    },
    [isControlled, onOpenChange]
  );
  const hasActiveTool = entries.some((entry) => isToolEntryActive(entry));
  const standaloneHighlighted = highlightedEntry?.editPreview ? highlightedEntry : undefined;
  const preferInside = toolDetailsInWorkedCard;
  const suppressEditPreviewForToolCallId =
    preferInside && standaloneHighlighted?.toolCallId ? standaloneHighlighted.toolCallId : undefined;
  const showLoadingState = loading || hasActiveTool;
  const shimmerLoading = showLoadingState && isLiveWorkedTail;
  const isWorkingPlaceholder = showLoadingState && entries.length === 0;
  const collapsibleOpen = isWorkingPlaceholder ? true : open;
  const gradientVar = surface === "editor" ? "var(--bg-main)" : "var(--bg-panel)";
  const inlineEditEntries =
    !preferInside && standaloneHighlighted ? [standaloneHighlighted] : [];
  const hasCollapsibleEntries = entries.length > 0 || isWorkingPlaceholder;
  const embeddedPermissionCard =
    preferInside && embeddedPermission?.type === "permission-request"
      ? embeddedPermission
      : null;
  const hasUnresolvedEmbeddedPermission = Boolean(
    embeddedPermissionCard && !embeddedPermissionCard.permissionResolved
  );
  const insideDetailBlocks =
    preferInside &&
    (embeddedPermissionCard != null || Boolean(standaloneHighlighted?.editPreview));
  const prevMessageLoadingRef = useRef(loading);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentMeasureRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const stickSettleTimerRef = useRef<number | null>(null);
  const touchLastYRef = useRef<number | null>(null);
  const [showTopGrad, setShowTopGrad] = useState(false);
  const [showBottomGrad, setShowBottomGrad] = useState(false);

  const handleOpenToolFile = useCallback(
    (path: string) => {
      if (agentShell && !agentShell.rightPaneOpen) {
        agentShell.setRightPaneOpen(true);
      }
      const language = inferEditorLanguageFromPath(path) ?? "plaintext";
      const lower = path.toLowerCase();
      const icon =
        language === "css"
          ? "css"
          : language === "json"
            ? "json"
            : language === "markdown"
              ? "markdown"
              : ["typescript", "javascript"].includes(language) || /\.(ts|tsx|js|jsx)$/.test(lower)
                ? "typescript"
                : "default";
      openExplorerFile({
        path,
        name: toolPathBasename(path),
        language,
        icon,
      });
    },
    [agentShell, openExplorerFile]
  );

  // Collapse only when the *message-level* working placeholder (`loading`) clears — not when an
  // individual tool flips running→completed (that falsely fired for file-edit and other fast tools).
  useEffect(() => {
    if (prevMessageLoadingRef.current && !loading) {
      if (!hasUnresolvedEmbeddedPermission) {
        setOpen(false);
      }
    }
    prevMessageLoadingRef.current = loading;
  }, [hasUnresolvedEmbeddedPermission, loading, setOpen]);

  const updateGradients = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atTop = el.scrollTop > 2;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight > 2;
    setShowTopGrad(atTop);
    setShowBottomGrad(atBottom);
  }, []);

  const clearStickSettleTimer = useCallback(() => {
    if (stickSettleTimerRef.current != null) {
      window.clearTimeout(stickSettleTimerRef.current);
      stickSettleTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!collapsibleOpen) {
      clearStickSettleTimer();
    }
  }, [collapsibleOpen, clearStickSettleTimer]);

  const scheduleStickToBottomSettle = useCallback(
    (el: HTMLDivElement) => {
      if (stickSettleTimerRef.current != null) {
        window.clearTimeout(stickSettleTimerRef.current);
      }
      stickSettleTimerRef.current = window.setTimeout(() => {
        stickSettleTimerRef.current = null;
        const nearBottom =
          el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
        stickToBottomRef.current = nearBottom;
      }, STICK_SETTLE_MS);
    },
    []
  );

  const scrollListToBottomIfFollowing = useCallback(() => {
    const el = scrollRef.current;
    if (!collapsibleOpen || !el || !stickToBottomRef.current) {
      return;
    }
    const behavior = prefersScrollInstant() ? ("auto" as const) : ("smooth" as const);
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, [collapsibleOpen]);

  useLayoutEffect(() => {
    if (!collapsibleOpen) {
      return;
    }
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    stickToBottomRef.current = nearBottom;
  }, [collapsibleOpen]);

  useEffect(() => {
    if (!collapsibleOpen) return;
    updateGradients();
  }, [entries, collapsibleOpen, updateGradients]);

  useEffect(() => {
    if (!collapsibleOpen) return;
    const scrollEl = scrollRef.current;
    const contentEl = contentMeasureRef.current;
    if (!scrollEl || !contentEl) return;

    const ro = new ResizeObserver(() => {
      scrollListToBottomIfFollowing();
      updateGradients();
    });
    ro.observe(contentEl);
    return () => ro.disconnect();
  }, [collapsibleOpen, scrollListToBottomIfFollowing, updateGradients]);

  useEffect(
    () => () => {
      clearStickSettleTimer();
    },
    [clearStickSettleTimer]
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (e.deltaY < -0.5) {
        stickToBottomRef.current = false;
        clearStickSettleTimer();
      }
    },
    [clearStickSettleTimer]
  );

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    touchLastYRef.current = e.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMove = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const y = e.touches[0]?.clientY;
      if (y == null || touchLastYRef.current == null) return;
      if (y - touchLastYRef.current > 12) {
        stickToBottomRef.current = false;
        clearStickSettleTimer();
      }
      touchLastYRef.current = y;
    },
    [clearStickSettleTimer]
  );

  const handleTouchEnd = useCallback(() => {
    touchLastYRef.current = null;
  }, []);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      scheduleStickToBottomSettle(el);
      updateGradients();
    },
    [scheduleStickToBottomSettle, updateGradients]
  );

  return (
    <div className="min-w-0 px-[1px]">
      {isWorkingPlaceholder ? (
        <div className="flex w-full min-w-0 items-center gap-[6px] text-left text-[var(--text-secondary)]">
          <span
            className={`font-sans text-[13px] font-normal leading-snug ${
              shimmerLoading ? "tool-loading-text" : ""
            }`}
          >
            {label}
          </span>
        </div>
      ) : hasCollapsibleEntries ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex w-full min-w-0 cursor-pointer items-center gap-[6px] text-left text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        >
          <span
            className={`font-sans text-[13px] font-normal leading-snug ${
              shimmerLoading ? "tool-loading-text" : ""
            }`}
          >
            {label}
          </span>
          <ChevronDown
            className={`size-[14px] shrink-0 transition-transform duration-300 ease-[cubic-bezier(0.33,1,0.68,1)] motion-reduce:transition-none ${
              open ? "rotate-180" : ""
            }`}
            strokeWidth={1.75}
            aria-hidden
          />
        </button>
      ) : (
        <div className="flex w-full min-w-0 items-center gap-[6px] text-left text-[var(--text-secondary)]">
          <span className="font-sans text-[13px] font-normal leading-snug text-[var(--text-secondary)]">
            {label}
          </span>
        </div>
      )}

      {inlineEditEntries.length > 0 ? (
        <div className="pt-[8px]">
          {inlineEditEntries.map((entry) =>
            entry.editPreview ? (
              <ToolEditPreviewBlock
                key={`inline-diff-${entry.toolCallId ?? entry.title}`}
                preview={entry.editPreview}
                workspaceRoot={workspaceRoot}
                onOpenFile={handleOpenToolFile}
              />
            ) : null
          )}
        </div>
      ) : null}

      {!hasCollapsibleEntries && insideDetailBlocks ? (
        <div className="flex flex-col gap-[10px] pt-[8px]">
          {embeddedPermissionCard ? (
            <PermissionRequestCard
              title={embeddedPermissionCard.permissionTitle ?? "Permission required"}
              detail={embeddedPermissionCard.permissionDetail}
              options={embeddedPermissionCard.permissionOptions ?? []}
              resolved={embeddedPermissionCard.permissionResolved}
              selectedOptionId={embeddedPermissionCard.permissionSelectedOptionId}
              onSelect={(optionId) => {
                if (!embeddedPermissionCard.permissionRequestId) {
                  return;
                }
                onResolvePermission?.(embeddedPermissionCard.permissionRequestId, optionId);
              }}
              onCancel={
                embeddedPermissionCard.permissionRequestId && onCancelPermission
                  ? () => onCancelPermission(embeddedPermissionCard.permissionRequestId!)
                  : undefined
              }
            />
          ) : null}
          {standaloneHighlighted?.editPreview ? (
            <ToolEditPreviewBlock
              key={`inline-diff-${standaloneHighlighted.toolCallId ?? standaloneHighlighted.title}`}
              preview={standaloneHighlighted.editPreview}
              workspaceRoot={workspaceRoot}
              onOpenFile={handleOpenToolFile}
            />
          ) : null}
        </div>
      ) : null}

      {hasCollapsibleEntries ? (
        <CollapsibleHeight open={collapsibleOpen}>
          <div className="relative pt-[10px]">
            {insideDetailBlocks ? (
              <div className="mb-[10px] flex flex-col gap-[10px]">
                {embeddedPermissionCard ? (
                  <PermissionRequestCard
                    title={embeddedPermissionCard.permissionTitle ?? "Permission required"}
                    detail={embeddedPermissionCard.permissionDetail}
                    options={embeddedPermissionCard.permissionOptions ?? []}
                    resolved={embeddedPermissionCard.permissionResolved}
                    selectedOptionId={embeddedPermissionCard.permissionSelectedOptionId}
                    onSelect={(optionId) => {
                      if (!embeddedPermissionCard.permissionRequestId) {
                        return;
                      }
                      onResolvePermission?.(embeddedPermissionCard.permissionRequestId, optionId);
                    }}
                    onCancel={
                      embeddedPermissionCard.permissionRequestId && onCancelPermission
                        ? () => onCancelPermission(embeddedPermissionCard.permissionRequestId!)
                        : undefined
                    }
                  />
                ) : null}
                {standaloneHighlighted?.editPreview ? (
                  <ToolEditPreviewBlock
                    key={`collapsible-diff-${standaloneHighlighted.toolCallId ?? standaloneHighlighted.title}`}
                    preview={standaloneHighlighted.editPreview}
                    workspaceRoot={workspaceRoot}
                    onOpenFile={handleOpenToolFile}
                  />
                ) : null}
              </div>
            ) : null}
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              onWheel={handleWheel}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              onTouchCancel={handleTouchEnd}
              className="ml-[2px] border-l border-[var(--border-subtle)] pl-[10px] overflow-y-auto hide-scrollbar-y"
              style={{ maxHeight: ENTRY_LIST_MAX_HEIGHT }}
            >
              <div ref={contentMeasureRef} className="flex flex-col gap-[14px]">
                {entries.map((entry, i) => (
                <WorkedEntryBlock
                  key={
                    entry.kind === "tool"
                      ? entry.toolCallId ?? `tool-${i}-${entry.title}`
                      : `${entry.kind}-${i}`
                  }
                  entry={entry}
                  isLiveWorkedTail={isLiveWorkedTail}
                  workspaceRoot={workspaceRoot}
                  onOpenToolFile={handleOpenToolFile}
                  suppressEditPreviewForToolCallId={suppressEditPreviewForToolCallId}
                />
              ))}
              </div>
            </div>
            {showTopGrad ? (
              <div
                className="pointer-events-none absolute inset-x-0 top-[10px] ml-[2px] h-[28px] z-[1] bg-gradient-to-b to-transparent"
                style={{ backgroundImage: `linear-gradient(to bottom, ${gradientVar}, transparent)` }}
              />
            ) : null}
            {showBottomGrad ? (
              <div
                className="pointer-events-none absolute inset-x-0 bottom-0 ml-[2px] h-[28px] z-[1] bg-gradient-to-b from-transparent"
                style={{ backgroundImage: `linear-gradient(to bottom, transparent, ${gradientVar})` }}
              />
            ) : null}
          </div>
        </CollapsibleHeight>
      ) : null}
    </div>
  );
}

function WorkedEntryBlock({
  entry,
  isLiveWorkedTail,
  workspaceRoot,
  onOpenToolFile,
  suppressEditPreviewForToolCallId,
}: {
  entry: WorkedSessionEntry;
  isLiveWorkedTail: boolean;
  workspaceRoot: string | null;
  onOpenToolFile: (path: string) => void;
  suppressEditPreviewForToolCallId?: string;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      className={`transition-all duration-300 ease-out motion-reduce:transition-none motion-reduce:opacity-100 motion-reduce:translate-y-0 ${
        visible ? "translate-y-0 opacity-100" : "translate-y-[6px] opacity-0"
      }`}
    >
      {renderEntry(
        entry,
        isLiveWorkedTail,
        workspaceRoot,
        onOpenToolFile,
        suppressEditPreviewForToolCallId
      )}
    </div>
  );
}

function renderEntry(
  entry: WorkedSessionEntry,
  isLiveWorkedTail: boolean,
  workspaceRoot: string | null,
  onOpenToolFile: (path: string) => void,
  suppressEditPreviewForToolCallId?: string
) {
  switch (entry.kind) {
    case "verbatim":
      return (
        <div className="flex gap-[8px]">
          <span className={iconWrap}>
            <ScrollText className="size-[14px]" strokeWidth={1.5} aria-hidden />
          </span>
          <pre className="whitespace-pre-wrap font-mono text-[12px] font-normal leading-relaxed text-[var(--text-secondary)]">
            {entry.text}
          </pre>
        </div>
      );
    case "explore": {
      const exploreRows = entry.paths
        .map((path) => ({
          raw: path,
          label: formatToolFileLabel(path, workspaceRoot ?? undefined),
        }))
        .filter((row): row is { raw: string; label: string } => Boolean(row.label));
      const explorePreview = exploreRows.slice(0, TOOL_FILE_PREVIEW);
      const exploreExtra = exploreRows.length - explorePreview.length;
      return (
        <div className="flex gap-[8px]">
          <span className={iconWrap}>
            <FolderOpen className="size-[14px]" strokeWidth={1.5} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-sans text-[12px] font-medium text-[var(--text-secondary)]">
              {entry.caption ??
                `Explored ${entry.paths.length} file${entry.paths.length === 1 ? "" : "s"}`}
            </p>
            {explorePreview.length > 0 ? (
              <ul className="mt-[6px] flex list-none flex-col gap-[4px]">
                {explorePreview.map((row) => (
                  <li
                    key={row.raw}
                    className="font-sans text-[12px] font-normal leading-snug text-[var(--text-secondary)]"
                  >
                    {row.label}
                  </li>
                ))}
                {exploreExtra > 0 ? (
                  <li className="font-sans text-[12px] font-normal leading-snug text-[var(--text-secondary)]">
                    +{exploreExtra} more
                  </li>
                ) : null}
              </ul>
            ) : null}
          </div>
        </div>
      );
    }
    case "reasoning":
      return (
        <div className="flex gap-[8px]">
          <div className="min-w-0 flex-1">
            <p className="font-sans text-[13px] font-normal leading-relaxed text-[var(--text-primary)]">
              <span className="text-[var(--text-secondary)]">Thought: </span>
              {entry.text}
            </p>
          </div>
        </div>
      );
    case "assistant_inline":
      return (
        <div className="flex gap-[8px]">
          <div className="min-w-0 flex-1">
            <p className="font-sans text-[13px] font-normal leading-relaxed text-[var(--text-primary)]">
              {entry.text}
            </p>
          </div>
        </div>
      );
    case "tool": {
      const active = isToolEntryActive(entry);
      const statusKey =
        entry.status === "failed" || entry.status === "cancelled"
          ? entry.status
          : null;
      const fileRows =
        (entry.locations && entry.locations.length > 0
          ? entry.locations.map((location) => {
              const baseLabel = formatToolFileLabel(location.path, workspaceRoot ?? undefined);
              if (!baseLabel) {
                return null;
              }
              return {
                raw: `${location.path}:${location.line ?? ""}`,
                label:
                  typeof location.line === "number"
                    ? `${baseLabel}:${location.line}`
                    : baseLabel,
              };
            })
          : entry.files?.map((raw) => ({
              raw,
              label: formatToolFileLabel(raw, workspaceRoot ?? undefined),
            })) ?? [])
          .filter((row): row is { raw: string; label: string } => Boolean(row?.label))
          .filter((row, index, all) => all.findIndex((candidate) => candidate.label === row.label) === index);
      const filteredFileRows = filterFileRowsForEditPreview(fileRows, entry.editPreview, workspaceRoot);
      const titlePaths = toolTitleDisplayedPathLabels(entry, workspaceRoot);
      const listFileRows =
        titlePaths.size > 0
          ? filteredFileRows.filter((row) => !titlePaths.has(row.label.trim()))
          : filteredFileRows;
      const previewFiles = listFileRows.slice(0, TOOL_FILE_PREVIEW);
      const extraFileCount = listFileRows.length - previewFiles.length;
      const titleTone =
        active && isLiveWorkedTail
          ? "tool-loading-text"
          : active
            ? "text-[var(--text-primary)]"
            : entry.status === "failed"
              ? "text-[#fda4af]"
              : entry.status === "cancelled"
                ? "text-[#fcd34d]"
                : "text-[var(--text-primary)]";
      const titleClass = `font-sans text-[13px] font-normal leading-snug ${titleTone}`;
      const extraDetail = toolBlockDetail(entry);
      return (
        <div className="flex gap-[8px]">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-[8px]">
              {renderToolTitleLine(entry, titleClass, workspaceRoot)}
              {statusKey ? (
                <span
                  className={`rounded-full border px-[7px] py-[1px] font-sans text-[10px] font-medium uppercase tracking-[0.08em] ${toolStatusClass[statusKey]}`}
                >
                  {statusKey}
                </span>
              ) : null}
            </div>
            {extraDetail ? (
              <p className="mt-[4px] line-clamp-4 font-sans text-[12px] font-normal leading-relaxed text-[var(--text-secondary)]">
                {extraDetail}
              </p>
            ) : null}
            {entry.editPreview &&
            entry.toolCallId !== suppressEditPreviewForToolCallId ? (
              <ToolEditPreviewBlock
                preview={entry.editPreview}
                workspaceRoot={workspaceRoot}
                onOpenFile={onOpenToolFile}
              />
            ) : null}
            {previewFiles.length > 0 ? (
              <ul className="mt-[6px] flex list-none flex-col gap-[4px]">
                {previewFiles.map((row) => (
                  <li
                    key={row.raw}
                    className="font-sans text-[12px] font-normal leading-snug text-[var(--text-secondary)]"
                  >
                    {row.label}
                  </li>
                ))}
                {extraFileCount > 0 ? (
                  <li className="font-sans text-[12px] font-normal leading-snug text-[var(--text-secondary)]">
                    +{extraFileCount} more
                  </li>
                ) : null}
              </ul>
            ) : null}
          </div>
        </div>
      );
    }
  }
}
