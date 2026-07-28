"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Ban,
  Check,
  ChevronDown,
  Circle,
  CircleHelp,
  FilePlus2,
  FileText,
  FolderOpen,
  Globe,
  ListTodo,
  LoaderCircle,
  Plug,
  ScrollText,
  Search,
  SquarePen,
  SquareTerminal,
  Target,
  TextSearch,
  Trash2,
  Wrench,
} from "lucide-react";
import { CollapsibleHeight } from "./CollapsibleHeight";
import { useTheme } from "@/components/theme/ThemeProvider";
import type { EditDiffRenderingMode } from "@/lib/theme-config";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import { TOOL_CALL_DROPDOWN_MAX_HEIGHT_DEFAULT_PX } from "@/lib/theme-config";
import { inferEditorLanguageFromPath } from "@/lib/editor-language";
import { HorizontalFadedScroll } from "./HorizontalFadedScroll";
import { PermissionRequestCard } from "./PermissionRequestCard";
import type { ChatMessage, TodoItem, WorkedSessionEntry, WorkedSessionEditPreview } from "@/lib/types";
import { isAgentTodoJsonDetailString } from "@/lib/agent-chat";
import {
  formatToolFileLabel,
  resolveWorkspaceToolPath,
  toolPathBasename,
} from "@/lib/workspace-tool-path-display";

const iconWrap =
  "mt-[2px] flex size-[14px] shrink-0 items-center justify-center text-[var(--text-secondary)]";

/** Subtle per-kind glyph so tool rows scan visually instead of reading as a wall of text. */
function toolEntryIcon(entry: Extract<WorkedSessionEntry, { kind: "tool" }>): ReactNode {
  const kind = entry.toolKind ?? "";
  const title = entry.title.trim();
  const iconProps = { className: "size-[13px]", strokeWidth: 1.5, "aria-hidden": true } as const;
  if (kind === "todo" || (entry.todos?.length ?? 0) > 0) {
    return <ListTodo {...iconProps} />;
  }
  if (kind === "terminal" || entry.variant === "terminal" || /^ran\b/i.test(title)) {
    return <SquareTerminal {...iconProps} />;
  }
  if (kind === "grep" || /^grep\b/i.test(title)) {
    return <TextSearch {...iconProps} />;
  }
  if (kind === "search" || /^find\b/i.test(title)) {
    return <Search {...iconProps} />;
  }
  if (kind === "search_web" || kind === "fetch" || /^web(\s*·|\s+search)/i.test(title)) {
    return <Globe {...iconProps} />;
  }
  if (kind === "delete" || /^delete\b/i.test(title)) {
    return <Trash2 {...iconProps} />;
  }
  if (/^create\b/i.test(title)) {
    return <FilePlus2 {...iconProps} />;
  }
  if (
    kind === "edit" ||
    kind === "write" ||
    entry.editPreview != null ||
    /^(update|edit|write)\b/i.test(title)
  ) {
    return <SquarePen {...iconProps} />;
  }
  if (kind === "read" || /^read\b/i.test(title)) {
    return <FileText {...iconProps} />;
  }
  if (kind === "mcp") {
    return <Plug {...iconProps} />;
  }
  if (kind === "goal") {
    return <Target {...iconProps} />;
  }
  if (kind === "question" || kind === "ask") {
    return <CircleHelp {...iconProps} />;
  }
  return <Wrench {...iconProps} />;
}

/** Compact 13px status glyphs matching {@link TodoCard}'s visual language. */
function WorkedTodoStatusIcon({ status }: { status: TodoItem["status"] }) {
  if (status === "in_progress") {
    return (
      <LoaderCircle
        className="size-[13px] shrink-0 animate-spin text-[var(--text-secondary)]"
        strokeWidth={1.5}
        aria-hidden
      />
    );
  }
  if (status === "completed") {
    return (
      <Check className="size-[13px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.75} aria-hidden />
    );
  }
  if (status === "blocked") {
    return <Ban className="size-[13px] shrink-0 text-[#f59e0b]" strokeWidth={1.5} aria-hidden />;
  }
  return (
    <Circle className="size-[13px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.5} aria-hidden />
  );
}

function WorkedTodoChecklist({ todos }: { todos: TodoItem[] }) {
  return (
    <ul className="mt-[6px] flex list-none flex-col gap-[5px]">
      {todos.map((todo) => (
        <li key={todo.id} className="flex items-start gap-[7px]">
          <span className="mt-[2px] shrink-0">
            <WorkedTodoStatusIcon status={todo.status} />
          </span>
          <span
            className={`min-w-0 font-sans text-[12px] font-normal leading-snug ${
              todo.status === "pending"
                ? "text-[var(--text-secondary)]"
                : "text-[var(--text-primary)]"
            }`}
          >
            {todo.status === "blocked" ? (
              <span className="mr-[5px] text-[#f59e0b]">Blocked:</span>
            ) : null}
            {todo.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Raw payload dropdowns render one-line JSON args as indented JSON for readability. */
function formatRawDetailForDisplay(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return raw;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return raw;
  }
}

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
  /** Primary edit row: when `toolDetailsInWorkedCard` is false, diff renders in the main stream. */
  highlightedEntry?: Extract<WorkedSessionEntry, { kind: "tool" }>;
  /** When set with `onOpenChange`, expansion is controlled by the parent (persisted). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Seeds uncontrolled initial open when parent does not pass `open`. */
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
  onResolvePermission?: (requestId: string, optionId: string, commandHint?: string) => void;
  /** When false, tool list uses flat layout without left rail indent (settled turn). */
  contentRail?: boolean;
  /** Turn finished — card should collapse when this becomes true. */
  settled?: boolean;
}

const TOOL_FILE_PREVIEW = 5;

function isContextCompressionLabel(label: string): boolean {
  return label === "Compressing context" || label === "Compressed context";
}

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
    /^read( file)?$/i.test(t) &&
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
  if (
    /^read( file)?$/i.test(tEffective) ||
    /^update file$/i.test(tEffective) ||
    /^delete file$/i.test(tEffective)
  ) {
    return labels;
  }
  const pathVerb = /^(Read|Update|Create|Write|Delete)\s+(.+)$/i.exec(tEffective);
  if (pathVerb?.[2]) {
    labels.add(pathVerb[2].trim());
  }
  return labels;
}

function renderToolTitleLine(
  entry: Extract<WorkedSessionEntry, { kind: "tool" }>,
  titleClass: string,
  workspaceRoot?: string | null,
  groupHoverMuted?: boolean
): ReactNode {
  const mc = (base: string) =>
    groupHoverMuted
      ? `${base} transition-colors group-hover:text-[var(--text-primary)]`
      : base;
  const muted = mc("text-[var(--text-secondary)]");

  if (entry.todos && entry.todos.length > 0) {
    const done = entry.todos.filter((todo) => todo.status === "completed").length;
    return (
      <span className={`${titleClass} block min-w-0`}>
        <span>{entry.title}</span>
        <span className={muted}>{` · ${done}/${entry.todos.length} done`}</span>
      </span>
    );
  }

  const suffix = filesFoundSuffix(entry.detail);
  const t = entry.title.trim();
  /** If we have concrete paths but a generic verb-only title, derive a readable title. */
  const firstFile =
    entry.locations?.find((loc) => loc.path?.trim())?.path ??
    entry.files?.find((p) => p?.trim());
  const derivedRead =
    firstFile &&
    /^read( file)?$/i.test(t) &&
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
  if (
    /^read( file)?$/i.test(tEffective) ||
    /^update file$/i.test(tEffective) ||
    /^delete file$/i.test(tEffective)
  ) {
    return (
      <span className={`${titleClass} block min-w-0`}>
        <span>{effectiveTitle}</span>
        {suffix ? <span className={muted}>{suffix}</span> : null}
      </span>
    );
  }
  const pathVerb = /^(Read|Update|Create|Write|Delete)\s+(.+)$/i.exec(tEffective);
  if (pathVerb) {
    const verb = pathVerb[1]!;
    const pathPart = pathVerb[2]!;
    return (
      <span className={`${titleClass} block min-w-0`}>
        <span>{verb}</span>
        <span className={muted}> {pathPart}</span>
        {suffix ? <span className={muted}>{suffix}</span> : null}
      </span>
    );
  }

  const webDot = /^Web ·\s+(.+)$/i.exec(tEffective);
  if (webDot) {
    return (
      <span className={`${titleClass} block min-w-0`}>
        <span>Web · </span>
        <span className={muted}>{webDot[1]}</span>
        {suffix ? <span className={muted}>{suffix}</span> : null}
      </span>
    );
  }

  const ranCommand = /^Ran\s+(.+)$/i.exec(tEffective);
  if (ranCommand) {
    return (
      <span className={`${titleClass} block min-w-0`}>
        <span>Ran </span>
        <span className={`${muted} font-mono text-[12px]`}>{ranCommand[1]}</span>
        {suffix ? <span className={muted}>{suffix}</span> : null}
      </span>
    );
  }

  return (
    <span className={`${titleClass} block min-w-0`}>
      <span>{effectiveTitle}</span>
      {suffix ? <span className={muted}>{suffix}</span> : null}
    </span>
  );
}

function toolBlockDetail(entry: Extract<WorkedSessionEntry, { kind: "tool" }>): string | undefined {
  const d = entry.detail?.trim();
  if (!d) {
    return undefined;
  }
  if (isAgentTodoJsonDetailString(d)) {
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
      return "bg-[var(--ask-accent-bg)]";
    case "remove":
      return "bg-[var(--debug-accent-bg)]";
    case "gap":
      return "bg-[color-mix(in_srgb,var(--bg-card)_72%,var(--bg-panel)_28%)]";
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

function filterFileRowsForEditPreview<T extends { label: string }>(
  rows: T[],
  preview: WorkedSessionEditPreview | undefined,
  workspaceRoot?: string | null
): T[] {
  const primary = preview ? editPreviewPathLabel(preview, workspaceRoot) : null;
  if (!primary) {
    return rows;
  }
  return rows.filter((row) => row.label !== primary);
}

function MinimalToolEditPreviewBlock({
  preview,
  workspaceRoot,
  onOpenFile,
}: {
  preview: WorkedSessionEditPreview;
  workspaceRoot?: string | null;
  onOpenFile?: (path: string) => void;
}) {
  const pathLabel = editPreviewPathLabel(preview, workspaceRoot) ?? "file";
  const openPath = preview.path ? resolveWorkspaceToolPath(preview.path, workspaceRoot ?? undefined) : null;

  return (
    <div className="mt-[6px] flex min-w-0 flex-wrap items-baseline gap-x-[6px] font-sans text-[12px] leading-snug">
      <span className="shrink-0 text-[var(--text-secondary)]">Edited</span>
      {openPath && onOpenFile ? (
        <button
          type="button"
          onClick={() => onOpenFile(openPath)}
          className="min-w-0 truncate text-[var(--text-primary)] transition-colors hover:text-[var(--text-secondary)]"
          title={pathLabel}
        >
          {pathLabel}
        </button>
      ) : (
        <span className="min-w-0 truncate text-[var(--text-primary)]" title={pathLabel}>
          {pathLabel}
        </span>
      )}
      <span className="shrink-0 font-mono text-[var(--ask-accent)]">+{preview.addedLines}</span>
      <span className="shrink-0 font-mono text-[var(--debug-accent)]">-{preview.removedLines}</span>
    </div>
  );
}

function FullToolEditPreviewBlock({
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

  const isCollapsedGapOrPlaceholder = (line: WorkedSessionEditPreview["lines"][number]) => {
    if (line.kind !== "gap") {
      return false;
    }
    const t = line.text?.trim() ?? "";
    if (!t) {
      return true;
    }
    if (/^_+$/.test(t) || t === "…" || t === "..." || /^[·.]+$/.test(t)) {
      return true;
    }
    return false;
  };
  const shellClass =
    "mt-[8px] overflow-hidden rounded-[var(--agent-card-radius)] border border-[var(--agent-border)] bg-[color-mix(in_srgb,var(--agent-card-bg)_82%,transparent)]";
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
            {visibleLines.map((line, index) => {
              if (isCollapsedGapOrPlaceholder(line)) {
                return (
                  <div
                    key={`gap-skip-${line.oldLineNumber ?? "x"}-${line.newLineNumber ?? "y"}-${index}`}
                    className="h-[1px] bg-[var(--border-subtle)]/70"
                    aria-hidden
                  />
                );
              }
              return (
                <div
                  key={`${line.kind}-${line.oldLineNumber ?? "x"}-${line.newLineNumber ?? "y"}-${index}`}
                  className={`grid grid-cols-[0.6rem_1.75rem_minmax(0,1fr)] items-baseline gap-x-[4px] py-[1px] pl-[4px] pr-[6px] ${diffLineTone(
                    line.kind
                  )}`}
                >
                  <span
                    className={`select-none text-right text-[10px] leading-[1.45] ${diffLineTextClass(line.kind)}`}
                  >
                    {diffMarker(line.kind)}
                  </span>
                  <span
                    className={`select-none text-right tabular-nums text-[10px] leading-[1.45] text-[var(--text-secondary)] ${line.kind === "context" ? "opacity-90" : "opacity-95"}`}
                  >
                    {unifiedDiffLineNumber(line)}
                  </span>
                  <pre
                    className={`min-w-0 whitespace-pre-wrap break-words text-[12px] leading-[1.45] text-[var(--text-primary)]`}
                  >
                    {line.text || " "}
                  </pre>
                </div>
              );
            })}
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

function ToolEditPreviewBlock({
  preview,
  workspaceRoot,
  onOpenFile,
  renderingMode = "full",
}: {
  preview: WorkedSessionEditPreview;
  workspaceRoot?: string | null;
  onOpenFile?: (path: string) => void;
  renderingMode?: EditDiffRenderingMode;
}) {
  if (renderingMode === "counts") {
    return (
      <MinimalToolEditPreviewBlock
        preview={preview}
        workspaceRoot={workspaceRoot}
        onOpenFile={onOpenFile}
      />
    );
  }
  return (
    <FullToolEditPreviewBlock
      preview={preview}
      workspaceRoot={workspaceRoot}
      onOpenFile={onOpenFile}
    />
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
  contentRail = true,
  settled = false,
}: WorkedSessionCardProps) {
  const { themeConfig } = useTheme();
  const entryListMaxHeightPx =
    themeConfig.toolCallDropdownMaxHeightPx ?? TOOL_CALL_DROPDOWN_MAX_HEIGHT_DEFAULT_PX;
  const editDiffRenderingMode = themeConfig.editDiffRenderingMode ?? "full";
  const { openExplorerFile } = useOpenInEditor();
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
  const showLoadingState = loading || hasActiveTool;
  const shimmerLoading = showLoadingState && isLiveWorkedTail;
  const isContextCompression =
    isContextCompressionLabel(label) ||
    entries.some((entry) => entry.kind === "compression");
  const isWorkingPlaceholder =
    showLoadingState && entries.length === 0 && !isContextCompression;
  const gradientVar = surface === "editor" ? "var(--bg-main)" : "var(--bg-panel)";
  const inlineEditEntries =
    !preferInside && standaloneHighlighted ? [standaloneHighlighted] : [];
  const hasCollapsibleEntries =
    entries.length > 0 || isWorkingPlaceholder || isContextCompression;
  const embeddedPermissionCard =
    preferInside &&
    embeddedPermission?.type === "permission-request" &&
    !embeddedPermission.permissionResolved
      ? embeddedPermission
      : null;
  /**
   * An unresolved permission embedded in a collapsed card would be invisible while the agent
   * blocks on it forever — force the dropdown open until the user answers.
   */
  const collapsibleOpen =
    isWorkingPlaceholder || embeddedPermissionCard != null ? true : open;
  const embeddedPermissionEl =
    embeddedPermissionCard != null ? (
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
          onResolvePermission?.(
            embeddedPermissionCard.permissionRequestId,
            optionId,
            embeddedPermissionCard.permissionDetail
          );
        }}
      />
    ) : null;
  const hasUnresolvedEmbeddedPermission = Boolean(
    embeddedPermissionCard && !embeddedPermissionCard.permissionResolved
  );
  /** Permission + diffs when there is no tool list (empty worked block, not loading). */
  const orphanInsideDetails =
    preferInside &&
    (embeddedPermissionCard != null || Boolean(standaloneHighlighted?.editPreview));
  /**
   * The unresolved permission card renders pinned *below* the scrollable tool list, never
   * inside it: the list is capped at ~240px and an inline permission row could sit below the
   * fold, invisibly blocking the whole turn.
   */
  const workedScrollRows = useMemo(() => {
    type Row = { kind: "entry"; entry: WorkedSessionEntry; index: number };
    const rows: Row[] = [];
    if (!hasCollapsibleEntries) {
      return rows;
    }
    for (let i = 0; i < entries.length; i += 1) {
      rows.push({ kind: "entry", entry: entries[i]!, index: i });
    }
    return rows;
  }, [hasCollapsibleEntries, entries]);
  const prevMessageLoadingRef = useRef(loading);
  const prevSettledRef = useRef(settled);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentMeasureRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const stickSettleTimerRef = useRef<number | null>(null);
  const touchLastYRef = useRef<number | null>(null);
  const [showTopGrad, setShowTopGrad] = useState(false);
  const [showBottomGrad, setShowBottomGrad] = useState(false);

	const handleOpenToolFile = useCallback(
		(path: string) => {
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
	[openExplorerFile]
  );

  // Collapse only when the *message-level* working placeholder (`loading`) clears — not when an
  // individual tool flips running→completed (that falsely fired for file-edit and other fast tools).
  useEffect(() => {
    if (prevMessageLoadingRef.current && !loading) {
      if (!hasUnresolvedEmbeddedPermission) {
        setOpen(false);
      }
    }
    if (settled && !prevSettledRef.current && !hasUnresolvedEmbeddedPermission && !loading) {
      setOpen(false);
    }
    prevMessageLoadingRef.current = loading;
    prevSettledRef.current = settled;
  }, [hasUnresolvedEmbeddedPermission, loading, settled, setOpen]);

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
          className="relative z-[1] flex w-full min-w-0 cursor-pointer items-center gap-[6px] text-left text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
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
                renderingMode={editDiffRenderingMode}
                preview={entry.editPreview}
                workspaceRoot={workspaceRoot}
                onOpenFile={handleOpenToolFile}
              />
            ) : null
          )}
        </div>
      ) : null}

      {!hasCollapsibleEntries && orphanInsideDetails ? (
        <div className="flex flex-col gap-[10px] pt-[8px]">
          {embeddedPermissionEl}
          {standaloneHighlighted?.editPreview ? (
            <ToolEditPreviewBlock
              key={`inline-diff-${standaloneHighlighted.toolCallId ?? standaloneHighlighted.title}`}
              renderingMode={editDiffRenderingMode}
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
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              onWheel={handleWheel}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              onTouchCancel={handleTouchEnd}
              className={`${contentRail ? "ml-[2px] border-l border-[var(--border-subtle)] pl-[10px]" : ""} overflow-y-auto hide-scrollbar-y`}
              style={{ maxHeight: entryListMaxHeightPx }}
            >
              <div ref={contentMeasureRef} className="flex flex-col gap-[14px]">
                {isContextCompression && entries.length === 0 ? (
                  <p className="font-sans text-[13px] font-normal leading-relaxed text-[var(--text-secondary)]">
                    Summarizing earlier conversation turns to fit the context window. Open this
                    row again when compression finishes to see what was kept and what was
                    summarized.
                  </p>
                ) : null}
                {workedScrollRows.map((row) => (
                  <WorkedEntryBlock
                    key={
                      row.entry.kind === "tool"
                        ? row.entry.toolCallId ??
                          `tool-${row.index}-${row.entry.title}`
                        : `${row.entry.kind}-${row.index}`
                    }
                    entry={row.entry}
                    isLiveWorkedTail={isLiveWorkedTail}
                    workspaceRoot={workspaceRoot}
                    onOpenToolFile={handleOpenToolFile}
                    horizScrollFadeEdge={gradientVar}
                    editDiffRenderingMode={editDiffRenderingMode}
                  />
                ))}
              </div>
            </div>
            {showTopGrad ? (
              <div
                className={`pointer-events-none absolute inset-x-0 top-[10px] ${contentRail ? "ml-[2px]" : ""} h-[28px] z-[1] bg-gradient-to-b to-transparent`}
                style={{ backgroundImage: `linear-gradient(to bottom, ${gradientVar}, transparent)` }}
              />
            ) : null}
            {showBottomGrad ? (
              <div
                className={`pointer-events-none absolute inset-x-0 bottom-0 ${contentRail ? "ml-[2px]" : ""} h-[28px] z-[1] bg-gradient-to-b from-transparent`}
                style={{ backgroundImage: `linear-gradient(to bottom, transparent, ${gradientVar})` }}
              />
            ) : null}
          </div>
          {embeddedPermissionEl ? (
            <div
              className={`relative z-[4] pt-[10px] ${contentRail ? "ml-[2px] pl-[10px]" : ""}`}
            >
              {embeddedPermissionEl}
            </div>
          ) : null}
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
  horizScrollFadeEdge,
  editDiffRenderingMode,
}: {
  entry: WorkedSessionEntry;
  isLiveWorkedTail: boolean;
  workspaceRoot: string | null;
  onOpenToolFile: (path: string) => void;
  horizScrollFadeEdge: string;
  editDiffRenderingMode: EditDiffRenderingMode;
}) {
  const [visible, setVisible] = useState(false);
  const [rawDetailOpen, setRawDetailOpen] = useState(false);

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
        horizScrollFadeEdge,
        rawDetailOpen,
        setRawDetailOpen,
        editDiffRenderingMode
      )}
    </div>
  );
}

function renderEntry(
  entry: WorkedSessionEntry,
  isLiveWorkedTail: boolean,
  workspaceRoot: string | null,
  onOpenToolFile: (path: string) => void,
  horizScrollFadeEdge: string,
  rawDetailOpen: boolean,
  onRawDetailOpenChange: (open: boolean) => void,
  editDiffRenderingMode: EditDiffRenderingMode
) {
  switch (entry.kind) {
    case "verbatim":
      return (
        <div className="flex gap-[8px]">
          <span className="mt-[2px] flex size-[14px] shrink-0 items-center justify-center text-[var(--text-primary)] opacity-90">
            <ScrollText className="size-[14px]" strokeWidth={1.5} aria-hidden />
          </span>
          <pre className="whitespace-pre-wrap font-mono text-[12px] font-normal leading-relaxed text-[var(--text-primary)]">
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
                {explorePreview.map((row) => {
                  const openPath = resolveWorkspaceToolPath(row.raw, workspaceRoot ?? undefined);
                  return (
                    <li key={row.raw} className="flex min-w-0">
                      {openPath ? (
                        <button
                          type="button"
                          onClick={() => onOpenToolFile(openPath)}
                          title={row.label}
                          className="max-w-full truncate text-left font-sans text-[12px] font-normal leading-snug text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                        >
                          {row.label}
                        </button>
                      ) : (
                        <span className="max-w-full truncate font-sans text-[12px] font-normal leading-snug text-[var(--text-secondary)]">
                          {row.label}
                        </span>
                      )}
                    </li>
                  );
                })}
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
    case "compression":
      return (
        <div className="flex flex-col gap-[10px] font-sans text-[13px] font-normal leading-relaxed text-[var(--text-primary)]">
          <div className="flex flex-col gap-[4px] text-[var(--text-secondary)]">
            <p>
              Summarized{" "}
              <span className="text-[var(--text-primary)]">
                {entry.compressedTurnCount}
              </span>{" "}
              earlier user turn{entry.compressedTurnCount === 1 ? "" : "s"}; kept{" "}
              <span className="text-[var(--text-primary)]">
                {entry.retainedTurnCount}
              </span>{" "}
              recent turn{entry.retainedTurnCount === 1 ? "" : "s"} in full.
            </p>
          </div>
          {entry.summary.trim() ? (
            <div className="rounded-[8px] border border-[color-mix(in_srgb,var(--border-card)_70%,transparent)] bg-[color-mix(in_srgb,var(--bg-card)_62%,transparent)]">
              <p className="border-b border-[color-mix(in_srgb,var(--border-card)_55%,transparent)] px-[10px] py-[6px] text-[11px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">
                Summary
              </p>
              <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap px-[10px] py-[8px] font-mono text-[12px] font-normal leading-relaxed text-[var(--text-primary)]">
                {entry.summary}
              </pre>
            </div>
          ) : null}
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
                path: location.path,
                label:
                  typeof location.line === "number"
                    ? `${baseLabel}:${location.line}`
                    : baseLabel,
              };
            })
          : entry.files?.map((raw) => ({
              raw,
              path: raw,
              label: formatToolFileLabel(raw, workspaceRoot ?? undefined),
            })) ?? [])
          .filter((row): row is { raw: string; path: string; label: string } => Boolean(row?.label))
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
      const rawDetail = entry.rawDetail?.trim();
      const showRawDetail = Boolean(rawDetail && rawDetail !== extraDetail?.trim());
      const rawDetailDisplay = rawDetail ? formatRawDetailForDisplay(rawDetail) : undefined;
      const rawDetailHeading = entry.variant === "terminal" ? "Output" : "Details";
      const todos = entry.todos && entry.todos.length > 0 ? entry.todos : null;
      const pluginBadge = entry.pluginName ? (
        <span className="inline-flex items-center gap-[6px] rounded-[6px] border border-[color-mix(in_srgb,var(--border-card)_85%,transparent)] bg-[color-mix(in_srgb,var(--bg-card)_88%,transparent)] px-[7px] py-[2px] font-sans text-[10px] font-medium tracking-[0.01em] text-[var(--text-secondary)]">
          {entry.pluginIconUrl ? (
            <img
              alt=""
              src={entry.pluginIconUrl}
              className="size-[12px] rounded-[3px] object-cover"
            />
          ) : (
            <span className="inline-flex size-[12px] items-center justify-center rounded-[3px] bg-[var(--accent-bg)] text-[8px] text-[var(--accent)]">
              {entry.pluginName.slice(0, 1).toUpperCase()}
            </span>
          )}
          {entry.pluginName}
        </span>
      ) : null;
      return (
        <div className="flex gap-[8px]">
          <span className={iconWrap}>{toolEntryIcon(entry)}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-[8px]">
              {showRawDetail ? (
                <button
                  type="button"
                  aria-label={`${rawDetailOpen ? "Hide" : "Show"} details for ${entry.title}`}
                  aria-expanded={rawDetailOpen}
                  onClick={() => onRawDetailOpenChange(!rawDetailOpen)}
                  className="group pointer-events-auto relative z-[3] flex max-w-full min-w-0 cursor-pointer flex-wrap items-center gap-[8px] rounded-[5px] text-left outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                >
                  {renderToolTitleLine(entry, titleClass, workspaceRoot, true)}
                  <ChevronDown
                    className={`size-[13px] shrink-0 text-[var(--text-secondary)] transition-colors transition-transform duration-200 group-hover:text-[var(--text-primary)] ${rawDetailOpen ? "rotate-180" : ""}`}
                    strokeWidth={1.75}
                    aria-hidden
                  />
                </button>
              ) : (
                renderToolTitleLine(entry, titleClass, workspaceRoot)
              )}
              {pluginBadge}
              {statusKey ? (
                <span
                  className={`rounded-full border px-[7px] py-[1px] font-sans text-[10px] font-medium uppercase tracking-[0.08em] ${toolStatusClass[statusKey]}`}
                >
                  {statusKey}
                </span>
              ) : null}
            </div>
            {extraDetail ? (
              <HorizontalFadedScroll
                scrollClassName="hide-scrollbar-x mt-[4px] overflow-x-auto font-mono text-[12px] font-normal leading-relaxed text-[var(--text-secondary)] whitespace-pre"
                edgeColorVar={horizScrollFadeEdge}
                measureKey={extraDetail}
              >
                {extraDetail}
              </HorizontalFadedScroll>
            ) : null}
            {todos ? <WorkedTodoChecklist todos={todos} /> : null}
            {showRawDetail && rawDetailOpen ? (
              <div className="relative z-[2] mt-[6px] overflow-hidden rounded-[8px] border border-[color-mix(in_srgb,var(--border-card)_70%,transparent)] bg-[color-mix(in_srgb,var(--bg-card)_62%,transparent)]">
                <p className="border-b border-[color-mix(in_srgb,var(--border-card)_55%,transparent)] px-[8px] py-[4px] font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                  {rawDetailHeading}
                </p>
                <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words px-[8px] py-[7px] font-mono text-[11px] font-normal leading-relaxed text-[var(--text-secondary)]">
                  {rawDetailDisplay}
                </pre>
              </div>
            ) : null}
            {entry.editPreview ? (
              <ToolEditPreviewBlock
                renderingMode={editDiffRenderingMode}
                preview={entry.editPreview}
                workspaceRoot={workspaceRoot}
                onOpenFile={onOpenToolFile}
              />
            ) : null}
            {previewFiles.length > 0 ? (
              <ul className="mt-[6px] flex list-none flex-col gap-[4px]">
                {previewFiles.map((row) => {
                  const openPath = resolveWorkspaceToolPath(row.path, workspaceRoot ?? undefined);
                  return (
                    <li key={row.raw} className="flex min-w-0">
                      {openPath ? (
                        <button
                          type="button"
                          onClick={() => onOpenToolFile(openPath)}
                          title={row.label}
                          className="max-w-full truncate text-left font-sans text-[12px] font-normal leading-snug text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                        >
                          {row.label}
                        </button>
                      ) : (
                        <span className="max-w-full truncate font-sans text-[12px] font-normal leading-snug text-[var(--text-secondary)]">
                          {row.label}
                        </span>
                      )}
                    </li>
                  );
                })}
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
