"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useId,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import {
  ArrowUp,
  Bug,
  Image as ImageIcon,
  Infinity as InfinityIcon,
  LayoutTemplate,
  ListChecks,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Mic,
  Minimize2,
  Plus,
  Square,
  X,
} from "lucide-react";
import { ImageCarousel } from "./ImageCarousel";
import type { ImageAttachment, ImageAttachmentState } from "@/lib/types";
import { useTheme } from "@/components/theme/ThemeProvider";
import {
  resolveComposerIsMultiLine,
  shouldLatchComposerMultiline,
  useComposerTextIsMultiLine,
} from "./composer-multiline";
import {
  ComposerEditorScrollFades,
  useComposerEditorScrollFade,
} from "./composer-editor-scroll-fade";
import { useHardwareInput } from "@/components/input/HardwareInputProvider";
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";
import {
  applyTextBufferKey,
  clampSelection,
  isArrowDownKey,
  isArrowUpKey,
  replaceSelection,
  type TextSelection,
} from "@/components/input/text-buffer";
import { ModeDropdown } from "./ModeDropdown";
import { ModelDropdown } from "./ModelDropdown";
import { BackendDropdown } from "./BackendDropdown";
import { SessionConfigOptionDropdown } from "./SessionConfigOptionDropdown";
import {
  ComposerAutocomplete,
  type ComposerPopoverPosition,
} from "./ComposerAutocomplete";
import { ComposerSlashMenu } from "./ComposerSlashMenu";
import { useClickOutside } from "@/hooks/useClickOutside";
import { useHardwareKeyboard } from "@/hooks/useHardwareKeyboard";
import { shouldSubmitComposerOnEnter } from "@/lib/composer-submit-key";
import {
  getAllAtSuggestions,
  filterAtSuggestions,
  getSlashMenuSections,
  filterSlashMenuSections,
  flattenSlashMenuSections,
  type AtSuggestion,
  type SlashMenuItem,
} from "@/lib/composer-suggestions";
import {
  CHAT_UI_SHORTCUT_EVENT,
  isChatUiShortcutEvent,
  type ChatComposerShortcutAction,
} from "@/lib/chat-ui-shortcut-events";
import { shouldAutoFocusTextInput } from "@/lib/mobile-autofocus";
import {
  composerEditorDomInSync,
  getCaretClientRect,
  getComposerPlainText,
  getCaretOffset,
  getPlainTextRangeOffsets,
  parseTriggerToken,
  reconcileComposerEditorDom,
  replaceTextRange,
  setCaretOffset,
  type ComposerPillDescriptor,
} from "./composer-editor-utils";
import {
  DEFAULT_MODE_OPTIONS,
  ensureCurrentModeOption,
  getModeTone,
  resolveCanonicalModeId,
} from "@/lib/chat-modes";
import type { AgentModeOption, EditorMode, KnownEditorMode, ModelInfo } from "@/lib/types";
import type { AgentBackendId, AgentBackendInfo, AgentConfigOption, AgentConversationStatus } from "@/lib/agent-types";
import { isAgentCesiumTurnActive, isAgentCesiumPauseDraining } from "@/lib/agent-chat";
import { CesiumTurnControlPill } from "@/components/chat/CesiumTurnControlPill";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { transcribeAudio, uploadAttachments } from "@/lib/server-api";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import {
  buildDesignCaptureBlock,
  COMPOSER_CAPTURE_TOKEN_REGEX,
  findComposerCaptureTokens,
  type DesignCapture,
} from "@/lib/design-capture";

const sendButtonBgClass: Record<KnownEditorMode, string> = {
  agent: "bg-[var(--accent-dark)]",
  plan: "bg-[var(--plan-accent-dark)]",
  debug: "bg-[var(--debug-accent-dark)]",
  ask: "bg-[var(--ask-accent-dark)]",
};

const COMPOSER_PLACEHOLDER_TEXT =
  "Ask anything, @ for files, / for commands";

/**
 * Shared mode accent/icon map for the new-design mode chip. Kept local so
 * `ModeDropdown` (classic) can stay untouched and the chip renders without
 * importing private symbols from a peer.
 */
const NEW_DESIGN_MODE_COLORS: Record<KnownEditorMode, { text: string; bg: string }> = {
  agent: { text: "var(--accent)", bg: "var(--accent-bg)" },
  plan: { text: "var(--plan-accent)", bg: "var(--plan-accent-bg)" },
  debug: { text: "var(--debug-accent)", bg: "var(--debug-accent-bg)" },
  ask: { text: "var(--ask-accent)", bg: "var(--ask-accent-bg)" },
};

function renderNewDesignModeIcon(tone: KnownEditorMode, color: string): ReactElement {
  const className = "size-[13px] shrink-0";
  const strokeWidth = 1.5;
  switch (tone) {
    case "plan":
      return <ListChecks className={className} strokeWidth={strokeWidth} style={{ color }} />;
    case "debug":
      return <Bug className={className} strokeWidth={strokeWidth} style={{ color }} />;
    case "ask":
      return <MessageSquare className={className} strokeWidth={strokeWidth} style={{ color }} />;
    case "agent":
      return <InfinityIcon className={className} strokeWidth={strokeWidth} style={{ color }} />;
    default: {
      const exhaustive: never = tone;
      return exhaustive;
    }
  }
}

function isNewDesignModeChipVisible(mode: EditorMode): boolean {
  return getModeTone(mode) !== "agent";
}

function resolveDefaultModeForOptions(options?: AgentModeOption[]): EditorMode {
  const candidates = options?.length ? options : DEFAULT_MODE_OPTIONS;
  return (
    candidates.find((option) => getModeTone(option.id) === "agent")?.id ??
    candidates[0]?.id ??
    "agent"
  );
}

function isPlainBackspaceKey(
  event: Pick<
    KeyboardEvent,
    "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey"
  >
): boolean {
  return (
    event.key === "Backspace" &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  );
}

interface NewDesignModeChipProps {
  mode: EditorMode;
  options: AgentModeOption[];
  onModeChange: (mode: EditorMode) => void;
  disabled?: boolean;
  removable?: boolean;
}

/**
 * Cursor 3.1-style mode chip. Hidden while mode resolves to `agent` (the
 * default); materializes with a small remove affordance for any other mode so
 * cycling Shift+Tab into Plan/Debug/Ask surfaces an obvious chip that can be
 * dismissed back to default without opening a menu.
 */
function NewDesignModeChip({
  mode,
  options,
  onModeChange,
  disabled,
  removable = true,
}: NewDesignModeChipProps) {
  const tone = getModeTone(mode);
  if (!isNewDesignModeChipVisible(mode)) {
    return null;
  }
  const defaultMode = resolveDefaultModeForOptions(options);
  const resolvedOptions = ensureCurrentModeOption(
    mode,
    options.length > 0 ? options : DEFAULT_MODE_OPTIONS
  );
  const current =
    resolvedOptions.find((o) => o.id === mode) ??
    resolvedOptions[0];
  const label = current?.label ?? mode;
  const colors = NEW_DESIGN_MODE_COLORS[tone];
  return (
    <span
      className="inline-flex h-[22px] shrink-0 items-center gap-[3px] rounded-[var(--radius-pill)] pl-[7px] pr-[4px] font-sans text-[13px] font-normal leading-none"
      style={{ background: colors.bg }}
    >
      {renderNewDesignModeIcon(tone, colors.text)}
      <span style={{ color: colors.text }}>{label}</span>
      {removable ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onModeChange(defaultMode)}
          className="ml-[2px] flex size-[14px] items-center justify-center rounded-full transition-[background-color,opacity] hover:bg-black/15 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={`Remove ${label} mode`}
          title={`Remove ${label} mode`}
        >
          <X className="size-[10px]" strokeWidth={2.25} style={{ color: colors.text }} />
        </button>
      ) : null}
    </span>
  );
}

type MenuState =
  | { kind: "at"; start: number; end: number; query: string }
  | { kind: "slash"; start: number; end: number; query: string };

function normalizeDirectiveToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Clipboard image files only (items first — avoids duplicate uploads when both items and `files` list them). */
function collectClipboardImageFiles(data: DataTransfer | null): File[] {
  if (!data) {
    return [];
  }
  const fromItems: File[] = [];
  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i];
    if (item?.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        fromItems.push(file);
      }
    }
  }
  if (fromItems.length > 0) {
    return fromItems;
  }
  const fromFiles: File[] = [];
  for (let i = 0; i < data.files.length; i++) {
    const file = data.files[i];
    if (file?.type.startsWith("image/")) {
      fromFiles.push(file);
    }
  }
  return fromFiles;
}

/** Prefer `text/plain`; if missing, strip tags from `text/html` (DOMParser does not execute scripts). */
function clipboardPlainTextOnly(data: DataTransfer | null): string {
  if (!data) {
    return "";
  }
  const plain = data.getData("text/plain");
  if (plain) {
    return plain.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }
  const html = data.getData("text/html");
  if (!html?.trim()) {
    return "";
  }
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return (doc.body?.textContent ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  } catch {
    return "";
  }
}

function pickRecordingMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") {
    return undefined;
  }
  for (const candidate of [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ]) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function buildInsertedTranscription(
  text: string,
  selection: TextSelection,
  transcription: string
): { value: string; selection: TextSelection } {
  const cleaned = transcription.trim();
  if (!cleaned) {
    return {
      value: text,
      selection,
    };
  }

  let before = text.slice(0, selection.start);
  let after = text.slice(selection.end);
  const trailingBeforeNewlines = before.match(/\n+$/)?.[0].length ?? 0;
  const leadingAfterNewlines = after.match(/^\n+/)?.[0].length ?? 0;

  if (trailingBeforeNewlines > 0) {
    before = before.slice(0, -trailingBeforeNewlines);
  }
  if (leadingAfterNewlines > 0) {
    after = after.slice(leadingAfterNewlines);
  }

  const visuallyEmpty = before.trim() === "" && after.trim() === "";
  const beforeBoundary = !visuallyEmpty && trailingBeforeNewlines > 0 ? "\n\n" : "";
  const afterBoundary = !visuallyEmpty && leadingAfterNewlines > 0 ? "\n\n" : "";

  const prevChar = before.at(-1) ?? "";
  const nextChar = after[0] ?? "";
  const needsLeadingSpace =
    beforeBoundary.length === 0 &&
    before.length > 0 &&
    !/\s/.test(prevChar) &&
    !/^[,.;:!?)]/.test(cleaned);
  const needsTrailingSpace =
    afterBoundary.length === 0 &&
    !/\s$/.test(cleaned) &&
    ((after.length > 0 &&
      !/\s/.test(nextChar) &&
      !/^[,.;:!?)]/.test(nextChar)) ||
      (after.length === 0 && !visuallyEmpty));

  const inserted = `${needsLeadingSpace ? " " : ""}${cleaned}${needsTrailingSpace ? " " : ""}`;
  const value = `${before}${beforeBoundary}${inserted}${afterBoundary}${after}`;
  const caret = `${before}${beforeBoundary}${inserted}`.length;
  return {
    value,
    selection: { start: caret, end: caret },
  };
}

interface ChatComposerProps {
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  model: ModelInfo;
  onModelChange: (model: ModelInfo) => void;
  backendId: AgentBackendId;
  backends: AgentBackendInfo[];
  onBackendChange: (backendId: AgentBackendId) => void;
  models: ModelInfo[];
  modeOptions?: AgentModeOption[];
  /** Extra ACP selectors: reasoning effort, speed, context window, etc. */
  sessionConfigOptions?: AgentConfigOption[];
  onSessionConfigOptionChange?: (configId: string, value: string) => void;
  value?: string;
  onValueChange?: (value: string) => void;
  selection?: TextSelection;
  onSelectionChange?: (selection: TextSelection) => void;
  onExpandComposer?: () => void;
  onCollapseComposer?: () => void;
  onSubmit: (
    text: string,
    attachments?: ImageAttachment[],
    options?: { delivery?: "normal" | "steer" }
  ) => Promise<boolean | void> | boolean | void;
  onCancel?: () => Promise<void> | void;
  onPause?: () => Promise<void> | void;
  onResume?: () => Promise<void> | void;
  conversationStatus?: AgentConversationStatus;
  busy?: boolean;
  configLocked?: boolean;
  /** When true, mode cannot be changed or removed (orchestration lock-in). */
  modeLocked?: boolean;
  /** Empty thread: composer sits under tabs; otherwise docked above bottom. */
  layout?: "docked-bottom" | "empty-top";
  variant?: "docked" | "expanded";
  /** Force the docked composer into its stacked multi-line layout without using the legacy expanded shell. */
  forceMultiline?: boolean;
  /**
   * When set, replaces the default horizontal shell margin (non-expanded only).
   * Default: `mx-0` until the pane `@container` is ≥481px wide, then `mx-[10px]`; use `""` for flush.
   */
  /** Horizontal margin on the composer card. Use `""` when a parent already applies the chat column width (e.g. `AGENT_CENTER_CONTENT_CLASS`). */
  shellMxClass?: string;
  /**
   * Agent shell only: maximize/minimize toggles the docked input max-height in place
   * instead of delegating to `onExpandComposer` (editor expanded composer).
   */
  agentShellDockHeightExpand?: boolean;
  /** Callback when user requests handoff to a different agent */
  onRequestHandoff?: (targetBackendId: AgentBackendId) => void;
  /** When true, expose git worktree slash commands wired by the host submit handler. */
  gitSlashCommands?: boolean;
  /**
   * When the OpenInEditor draft gains new image attachments (e.g. browser design mode),
   * entries beyond the last consumed index are merged into the local attachment strip.
   */
  draftAttachments?: ImageAttachment[];
  /**
   * Called when the user removes an attachment that originated from the persisted
   * draft (localId prefix `draft:`). Passes the filtered list so the host can
   * upsert it back into the composer draft and prevent the image from
   * re-hydrating on the next mount/reload.
   */
  onDraftAttachmentsChange?: (next: ImageAttachment[] | undefined) => void;
  /**
   * Metadata for each `⟦design:<id>⟧` pill that appears in `value`. The
   * composer renders pills based on this map, and expands each token into a
   * full `<design-capture>` XML block on submit. Tokens without a matching
   * entry render as a generic "missing capture" pill (capture lost to
   * storage pruning, stale undo, etc.) so the user can see and delete them.
   */
  draftCaptures?: Record<string, DesignCapture>;
  /**
   * Called when the user deletes a pill so the host can drop the corresponding
   * metadata from the persisted draft instead of keeping an orphaned record.
   */
  onDraftCapturesChange?: (next: Record<string, DesignCapture> | undefined) => void;
  /**
   * Newest-first list of the user's previously sent messages (raw `content`)
   * for terminal-style Up/Down arrow history recall. Pressing Up while the
   * caret is at the start of the composer cycles older, Down cycles newer. If
   * Down is pressed at the bottom of the stack with history active, the
   * composer restores the in-progress draft the user had before recalling.
   * When the list is empty or undefined the history behavior is disabled.
   */
  userMessageHistory?: string[];
  /**
   * True when there are more user messages on the server past the currently
   * loaded window (agent events paginate); the composer will call
   * {@link onRequestOlderUserMessageHistory} when the user attempts to step
   * off the end of the currently loaded list so additional pages can be
   * streamed in without the user noticing.
   */
  hasMoreOlderUserMessageHistory?: boolean;
  /**
   * Called when Up is pressed past the oldest loaded user message; the host
   * is expected to request the next older page of conversation events and
   * the composer will re-evaluate the history list on the next render.
   */
  onRequestOlderUserMessageHistory?: () => void;
}

function resolvePointerSelection(
  event: ReactPointerEvent<HTMLElement>,
  valueLength: number
): TextSelection {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return { start: valueLength, end: valueLength };
  }

  const char = target.closest("[data-faux-offset-start]") as HTMLElement | null;
  if (!char) {
    return { start: valueLength, end: valueLength };
  }

  const start = Number(char.dataset.fauxOffsetStart ?? valueLength);
  const end = Number(char.dataset.fauxOffsetEnd ?? start);
  const rect = char.getBoundingClientRect();
  const midpoint = rect.left + rect.width / 2;
  const next = event.clientX < midpoint ? start : end;
  return { start: next, end: next };
}

/**
 * Render one plain-text slice of the composer value, char-by-char so the
 * caret can land between any two characters and selection ranges map cleanly.
 * Separated from {@link renderComposerText} so design pills can be interleaved
 * as single units without disturbing the per-char selection math.
 */
function renderPlainSlice(
  slice: string,
  startOffset: number,
  safe: TextSelection,
  active: boolean,
  caretRef: { current: HTMLSpanElement | null },
  nodes: ReactElement[]
) {
  const pushCaret = (at: number) => {
    if (!active || safe.start !== safe.end || safe.start !== at) {
      return;
    }
    nodes.push(
      <span
        key={`caret-${at}`}
        ref={(node) => {
          caretRef.current = node;
        }}
        className="inline-block h-[1.1em] w-px align-middle bg-[var(--text-primary)]"
        data-faux-caret
      />
    );
  };

  const parts = slice.match(/\S+|\s+/g) ?? [];
  let index = startOffset;

  for (let p = 0; p < parts.length; p += 1) {
    const part = parts[p]!;
    const isWhitespaceOnly = /^\s+$/.test(part);

    const pushCharSpan = (char: string, at: number) => {
      const selected = at >= safe.start && at < safe.end;
      nodes.push(
        <span
          key={`char-${at}`}
          data-faux-offset-start={at}
          data-faux-offset-end={at + 1}
          className={
            selected
              ? "rounded-[2px] bg-[var(--accent-bg)] text-[var(--text-primary)]"
              : undefined
          }
        >
          {char === " " ? "\u00a0" : char}
        </span>
      );
    };

    if (isWhitespaceOnly) {
      for (let j = 0; j < part.length; j += 1) {
        pushCaret(index);
        pushCharSpan(part[j]!, index);
        index += 1;
      }
    } else {
      const wordWrapClass =
        part.length > 96
          ? "inline-block max-w-full break-all align-baseline"
          : "whitespace-nowrap align-baseline";
      const wordChildren: ReactElement[] = [];
      const wordStart = index;
      for (let j = 0; j < part.length; j += 1) {
        pushCaret(index);
        const char = part[j]!;
        const selected = index >= safe.start && index < safe.end;
        wordChildren.push(
          <span
            key={`char-${index}`}
            data-faux-offset-start={index}
            data-faux-offset-end={index + 1}
            className={
              selected
                ? "rounded-[2px] bg-[var(--accent-bg)] text-[var(--text-primary)]"
                : undefined
            }
          >
            {char}
          </span>
        );
        index += 1;
      }
      nodes.push(
        <span key={`word-${wordStart}`} className={wordWrapClass}>
          {wordChildren}
        </span>
      );
      pushCaret(index);
    }
  }

  return index;
}

function renderDesignPill(
  tokenStart: number,
  tokenEnd: number,
  capture: DesignCapture | undefined,
  safe: TextSelection,
  active: boolean,
  caretRef: { current: HTMLSpanElement | null },
  nodes: ReactElement[]
): void {
  const pushCaret = (at: number) => {
    if (!active || safe.start !== safe.end || safe.start !== at) {
      return;
    }
    nodes.push(
      <span
        key={`caret-${at}`}
        ref={(node) => {
          caretRef.current = node;
        }}
        className="inline-block h-[1.1em] w-px align-middle bg-[var(--text-primary)]"
        data-faux-caret
      />
    );
  };

  pushCaret(tokenStart);

  // The pill is a single selection unit: its offset-start maps to the first
  // char of the `⟦`, offset-end maps to one past the trailing `⟧`. That lets
  // Shift+Arrow / click selection treat the whole token as one glyph while
  // still allowing caret placement on either side.
  const selected = tokenStart >= safe.start && tokenEnd <= safe.end && safe.end > safe.start;
  const label = capture?.label ?? "element";
  const title = capture?.snippet
    ? `${capture.label}\n\n${capture.snippet.slice(0, 600)}${capture.snippet.length > 600 ? "…" : ""}`
    : capture?.label;
  nodes.push(
    <span
      key={`design-${tokenStart}`}
      data-faux-offset-start={tokenStart}
      data-faux-offset-end={tokenEnd}
      className={`mx-[2px] inline-flex max-w-full items-center gap-[4px] rounded-[6px] border border-[var(--border-subtle)] bg-[var(--file-tag-bg)] px-[7px] py-[1px] align-baseline font-sans text-[12.5px] font-medium whitespace-nowrap ${
        selected ? "ring-2 ring-[var(--accent)]" : ""
      } ${capture ? "text-[var(--file-tag-text)]" : "text-[var(--text-secondary)] italic"}`}
      title={title}
      data-design-capture-id={capture?.id ?? ""}
    >
      <LayoutTemplate
        className="size-[12px] shrink-0 text-[var(--file-tag-icon)]"
        strokeWidth={1.75}
        aria-hidden
      />
      <span className="max-w-[240px] truncate">
        {capture ? label : "missing capture"}
      </span>
    </span>
  );
}

function renderComposerText(
  value: string,
  selection: TextSelection,
  active: boolean,
  caretRef: { current: HTMLSpanElement | null },
  captures: Record<string, DesignCapture> | undefined
) {
  const safe = clampSelection(value, selection);
  const nodes: ReactElement[] = [];

  if (value.length === 0) {
    if (active && safe.start === safe.end && safe.start === 0) {
      nodes.push(
        <span
          key="caret-0"
          ref={(node) => {
            caretRef.current = node;
          }}
          className="inline-block h-[1.1em] w-px align-middle bg-[var(--text-primary)]"
          data-faux-caret
        />
      );
    }
    return nodes;
  }

  const tokens = findComposerCaptureTokens(value);

  if (tokens.length === 0) {
    renderPlainSlice(value, 0, safe, active, caretRef, nodes);
    // Trailing caret at end of value (if caret is there).
    if (active && safe.start === safe.end && safe.start === value.length) {
      nodes.push(
        <span
          key={`caret-${value.length}`}
          ref={(node) => {
            caretRef.current = node;
          }}
          className="inline-block h-[1.1em] w-px align-middle bg-[var(--text-primary)]"
          data-faux-caret
        />
      );
    }
    return nodes;
  }

  let cursor = 0;
  for (const tk of tokens) {
    if (tk.start > cursor) {
      renderPlainSlice(
        value.slice(cursor, tk.start),
        cursor,
        safe,
        active,
        caretRef,
        nodes
      );
    }
    renderDesignPill(
      tk.start,
      tk.end,
      captures?.[tk.captureId],
      safe,
      active,
      caretRef,
      nodes
    );
    cursor = tk.end;
  }
  if (cursor < value.length) {
    renderPlainSlice(value.slice(cursor), cursor, safe, active, caretRef, nodes);
  }
  if (active && safe.start === safe.end && safe.start === value.length) {
    nodes.push(
      <span
        key={`caret-${value.length}`}
        ref={(node) => {
          caretRef.current = node;
        }}
        className="inline-block h-[1.1em] w-px align-middle bg-[var(--text-primary)]"
        data-faux-caret
      />
    );
  }
  return nodes;
}

export function ChatComposer({
  mode,
  onModeChange,
  model,
  onModelChange,
  backendId,
  backends,
  onBackendChange,
  models,
  modeOptions,
  sessionConfigOptions,
  onSessionConfigOptionChange,
  value: controlledValue,
  onValueChange,
  selection: controlledSelection,
  onSelectionChange,
  onExpandComposer,
  onCollapseComposer,
  onSubmit,
  onCancel,
  onPause,
  onResume,
  conversationStatus,
  busy = false,
  configLocked = false,
  modeLocked = false,
  layout = "docked-bottom",
  variant = "docked",
  forceMultiline = false,
  shellMxClass,
  agentShellDockHeightExpand = false,
  onRequestHandoff,
  gitSlashCommands = false,
  draftAttachments,
  onDraftAttachmentsChange,
  draftCaptures,
  onDraftCapturesChange,
  userMessageHistory,
  hasMoreOlderUserMessageHistory = false,
  onRequestOlderUserMessageHistory,
}: ChatComposerProps) {
  const { fileTree } = useWorkspace();
  const { settings } = useGlobalSettings();
  const submitCtrlEnter = settings.agents.submitCtrlEnter;
  const steerCtrlEnter = settings.agents.steerCtrlEnter;
  const hasHardwareKeyboard = useHardwareKeyboard();
  const { pushNotification } = useWorkbenchNotifications();
  const surfaceId = useId().replace(/:/g, "_");
  const submittingPromptKeyRef = useRef<string | null>(null);
  const {
    enabled: hardwareInputEnabled,
    registerSurface,
    unregisterSurface,
    activateSurface,
    deactivateSurface,
    isSurfaceActive,
  } = useHardwareInput();
  const [uncontrolledValue, setUncontrolledValue] = useState("");
  const [uncontrolledSelection, setUncontrolledSelection] = useState<TextSelection>({
    start: 0,
    end: 0,
  });
  const [hasFocus, setHasFocus] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  /** Bumped when Shift+Tab cycles mode so `ModeDropdown` flashes the label. */
  const [modeLabelPeekKey, setModeLabelPeekKey] = useState(0);
  /** Bumped when Ctrl+Shift+Tab cycles ACP backend so `BackendDropdown` flashes the label. */
  const [backendLabelPeekKey, setBackendLabelPeekKey] = useState(0);
  const [modeMenuOpenKey, setModeMenuOpenKey] = useState(0);
  const [backendMenuOpenKey, setBackendMenuOpenKey] = useState(0);
  const [recordingState, setRecordingState] = useState<
    "idle" | "recording" | "transcribing"
  >("idle");
  const [attachedImages, setAttachedImages] = useState<ImageAttachmentState[]>([]);
  const consumedDraftAttachmentKeysRef = useRef<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRootRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const imageFilesRef = useRef<Map<string, File>>(new Map());
  const [inputLevel, setInputLevel] = useState(0);
  const [menuPos, setMenuPos] = useState<ComposerPopoverPosition>({
    placement: "above",
    bottom: 100,
    left: 8,
    maxHeight: 280,
  });
  const [agentShellDockTall, setAgentShellDockTall] = useState(false);
  /**
   * Terminal-style Up/Down recall state. `index` is `-1` when the user is
   * editing their own draft, `0` points at the newest past user message, and
   * larger values step further back. `draftSnapshot` captures the live
   * composer value at the moment the user first stepped into history so the
   * original draft can be restored when they step all the way back.
   */
  const [userHistoryIndex, setUserHistoryIndex] = useState<number>(-1);
  const [userHistoryDraftSnapshot, setUserHistoryDraftSnapshot] =
    useState<string | null>(null);
  const userHistoryIndexRef = useRef(userHistoryIndex);
  userHistoryIndexRef.current = userHistoryIndex;
  const userHistoryDraftSnapshotRef = useRef(userHistoryDraftSnapshot);
  userHistoryDraftSnapshotRef.current = userHistoryDraftSnapshot;
  const userMessageHistoryRef = useRef<string[] | undefined>(userMessageHistory);
  userMessageHistoryRef.current = userMessageHistory;
  const hasMoreOlderUserMessageHistoryRef = useRef(hasMoreOlderUserMessageHistory);
  hasMoreOlderUserMessageHistoryRef.current = hasMoreOlderUserMessageHistory;
  const onRequestOlderUserMessageHistoryRef = useRef(onRequestOlderUserMessageHistory);
  onRequestOlderUserMessageHistoryRef.current = onRequestOlderUserMessageHistory;

  useEffect(() => {
    if (!agentShellDockHeightExpand) {
      setAgentShellDockTall(false);
    }
  }, [agentShellDockHeightExpand]);

  const editorRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLSpanElement | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<MenuState | null>(null);
  const valueRef = useRef(controlledValue ?? "");
  const selectionRef = useRef<TextSelection>(
    controlledSelection ?? {
      start: 0,
      end: 0,
    }
  );
  const modeRef = useRef(mode);
  const modeOptionsRef = useRef<AgentModeOption[] | undefined>(modeOptions);
  const configLockedRef = useRef(configLocked);
  const modeLockedRef = useRef(modeLocked);
  const canBackspaceClearModeChipRef = useRef(false);
  const filteredAtRef = useRef<AtSuggestion[]>([]);
  const filteredSlashRef = useRef<SlashMenuItem[]>([]);
  const selectedIndexRef = useRef(selectedIndex);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const reconcilingRef = useRef(false);
  menuRef.current = menu;
  modeRef.current = mode;
  modeOptionsRef.current = modeOptions;
  configLockedRef.current = configLocked;
  modeLockedRef.current = modeLocked;

  const value = controlledValue ?? uncontrolledValue;
  const selection = controlledSelection ?? uncontrolledSelection;
  const atSuggestions = useMemo(() => getAllAtSuggestions(fileTree), [fileTree]);
  const activeBackend = useMemo(
    () => backends.find((entry) => entry.id === backendId) ?? backends[0] ?? null,
    [backendId, backends]
  );
  const slashMenuSections = useMemo(
    () =>
      getSlashMenuSections({
        activeBackend,
        modeOptions,
        models,
        backends,
        sessionConfigOptions,
        gitSlashCommands,
        configLocked,
        modeLocked,
      }),
    [
      activeBackend,
      backends,
      configLocked,
      gitSlashCommands,
      modeLocked,
      modeOptions,
      models,
      sessionConfigOptions,
    ]
  );

  const setComposerValue = useCallback(
    (nextValue: string) => {
      valueRef.current = nextValue;
      if (controlledValue === undefined) {
        setUncontrolledValue(nextValue);
      }
      onValueChange?.(nextValue);
    },
    [controlledValue, onValueChange]
  );

  const setComposerSelection = useCallback(
    (nextSelection: TextSelection) => {
      const safe = clampSelection(valueRef.current, nextSelection);
      selectionRef.current = safe;
      if (controlledSelection === undefined) {
        setUncontrolledSelection(safe);
      }
      onSelectionChange?.(safe);
    },
    [controlledSelection, onSelectionChange]
  );

  const flashComposerError = useCallback(
  (message: string) => {
    pushNotification({
      kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
      severity: "error",
      title: "Voice input",
      message,
      autoDismissMs: 7000,
      compact: true,
    });
  },
  [pushNotification]
  );

  const cleanupVoiceCapture = useCallback(async (stopTracks: boolean) => {
    if (animationFrameRef.current != null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    if (audioContextRef.current) {
      try {
        await audioContextRef.current.close();
      } catch {
        // Ignore close failures from partially initialized contexts.
      }
      audioContextRef.current = null;
    }
    if (stopTracks) {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    setInputLevel(0);
  }, []);

  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
  const SLOW_UPLOAD_THRESHOLD_MS = 2500;

  const addImagesFromFileList = useCallback(
    (files: FileList) => {
      const imageFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
      const currentCount = attachedImages.length;
      const maxImages = 10 - currentCount;
      const filesToAdd = imageFiles.slice(0, maxImages);

      const validFiles = filesToAdd.filter((file) => {
        if (file.size > MAX_FILE_SIZE) {
      pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
          severity: "warning",
          title: "Image too large",
          message: `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)}MB. Maximum size is 10MB.`,
          autoDismissMs: 5000,
          compact: true,
        });
          return false;
        }
        return true;
      });

      if (validFiles.length === 0) return;

      const newImageEntries: ImageAttachmentState[] = validFiles.map((file) => ({
        localId: globalThis.crypto?.randomUUID?.() ?? `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        mimeType: file.type,
        data: "",
        name: file.name,
        uploadState: "pending",
        showSlowSpinner: false,
      }));

      // Store files in ref for retry functionality
      newImageEntries.forEach((entry, i) => {
        imageFilesRef.current.set(entry.localId, validFiles[i]);
      });

      setAttachedImages((prev) => [...prev, ...newImageEntries]);

      void Promise.all(
        validFiles.map((file, i) => {
          return new Promise<void>((resolve) => {
            const localId = newImageEntries[i].localId;

            const slowUploadTimer = setTimeout(() => {
              setAttachedImages((prev) =>
                prev.map((img) =>
                  img.localId === localId ? { ...img, showSlowSpinner: true } : img
                )
              );
            }, SLOW_UPLOAD_THRESHOLD_MS);

            const reader = new FileReader();
            reader.onload = () => {
              const base64 = (reader.result as string).split(",")[1] ?? "";

              setAttachedImages((prev) =>
                prev.map((img) =>
                  img.localId === localId ? { ...img, data: base64, uploadState: "uploading" as const } : img
                )
              );

              uploadAttachments([file])
                .then((results) => {
                  clearTimeout(slowUploadTimer);
                  setAttachedImages((prev) =>
                    prev.map((img) =>
                      img.localId === localId
                        ? { ...img, uploadState: "uploaded" as const, serverId: results[0]?.id, showSlowSpinner: false }
                        : img
                    )
                  );
                  resolve();
                })
                .catch(() => {
                  clearTimeout(slowUploadTimer);
                  setAttachedImages((prev) =>
                    prev.map((img) =>
                      img.localId === localId ? { ...img, uploadState: "failed" as const, showSlowSpinner: false } : img
                    )
                  );
                  resolve();
                });
            };
            reader.readAsDataURL(file);
          });
        })
      );
    },
    [attachedImages.length, pushNotification, MAX_FILE_SIZE, SLOW_UPLOAD_THRESHOLD_MS]
  );

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (files && files.length > 0) {
        addImagesFromFileList(files);
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [addImagesFromFileList]
  );

  /**
   * Stable key derived purely from attachment content so the key for the same
   * image doesn't change when sibling entries are added/removed (dropping the
   * list index keeps existing keys intact across mutations).
   */
  const draftAttachmentKey = useCallback((att: ImageAttachment): string => {
    return `${att.name ?? "image"}|${att.mimeType}|${att.data.length}|${att.data.slice(0, 64)}`;
  }, []);

  useEffect(() => {
    const list = draftAttachments ?? [];
    const keys = list.map((att) => draftAttachmentKey(att));

    // Prune keys that are no longer present so future truly-new attachments can hydrate.
    const nextKeySet = new Set(keys);
    for (const key of [...consumedDraftAttachmentKeysRef.current]) {
      if (!nextKeySet.has(key)) {
        consumedDraftAttachmentKeysRef.current.delete(key);
      }
    }

    setAttachedImages((prev) => {
      const existingLocalIds = new Set(prev.map((img) => img.localId));
      const additions: ImageAttachmentState[] = [];

      for (let i = 0; i < list.length; i += 1) {
        const att = list[i]!;
        const key = keys[i]!;
        const localId = `draft:${key}`;
        if (consumedDraftAttachmentKeysRef.current.has(key) || existingLocalIds.has(localId)) {
          continue;
        }
        consumedDraftAttachmentKeysRef.current.add(key);
        additions.push({
          localId,
          mimeType: att.mimeType,
          data: att.data,
          name: att.name,
          uploadState: "uploaded",
          showSlowSpinner: false,
        });
      }

      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
  }, [draftAttachments, draftAttachmentKey]);

  /**
   * Drop capture metadata whose `⟦design:<id>⟧` token is no longer present in
   * the composer text (user backspaced over the unicode brackets and deleted
   * the pill). Keeps persisted drafts from accumulating orphaned entries.
   */
  useEffect(() => {
    if (!draftCaptures || !onDraftCapturesChange) return;
    const liveIds = new Set(findComposerCaptureTokens(value).map((t) => t.captureId));
    const kept: Record<string, DesignCapture> = {};
    let changed = false;
    for (const [id, cap] of Object.entries(draftCaptures)) {
      if (liveIds.has(id)) {
        kept[id] = cap;
      } else {
        changed = true;
      }
    }
    if (changed) {
      onDraftCapturesChange(Object.keys(kept).length > 0 ? kept : undefined);
    }
  }, [draftCaptures, onDraftCapturesChange, value]);

  const handleRemoveImage = useCallback(
    (localId: string) => {
      setAttachedImages((prev) => prev.filter((img) => img.localId !== localId));
      imageFilesRef.current.delete(localId);

      // If this image was hydrated from the persisted composer draft (prefix
      // `draft:`), also strip it from the draft so the next mount/reload
      // doesn't resurrect the deleted image.
      if (!localId.startsWith("draft:") || !onDraftAttachmentsChange) {
        return;
      }
      const removedKey = localId.slice("draft:".length);
      const current = draftAttachments ?? [];
      const next = current.filter((att) => draftAttachmentKey(att) !== removedKey);
      if (next.length === current.length) {
        return;
      }
      // Keep the key in `consumedDraftAttachmentKeysRef` so the hydration
      // effect (which runs right after `onDraftAttachmentsChange` updates the
      // draft) can't race us back to re-importing it.
      consumedDraftAttachmentKeysRef.current.add(removedKey);
      // Always pass the concrete list (possibly empty) — `undefined` is
      // interpreted as "no change" by the draft upsert reducer, which would
      // leave the deleted image in the persisted draft and resurrect it on
      // reload.
      onDraftAttachmentsChange(next);
    },
    [draftAttachments, draftAttachmentKey, onDraftAttachmentsChange]
  );

  const handleRetryImage = useCallback(
    (localId: string) => {
      const file = imageFilesRef.current.get(localId);
      if (!file) return;

      const slowUploadTimer = setTimeout(() => {
        setAttachedImages((prev) =>
          prev.map((img) =>
            img.localId === localId ? { ...img, showSlowSpinner: true } : img
          )
        );
      }, SLOW_UPLOAD_THRESHOLD_MS);

      setAttachedImages((prev) =>
        prev.map((img) =>
          img.localId === localId ? { ...img, uploadState: "uploading", showSlowSpinner: false } : img
        )
      );

      uploadAttachments([file])
        .then((results) => {
          clearTimeout(slowUploadTimer);
          setAttachedImages((prev) =>
            prev.map((img) =>
              img.localId === localId
                ? { ...img, uploadState: "uploaded" as const, serverId: results[0]?.id, showSlowSpinner: false }
                : img
            )
          );
        })
        .catch(() => {
          clearTimeout(slowUploadTimer);
          setAttachedImages((prev) =>
            prev.map((img) =>
              img.localId === localId ? { ...img, uploadState: "failed" as const, showSlowSpinner: false } : img
            )
          );
        });
    },
    []
  );

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    isDraggingRef.current = true;
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    isDraggingRef.current = false;
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      isDraggingRef.current = false;
      const files = event.dataTransfer.files;
      if (files && files.length > 0) {
        addImagesFromFileList(files);
      }
    },
    [addImagesFromFileList]
  );

  const insertTranscription = useCallback(
    (transcription: string) => {
      const next = buildInsertedTranscription(
        valueRef.current,
        selectionRef.current,
        transcription
      );
      setComposerValue(next.value);
      setComposerSelection(next.selection);
      setMenu(null);
      if (!hardwareInputEnabled && shouldAutoFocusTextInput()) {
        const targetOffset = next.selection.start;
        requestAnimationFrame(() => {
          const el = editorRef.current;
          if (el) {
            el.focus();
            setCaretOffset(el, targetOffset);
          }
        });
      }
    },
    [hardwareInputEnabled, setComposerSelection, setComposerValue]
  );

  const updateVoiceLevel = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) {
      return;
    }
    const values = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(values);
    let peak = 0;
    for (const value of values) {
      peak = Math.max(peak, Math.abs(value - 128) / 128);
    }
    setInputLevel((current) => current * 0.65 + peak * 0.35);
    animationFrameRef.current = requestAnimationFrame(updateVoiceLevel);
  }, []);

  const finishVoiceCapture = useCallback(async () => {
    const parts = chunksRef.current;
    chunksRef.current = [];
    const recorderMimeType =
      mediaRecorderRef.current?.mimeType || pickRecordingMimeType() || "audio/webm";
    mediaRecorderRef.current = null;
    await cleanupVoiceCapture(true);
    if (parts.length === 0) {
      setRecordingState("idle");
      return;
    }
    setRecordingState("transcribing");
    try {
      const blob = new Blob(parts, { type: recorderMimeType });
      const extension = recorderMimeType.includes("mp4")
        ? "mp4"
        : recorderMimeType.includes("ogg")
          ? "ogg"
          : "webm";
      const file = new File([blob], `composer-recording.${extension}`, {
        type: recorderMimeType,
      });
      const result = await transcribeAudio(file);
      insertTranscription(result.text);
    } catch (error) {
      flashComposerError(
        error instanceof Error ? error.message : "Voice transcription failed."
      );
    } finally {
      setRecordingState("idle");
    }
  }, [cleanupVoiceCapture, flashComposerError, insertTranscription]);

  const stopVoiceInput = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      return;
    }
    if (recorder.state !== "inactive") {
      setRecordingState("transcribing");
      recorder.stop();
      return;
    }
    void finishVoiceCapture();
  }, [finishVoiceCapture]);

  const startVoiceInput = useCallback(async () => {
    if (recordingState !== "idle") {
      return;
    }
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      flashComposerError("Voice capture is not available in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AudioContextCtor =
        window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioContextCtor) {
        throw new Error("Audio analysis is not available in this browser.");
      }
      const audioContext = new AudioContextCtor();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      mediaStreamRef.current = stream;
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;

      const mimeType = pickRecordingMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      });
      recorder.addEventListener("stop", () => {
        void finishVoiceCapture();
      });
      mediaRecorderRef.current = recorder;
      recorder.start(200);
      setRecordingState("recording");
      setInputLevel(0);
      updateVoiceLevel();
    } catch (error) {
      await cleanupVoiceCapture(true);
      flashComposerError(
        error instanceof Error
          ? error.message
          : "Could not start voice recording."
      );
    }
  }, [
    cleanupVoiceCapture,
    finishVoiceCapture,
    flashComposerError,
    recordingState,
    updateVoiceLevel,
  ]);

  const filteredAt = useMemo(
    () => (menu?.kind === "at" ? filterAtSuggestions(atSuggestions, menu.query) : []),
    [atSuggestions, menu]
  );
  const filteredSlashSections = useMemo(
    () =>
      menu?.kind === "slash"
        ? filterSlashMenuSections(slashMenuSections, menu.query)
        : [],
    [menu, slashMenuSections]
  );
  const flatSlashItems = useMemo(
    () => flattenSlashMenuSections(filteredSlashSections),
    [filteredSlashSections]
  );

  const isActive = hardwareInputEnabled
    ? isSurfaceActive(surfaceId)
    : hasFocus;
  const isExpanded = variant === "expanded";
  const showAgentShellGrowControls = agentShellDockHeightExpand && !isExpanded;

  useEffect(() => {
    const onShortcut = (event: Event) => {
      if (!isChatUiShortcutEvent(event)) return;
      const detail = event.detail;
      if (detail.target !== "composer") return;
      const root = composerRootRef.current;
      if (!root) return;
      const focused = document.activeElement;
      if (!focused || !root.contains(focused)) return;

      const run = (action: ChatComposerShortcutAction) => {
        switch (action) {
 case "openModelDropdown":
 if (!configLocked) setModelDropdownOpen(true);
 break;
 case "openModeDropdown":
 if (!configLocked && !modeLocked) setModeMenuOpenKey((k) => k + 1);
 break;
 case "openBackendDropdown":
 if (!configLocked) setBackendMenuOpenKey((k) => k + 1);
 break;
        case "toggleVoiceInput":
          if (recordingState === "transcribing" || busy || configLocked) return;
          if (recordingState === "recording") stopVoiceInput();
          else void startVoiceInput();
          break;
        case "startVoiceInput":
          if (recordingState === "idle" && !busy && !configLocked)
            void startVoiceInput();
          break;
        case "stopVoiceInput":
          if (recordingState === "recording") stopVoiceInput();
          break;
          case "toggleComposerExpand":
            if (busy || configLocked) return;
            if (showAgentShellGrowControls) {
              setAgentShellDockTall((t) => !t);
            } else if (isExpanded && onCollapseComposer) {
              onCollapseComposer();
            } else if (!isExpanded && onExpandComposer) {
              onExpandComposer();
            }
            break;
          case "attachImage":
            if (!busy && !configLocked) fileInputRef.current?.click();
            break;
          default:
            break;
        }
      };
      run(detail.action);
    };
    window.addEventListener(CHAT_UI_SHORTCUT_EVENT, onShortcut);
    return () => window.removeEventListener(CHAT_UI_SHORTCUT_EVENT, onShortcut);
  }, [
    busy,
    configLocked,
    isExpanded,
    modeLocked,
    onCollapseComposer,
    onExpandComposer,
    recordingState,
    showAgentShellGrowControls,
    startVoiceInput,
    stopVoiceInput,
  ]);

  const applyComposerDirectives = useCallback(
    (input: string): string => {
      const remainingLines: string[] = [];
      for (const rawLine of input.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith("/")) {
          remainingLines.push(rawLine);
          continue;
        }

        const modeMatch = line.match(/^\/mode\s+(.+)$/i);
        if (modeMatch) {
          if (modeLockedRef.current) {
            remainingLines.push(rawLine);
            continue;
          }
          const wanted = normalizeDirectiveToken(modeMatch[1] ?? "");
          const match = modeOptions?.find(
            (option) =>
              normalizeDirectiveToken(option.id) === wanted ||
              normalizeDirectiveToken(option.label) === wanted
          );
          if (match) {
            onModeChange(match.id);
            continue;
          }
        }

        const modelMatch = line.match(/^\/model\s+(.+)$/i);
        if (modelMatch) {
          const wanted = normalizeDirectiveToken(modelMatch[1] ?? "");
          const match = models.find(
            (candidate) =>
              normalizeDirectiveToken(candidate.modelValue ?? candidate.id) === wanted ||
              normalizeDirectiveToken(candidate.id) === wanted ||
              normalizeDirectiveToken(candidate.name) === wanted
          );
          if (match) {
            onModelChange(match);
            continue;
          }
        }

        const backendMatch = line.match(/^\/backend\s+(.+)$/i);
        if (backendMatch) {
          const wanted = normalizeDirectiveToken(backendMatch[1] ?? "");
          const match = backends.find(
            (candidate) =>
              normalizeDirectiveToken(candidate.id) === wanted ||
              normalizeDirectiveToken(candidate.label) === wanted
          );
          if (match) {
            onBackendChange(match.id);
            continue;
          }
        }

        const configMatch = line.match(/^\/set\s+(\S+)\s+(.+)$/i);
        if (configMatch) {
          const configToken = normalizeDirectiveToken(configMatch[1] ?? "");
          const wantedValue = normalizeDirectiveToken(configMatch[2] ?? "");
          const option = sessionConfigOptions?.find(
            (candidate) =>
              normalizeDirectiveToken(candidate.id) === configToken ||
              normalizeDirectiveToken(candidate.name) === configToken
          );
          const optionValue = option?.options.find(
            (candidate) =>
              normalizeDirectiveToken(candidate.value) === wantedValue ||
              normalizeDirectiveToken(candidate.name) === wantedValue
          );
          if (option && optionValue && onSessionConfigOptionChange) {
            onSessionConfigOptionChange(option.id, optionValue.value);
            continue;
          }
        }

        remainingLines.push(rawLine);
      }

      return remainingLines.join("\n").trim();
    },
    [
      backends,
      modeOptions,
      models,
      onBackendChange,
      onModeChange,
      onModelChange,
      onSessionConfigOptionChange,
      sessionConfigOptions,
    ]
  );

  useEffect(() => {
    valueRef.current = value;
    selectionRef.current = selection;
  }, [selection, value]);

  useEffect(() => {
    filteredAtRef.current = filteredAt;
    filteredSlashRef.current = flatSlashItems;
  }, [filteredAt, flatSlashItems]);

  useEffect(() => {
    return () => {
      void cleanupVoiceCapture(true);
    };
  }, [cleanupVoiceCapture]);

  useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  useEffect(() => {
    const trig = parseTriggerToken(value, selection.end);

    if (trig?.kind === "slash") {
      setModelDropdownOpen(false);
    }

    setMenu((prev) => {
      if (!trig) return prev === null ? prev : null;
      const next: MenuState = {
        kind: trig.kind,
        start: trig.start,
        end: trig.end,
        query: trig.query,
      };
      if (
        prev &&
        prev.kind === next.kind &&
        prev.start === next.start &&
        prev.end === next.end &&
        prev.query === next.query
      ) {
        return prev;
      }
      return next;
    });
  }, [selection.end, value]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [menu?.query, menu?.kind, menu?.start]);

  useLayoutEffect(() => {
    if (!menu || !editorRef.current) return;
    const rect =
      (hardwareInputEnabled
        ? caretRef.current?.getBoundingClientRect()
        : getCaretClientRect(editorRef.current)) ??
      editorRef.current.getBoundingClientRect();
    const gap = 6;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const maxHCap = 300;
    const spaceAbove = rect.top - 8;
    const spaceBelow = vh - rect.bottom - 8;
    const minAbove = 72;
    const preferAbove = spaceAbove >= minAbove || spaceAbove >= spaceBelow;
    const left = Math.max(8, Math.min(rect.left, vw - 368));

    if (preferAbove) {
      const maxHeight = Math.min(maxHCap, Math.max(120, spaceAbove - gap));
      const bottom = vh - rect.top + gap;
      setMenuPos({ placement: "above", bottom, left, maxHeight });
    } else {
      const maxHeight = Math.min(maxHCap, Math.max(120, spaceBelow - gap));
      const top = rect.bottom + gap;
      setMenuPos({ placement: "below", top, left, maxHeight });
    }
  }, [hardwareInputEnabled, menu, selection.end, value]);

  const pointerDownOutsideComposerEditor = useCallback((target: Node) => {
    return (
      target instanceof Element &&
      Boolean(target.closest("[data-ide-composer-floating-popover]"))
    );
  }, []);

  useClickOutside(
    editorRef,
    () => {
      setMenu(null);
      setModelDropdownOpen(false);
    },
    !!menu || modelDropdownOpen,
    [popoverRef],
    pointerDownOutsideComposerEditor
  );

  useEffect(() => {
    setComposerSelection(selectionRef.current);
  }, [setComposerSelection, value]);

  /**
   * Expand every `⟦design:<id>⟧` compact token into its full
   * `<design-capture>…</design-capture>` XML block so the LLM can see the
   * element HTML. Unknown captures (metadata lost to pruning / reload) keep
   * the raw token as a signal — better than silently sending nothing.
   */
  const expandDesignCaptureTokens = useCallback(
    (text: string): string => {
      if (!text.includes("\u27E6design:")) return text;
      const caps = draftCaptures ?? {};
      return text.replace(
        new RegExp(COMPOSER_CAPTURE_TOKEN_REGEX.source, "g"),
        (match, id: string) => {
          const cap = caps[id];
          if (!cap) return match;
          return buildDesignCaptureBlock(cap);
        }
      );
    },
    [draftCaptures]
  );

  const submitComposer = useCallback(async (delivery: "normal" | "steer" = "normal") => {
    const trimmed = valueRef.current.trim();
    if (!trimmed && attachedImages.length === 0) {
      return;
    }
    const directed = applyComposerDirectives(trimmed);
    const promptText = expandDesignCaptureTokens(directed);
    const imagesToSubmit: ImageAttachment[] = attachedImages.map(({ mimeType, data, name }) => ({
      mimeType,
      data,
      name,
    }));
    const promptKey = JSON.stringify({
      text: promptText,
      delivery,
      attachments: imagesToSubmit.map((image) => ({
        mimeType: image.mimeType,
        name: image.name,
        dataLength: image.data.length,
      })),
    });
    if (submittingPromptKeyRef.current === promptKey) {
      return;
    }
    submittingPromptKeyRef.current = promptKey;
    // Empty the contenteditable synchronously so selection/input handlers cannot
    // push stale text into controlled draft state before the next reconcile.
    if (!hardwareInputEnabled) {
      const el = editorRef.current;
      if (el) {
        reconcilingRef.current = true;
        reconcileComposerEditorDom(el, "", undefined);
        queueMicrotask(() => {
          reconcilingRef.current = false;
        });
      }
    }
    valueRef.current = "";
    setComposerValue("");
    setComposerSelection({ start: 0, end: 0 });
    setMenu(null);
    setAttachedImages([]);
    onDraftAttachmentsChange?.([]);
    if (onDraftCapturesChange) {
      onDraftCapturesChange(undefined);
    }
    if (promptText || imagesToSubmit.length > 0) {
      void Promise.resolve(onSubmit(promptText, imagesToSubmit, { delivery }))
        .catch(() => undefined)
        .finally(() => {
          if (submittingPromptKeyRef.current === promptKey) {
            submittingPromptKeyRef.current = null;
          }
        });
    } else if (submittingPromptKeyRef.current === promptKey) {
      submittingPromptKeyRef.current = null;
    }
  }, [
    applyComposerDirectives,
    attachedImages,
    expandDesignCaptureTokens,
    hardwareInputEnabled,
    onDraftAttachmentsChange,
    onDraftCapturesChange,
    onSubmit,
    setComposerSelection,
    setComposerValue,
  ]);

  const syncNativeState = useCallback(() => {
    if (hardwareInputEnabled || reconcilingRef.current) return;
    const el = editorRef.current;
    if (!el) return;
    const text = getComposerPlainText(el);
    const caret = getCaretOffset(el);
    setComposerValue(text);
    setComposerSelection({ start: caret, end: caret });
  }, [hardwareInputEnabled, setComposerSelection, setComposerValue]);

  /**
   * Map captures into the minimal shape the DOM reconciler needs. Memoized so
   * a stable reference doesn't force an extra reconcile when the captures
   * object is deeply equal but referentially new.
   */
  const pillDescriptors = useMemo<Record<string, ComposerPillDescriptor> | undefined>(() => {
    if (!draftCaptures) return undefined;
    const out: Record<string, ComposerPillDescriptor> = {};
    for (const [id, cap] of Object.entries(draftCaptures)) {
      out[id] = { captureId: cap.id, label: cap.label, snippet: cap.snippet };
    }
    return out;
  }, [draftCaptures]);

  useEffect(() => {
    if (hardwareInputEnabled) return;
    const el = editorRef.current;
    if (!el) return;
    if (!composerEditorDomInSync(el, value)) {
      reconcilingRef.current = true;
      reconcileComposerEditorDom(el, value, pillDescriptors);
      queueMicrotask(() => { reconcilingRef.current = false; });
    }
  }, [hardwareInputEnabled, pillDescriptors, value]);

  useEffect(() => {
    if (hardwareInputEnabled) return;
    const el = editorRef.current;
    if (!el) return;
    const doc = el.ownerDocument;
    const onSelectionChange = () => {
      const box = editorRef.current;
      if (!box) return;
      const sel = doc.getSelection();
      if (!sel?.anchorNode || !box.contains(sel.anchorNode)) return;
      syncNativeState();
    };
    doc.addEventListener("selectionchange", onSelectionChange);
    return () => doc.removeEventListener("selectionchange", onSelectionChange);
  }, [hardwareInputEnabled, syncNativeState]);

  const pickAt = useCallback(
    (item: AtSuggestion) => {
      const currentMenu = menuRef.current;
      if (!currentMenu || currentMenu.kind !== "at") return;
      if (!hardwareInputEnabled && editorRef.current) {
        replaceTextRange(
          editorRef.current,
          currentMenu.start,
          currentMenu.end,
          `${item.insert} `
        );
        syncNativeState();
        setMenu(null);
        return;
      }
      const next = replaceSelection(
        valueRef.current,
        { start: currentMenu.start, end: currentMenu.end },
        `${item.insert} `
      );
      setComposerValue(next.value);
      setComposerSelection(next.selection);
      setMenu(null);
    },
    [hardwareInputEnabled, setComposerSelection, setComposerValue, syncNativeState]
  );

  const tryCycleBackendWithCtrlShiftTab = useCallback(
    (
      event: Pick<
        KeyboardEvent,
        "key" | "shiftKey" | "ctrlKey" | "metaKey" | "preventDefault"
      >,
      obstructed: boolean
    ): boolean => {
      const mod = event.metaKey || event.ctrlKey;
      if (event.key !== "Tab" || !event.shiftKey || !mod || obstructed) {
        return false;
      }
 if (configLocked) {
 return false;
 }
 const cyclable = backends.filter((b) => b.available);
 if (cyclable.length < 2) {
 return false;
 }
 event.preventDefault();
      let idx = cyclable.findIndex((b) => b.id === backendId);
      if (idx < 0) {
        idx = 0;
      }
      const next = cyclable[(idx + 1) % cyclable.length]!;
      if (next.id !== backendId) {
        if (onRequestHandoff) {
          onRequestHandoff(next.id);
        } else {
          onBackendChange(next.id);
        }
      }
      setBackendLabelPeekKey((k) => k + 1);
      return true;
    },
 [
 backendId,
 backends,
 configLocked,
 onBackendChange,
 onRequestHandoff,
 ]
 );

  const tryCycleModeWithShiftTab = useCallback(
    (
      event: Pick<
        KeyboardEvent,
        "key" | "shiftKey" | "ctrlKey" | "metaKey" | "preventDefault"
      >,
      obstructed: boolean
    ): boolean => {
      if (event.key !== "Tab" || !event.shiftKey || obstructed) {
        return false;
      }
      if (event.metaKey || event.ctrlKey) {
        return false;
      }
 if (configLocked || modeLocked) {
 return false;
 }
 const opts = ensureCurrentModeOption(
 mode,
 modeOptions?.length ? modeOptions : DEFAULT_MODE_OPTIONS
 );
      if (opts.length === 0) {
        return false;
      }
      event.preventDefault();
      const canonical = resolveCanonicalModeId(String(mode), opts);
      let idx = opts.findIndex((o) => o.id === canonical);
      if (idx < 0) {
        idx = 0;
      }
      const next = opts[(idx + 1) % opts.length]!;
      onModeChange(next.id as EditorMode);
      setModeLabelPeekKey((k) => k + 1);
      return true;
    },
    [configLocked, mode, modeLocked, modeOptions, onModeChange]
  );

  const clearSlashTrigger = useCallback(() => {
    const currentMenu = menuRef.current;
    if (!currentMenu || currentMenu.kind !== "slash") return;
    if (!hardwareInputEnabled && editorRef.current) {
      replaceTextRange(editorRef.current, currentMenu.start, currentMenu.end, "");
      syncNativeState();
    } else {
      const next = replaceSelection(
        valueRef.current,
        { start: currentMenu.start, end: currentMenu.end },
        ""
      );
      setComposerValue(next.value);
      setComposerSelection(next.selection);
    }
    setMenu(null);
  }, [hardwareInputEnabled, setComposerSelection, setComposerValue, syncNativeState]);

  const pickSlashItem = useCallback(
    (item: SlashMenuItem) => {
      const currentMenu = menuRef.current;
      if (!currentMenu || currentMenu.kind !== "slash") return;
      if (configLocked || modeLocked || item.disabled) return;

      const action = item.action;
      switch (action.kind) {
        case "mode":
          onModeChange(action.modeId);
          clearSlashTrigger();
          return;
        case "model":
          onModelChange(action.model);
          clearSlashTrigger();
          return;
        case "backend": {
          const match = backends.find((entry) => entry.id === action.backendId);
          if (match?.available) {
            onBackendChange(action.backendId);
          }
          clearSlashTrigger();
          return;
        }
        case "config":
          onSessionConfigOptionChange?.(action.configId, action.value);
          clearSlashTrigger();
          return;
        case "insert":
          break;
        default: {
          const exhaustive: never = action;
          return exhaustive;
        }
      }

      if (!hardwareInputEnabled && editorRef.current) {
        replaceTextRange(
          editorRef.current,
          currentMenu.start,
          currentMenu.end,
          `${action.insert}`
        );
        syncNativeState();
        setMenu(null);
        return;
      }
      const next = replaceSelection(
        valueRef.current,
        { start: currentMenu.start, end: currentMenu.end },
        `${action.insert}`
      );
      setComposerValue(next.value);
      setComposerSelection(next.selection);
      setMenu(null);
    },
    [
      backends,
      clearSlashTrigger,
      configLocked,
      modeLocked,
      hardwareInputEnabled,
      onBackendChange,
      onModeChange,
      onModelChange,
      onSessionConfigOptionChange,
      setComposerSelection,
      setComposerValue,
      syncNativeState,
    ]
  );

  /**
   * Replace the composer value with `next` and snap the caret to the
   * appropriate end. For history recall we collapse the caret to the end of
   * the recalled text when stepping older (feels like the terminal's behavior
   * of dropping the caret right after the resurrected command), and also when
   * stepping newer so the user can keep editing immediately. For hardware
   * input surfaces the caret is driven from React state; for native
   * contenteditable we also set the DOM caret so subsequent keystrokes
   * continue typing at the right spot.
   */
  const setComposerContents = useCallback(
    (next: string) => {
      setComposerValue(next);
      const caret = next.length;
      setComposerSelection({ start: caret, end: caret });
      if (!hardwareInputEnabled) {
        const el = editorRef.current;
        if (el) {
          reconcilingRef.current = true;
          reconcileComposerEditorDom(el, next, pillDescriptors);
          setCaretOffset(el, caret);
          queueMicrotask(() => {
            reconcilingRef.current = false;
          });
        }
      }
    },
    [hardwareInputEnabled, pillDescriptors, setComposerSelection, setComposerValue]
  );

  /**
   * Reset history traversal when the user types / clicks / pastes anything
   * that changes the composer value away from the currently-recalled entry.
   * Without this the user could step into history, edit the recalled text,
   * and then have ArrowDown silently discard the edit.
   */
  useEffect(() => {
    if (userHistoryIndex < 0) {
      return;
    }
    const history = userMessageHistoryRef.current ?? [];
    const expected = history[userHistoryIndex];
    if (expected === undefined || expected !== value) {
      setUserHistoryIndex(-1);
      setUserHistoryDraftSnapshot(null);
    }
  }, [userHistoryIndex, userMessageHistory, value]);

  /**
   * True when Up should pull in a past user message instead of moving the
   * caret up a line. We only grab the key when the selection is collapsed at
   * offset 0 (start of content) AND there is history to walk into — otherwise
   * normal caret movement wins. Returns `"consumed"` if the event was
   * handled, `"request-older"` to signal the host that a paginated older page
   * should be fetched, or `"pass"` to let the default handler run.
   */
  const tryRecallOlderUserMessage = useCallback((): "consumed" | "request-older" | "pass" => {
    const sel = selectionRef.current;
    if (sel.start !== sel.end || sel.start !== 0) {
      return "pass";
    }
    const history = userMessageHistoryRef.current ?? [];
    const currentIndex = userHistoryIndexRef.current;
    const nextIndex = currentIndex + 1;
    if (nextIndex >= history.length) {
      // No more loaded history. If the host can page in older messages, ask
      // for them — the user can press Up again once the render settles.
      if (hasMoreOlderUserMessageHistoryRef.current && onRequestOlderUserMessageHistoryRef.current) {
        onRequestOlderUserMessageHistoryRef.current();
        return "request-older";
      }
      return "pass";
    }
    if (currentIndex < 0) {
      setUserHistoryDraftSnapshot(valueRef.current);
    }
    setUserHistoryIndex(nextIndex);
    setComposerContents(history[nextIndex]!);
    return "consumed";
  }, [setComposerContents]);

  /**
   * Down arrow counterpart. When at the end of the composer content we step
   * forward in history (older -> newer). Stepping past the newest entry
   * restores the original draft the user was editing before they started
   * recalling; if there was no recall active, Down at end-of-content clears
   * the composer so the user can quickly wipe unwanted content.
   */
  const tryRecallNewerUserMessage = useCallback((): "consumed" | "pass" => {
    const sel = selectionRef.current;
    const valueLen = valueRef.current.length;
    if (sel.start !== sel.end || sel.start !== valueLen) {
      return "pass";
    }
    const history = userMessageHistoryRef.current ?? [];
    const currentIndex = userHistoryIndexRef.current;
    if (currentIndex < 0) {
      // Not traversing history. Down at end with content present wipes the
      // composer per the Linear issue spec; Down at end with an empty
      // composer passes through (let default key handling win).
      if (valueLen === 0) {
        return "pass";
      }
      setComposerContents("");
      return "consumed";
    }
    if (currentIndex === 0) {
      // About to fall off the newest entry — restore the original draft.
      const snapshot = userHistoryDraftSnapshotRef.current ?? "";
      setUserHistoryIndex(-1);
      setUserHistoryDraftSnapshot(null);
      setComposerContents(snapshot);
      return "consumed";
    }
    const nextIndex = currentIndex - 1;
    setUserHistoryIndex(nextIndex);
    setComposerContents(history[nextIndex]!);
    return "consumed";
  }, [setComposerContents]);

  const refreshNativeComposerRefs = useCallback(() => {
    if (hardwareInputEnabled) {
      return;
    }
    const el = editorRef.current;
    if (!el) {
      return;
    }
    valueRef.current = getComposerPlainText(el);
    const plainRange = getPlainTextRangeOffsets(el);
    if (plainRange) {
      selectionRef.current = plainRange;
      return;
    }
    const caret = getCaretOffset(el);
    selectionRef.current = { start: caret, end: caret };
  }, [hardwareInputEnabled]);

  const tryClearModeChipWithBackspace = useCallback(
    (
      event: Pick<
        KeyboardEvent,
        "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "preventDefault"
      >
    ): boolean => {
      const currentMode = modeRef.current;
      if (
        !isPlainBackspaceKey(event) ||
        configLockedRef.current ||
        modeLockedRef.current ||
        !canBackspaceClearModeChipRef.current ||
        !isNewDesignModeChipVisible(currentMode) ||
        valueRef.current.length !== 0
      ) {
        return false;
      }
      const defaultMode = resolveDefaultModeForOptions(modeOptionsRef.current);
      if (currentMode === defaultMode) {
        return false;
      }
      event.preventDefault();
      onModeChange(defaultMode);
      return true;
    },
    [onModeChange]
  );

  const handleComposerKey = useCallback(
    (event: globalThis.KeyboardEvent) => {
      const currentMenu = menuRef.current;
      const items =
        currentMenu?.kind === "at"
          ? filteredAtRef.current
          : filteredSlashRef.current;

      if (currentMenu && event.key === "Escape") {
        event.preventDefault();
        setMenu(null);
        setModelDropdownOpen(false);
        return true;
      }
      if (currentMenu && isArrowDownKey(event)) {
        event.preventDefault();
        if (items.length === 0) return true;
        setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
        return true;
      }
      if (currentMenu && isArrowUpKey(event)) {
        event.preventDefault();
        if (items.length === 0) return true;
        setSelectedIndex((i) => Math.max(0, i - 1));
        return true;
      }
      if (
        currentMenu &&
        event.key === "Enter" &&
        !event.shiftKey &&
        items.length > 0
      ) {
        event.preventDefault();
        const idx = Math.min(selectedIndexRef.current, items.length - 1);
        if (currentMenu.kind === "at") {
          pickAt(items[idx] as AtSuggestion);
        } else {
          pickSlashItem(items[idx] as SlashMenuItem);
        }
        return true;
      }
      if (
        !currentMenu &&
        event.key === "Enter" &&
        shouldSubmitComposerOnEnter(event, {
          hasHardwareKeyboard,
          submitCtrlEnter,
        })
      ) {
        event.preventDefault();
        void submitComposer(
          steerCtrlEnter && (event.ctrlKey || event.metaKey) ? "steer" : "normal"
        );
        return true;
      }

      if (
        tryCycleBackendWithCtrlShiftTab(
          event,
          Boolean(currentMenu) || modelDropdownOpen
        )
      ) {
        return true;
      }

      if (
        tryCycleModeWithShiftTab(event, Boolean(currentMenu) || modelDropdownOpen)
      ) {
        return true;
      }

      if (!currentMenu && tryClearModeChipWithBackspace(event)) {
        return true;
      }

      if (
        !currentMenu &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        isArrowUpKey(event)
      ) {
        const outcome = tryRecallOlderUserMessage();
        if (outcome !== "pass") {
          event.preventDefault();
          return true;
        }
      }

      if (
        !currentMenu &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        isArrowDownKey(event)
      ) {
        const outcome = tryRecallNewerUserMessage();
        if (outcome === "consumed") {
          event.preventDefault();
          return true;
        }
      }

      const next = applyTextBufferKey(
        valueRef.current,
        selectionRef.current,
        event,
        {
          multiline: true,
        }
      );
      if (!next.handled) return false;
      event.preventDefault();
      if (next.value !== valueRef.current) {
        setComposerValue(next.value);
      }
      setComposerSelection(next.selection);
      return true;
    },
  [
    hasHardwareKeyboard,
    modelDropdownOpen,
    pickAt,
    pickSlashItem,
    setComposerSelection,
    setComposerValue,
    submitComposer,
    submitCtrlEnter,
    steerCtrlEnter,
    tryClearModeChipWithBackspace,
    tryCycleBackendWithCtrlShiftTab,
    tryCycleModeWithShiftTab,
    tryRecallNewerUserMessage,
    tryRecallOlderUserMessage,
  ]
);

const handleNativeComposerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const native = event.nativeEvent;
      const currentMenu = menuRef.current;
      if (!currentMenu) {
        if (
          tryCycleBackendWithCtrlShiftTab(
            native,
            modelDropdownOpen
          )
        ) {
          return;
        }
        if (tryCycleModeWithShiftTab(native, modelDropdownOpen)) {
          return;
        }

        if (isPlainBackspaceKey(native)) {
          refreshNativeComposerRefs();
          if (tryClearModeChipWithBackspace(native)) {
            return;
          }
        }

        if (
          !event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          (isArrowUpKey(native) || isArrowDownKey(native))
        ) {
          // Sync the selection refs with the live DOM caret before running the
          // recall predicate; React state can lag one frame behind
          // `selectionchange`, so reading only from `selectionRef` would
          // occasionally miss "caret at start/end" and let the browser's
          // default line-move fire first.
          const el = editorRef.current;
          if (el) {
            const plainRange = getPlainTextRangeOffsets(el);
            if (plainRange) {
              selectionRef.current = plainRange;
            } else {
              const caret = getCaretOffset(el);
              selectionRef.current = { start: caret, end: caret };
            }
            valueRef.current = getComposerPlainText(el);
          }
          if (isArrowUpKey(native)) {
            const outcome = tryRecallOlderUserMessage();
            if (outcome !== "pass") {
              event.preventDefault();
              return;
            }
          } else {
            const outcome = tryRecallNewerUserMessage();
            if (outcome === "consumed") {
              event.preventDefault();
              return;
            }
          }
        }
        if (
          event.key === "Enter" &&
          shouldSubmitComposerOnEnter(event.nativeEvent, {
            hasHardwareKeyboard,
            submitCtrlEnter,
          })
        ) {
          event.preventDefault();
          void submitComposer(
            steerCtrlEnter && (event.ctrlKey || event.metaKey) ? "steer" : "normal"
          );
        }
        return;
      }
      const items =
        currentMenu.kind === "at" ? filteredAt : flatSlashItems;

      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(null);
        setModelDropdownOpen(false);
        return;
      }
      if (isArrowDownKey(native)) {
        event.preventDefault();
        if (items.length === 0) return;
        setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
        return;
      }
      if (isArrowUpKey(native)) {
        event.preventDefault();
        if (items.length === 0) return;
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && items.length > 0) {
        event.preventDefault();
        const idx = Math.min(selectedIndex, items.length - 1);
        if (currentMenu.kind === "at") {
          pickAt(items[idx] as AtSuggestion);
        } else {
          pickSlashItem(items[idx] as SlashMenuItem);
        }
        return;
      }
    },
    [
    filteredAt,
    flatSlashItems,
    hasHardwareKeyboard,
      modelDropdownOpen,
      pickAt,
      pickSlashItem,
      selectedIndex,
      submitComposer,
      submitCtrlEnter,
      steerCtrlEnter,
      refreshNativeComposerRefs,
      tryClearModeChipWithBackspace,
      tryCycleBackendWithCtrlShiftTab,
      tryCycleModeWithShiftTab,
      tryRecallNewerUserMessage,
      tryRecallOlderUserMessage,
    ]
  );

  useEffect(() => {
    if (!hardwareInputEnabled) {
      unregisterSurface(surfaceId);
      return;
    }

    registerSurface(surfaceId, {
      id: surfaceId,
      kind: "chat",
      allowWorkbenchShortcuts: false,
      focusTarget: editorRef.current,
      onKeyDown: (event) => handleComposerKey(event),
      onPaste: (text) => {
        const next = replaceSelection(
          valueRef.current,
          selectionRef.current,
          text
        );
        setComposerValue(next.value);
        setComposerSelection(next.selection);
        return true;
      },
      onCopy: () => {
        const currentSelection = selectionRef.current;
        if (currentSelection.start === currentSelection.end) return null;
        return valueRef.current.slice(
          currentSelection.start,
          currentSelection.end
        );
      },
      onCut: () => {
        const currentSelection = selectionRef.current;
        if (currentSelection.start === currentSelection.end) return null;
        const selected = valueRef.current.slice(
          currentSelection.start,
          currentSelection.end
        );
        const next = replaceSelection(
          valueRef.current,
          currentSelection,
          ""
        );
        setComposerValue(next.value);
        setComposerSelection(next.selection);
        return selected;
      },
    });

    return () => unregisterSurface(surfaceId);
  }, [
    handleComposerKey,
    hardwareInputEnabled,
    registerSurface,
    setComposerSelection,
    setComposerValue,
    surfaceId,
    unregisterSurface,
  ]);

  const shellMx =
    shellMxClass !== undefined ? shellMxClass : "mx-0 @min-[481px]:mx-[10px]";
  const shellMargin =
    isExpanded
      ? ""
      : layout === "empty-top"
      ? `${shellMx} mt-[2px] mb-0`.trim()
      : `${shellMx} mb-[10px]`.trim();
  const shellChrome = isExpanded
    ? "h-full min-h-0 gap-0 rounded-none border-0 bg-[var(--bg-main)] p-0"
    : "gap-[10px] overflow-hidden rounded-[var(--agent-composer-radius)] border border-[var(--agent-border)] bg-[var(--agent-card-bg)] p-[10px]";
  const editorRegionClassName = isExpanded
    ? "flex min-h-0 flex-1 flex-col"
    : "";
  const controlRowClassName = isExpanded
    ? "px-[10px] pb-[10px] pt-[8px]"
    : "";
  const textInsetClassName = isExpanded ? "px-[10px] py-[10px]" : "px-[1px] py-[1px]";

  const modeModelPopoverPlacement =
    isExpanded ? "above" : layout === "empty-top" ? "below" : "above";

  const textNodes = useMemo(
    () => renderComposerText(value, selection, isActive, caretRef, draftCaptures),
    [draftCaptures, isActive, selection, value]
  );
  const composerTrimmedLength = value.trim().length;
  const canSubmit = composerTrimmedLength > 0 || attachedImages.length > 0;
  const isCesiumAgent = backendId === "cesium-agent";
  const cesiumPausing =
    conversationStatus != null && isAgentCesiumPauseDraining(conversationStatus);
  const cesiumPaused = conversationStatus === "paused";
  const showCesiumTurnPill =
    isCesiumAgent &&
    Boolean(onCancel) &&
    Boolean(conversationStatus && isAgentCesiumTurnActive(conversationStatus)) &&
    ((busy && !canSubmit) || cesiumPaused || cesiumPausing);
  const cesiumTurnPill = showCesiumTurnPill ? (
    <CesiumTurnControlPill
      conversationStatus={conversationStatus}
      toneClass={sendButtonBgClass[getModeTone(mode)]}
      onPause={onPause}
      onResume={onResume}
      onStop={onCancel}
    />
  ) : null;
  /** While the turn is running, Stop occupies the primary (send) slot until there is something to queue. */
  const primaryControlIsStop = Boolean(
    busy && onCancel && !canSubmit && !showCesiumTurnPill
  );
  const primaryControlIsVoice = !primaryControlIsStop && !showCesiumTurnPill && !canSubmit;

  const { themeConfig } = useTheme();
  const isNewDesign = themeConfig.uiDesignMode === "new";
  /**
   * Flips when the contenteditable wraps beyond one visual line. The hook
   * attaches a single ResizeObserver + `input` listener on the editor ref and
   * returns a boolean; it's a cheap no-op when the editor ref hasn't attached
   * yet. Classic layout still reads the flag but ignores it.
   */
  const hookMeasuresMultiline = useComposerTextIsMultiLine(editorRef);
  /**
   * New-design docked composer: measuring multi-line while swapping layout
   * (single-row vs stacked) changes editor width and reflow, which can flip the
   * hook true/false in a tight loop. Once wrapped, stay in the multi-line shell
   * until the user clears all content (`value === ""`).
   */
  const [newDesignMultilineLatch, setNewDesignMultilineLatch] = useState(false);

  useEffect(() => {
    if (!shouldLatchComposerMultiline(value, hookMeasuresMultiline)) {
      setNewDesignMultilineLatch(false);
    }
  }, [hookMeasuresMultiline, value]);

  useEffect(() => {
    // After clearing, ResizeObserver can still see the old tall box until layout
    // settles; never re-latch multiline while the field is effectively empty.
    if (shouldLatchComposerMultiline(value, hookMeasuresMultiline)) {
      setNewDesignMultilineLatch(true);
    }
  }, [hookMeasuresMultiline, value]);

  const useNewDesignStickyMultiline =
    isNewDesign && variant === "docked" && !isExpanded;
  const isMultiLine = resolveComposerIsMultiLine({
    forceMultiline,
    useStickyMultiline: useNewDesignStickyMultiline,
    hookMeasuresMultiline,
    latchedMultiline: newDesignMultilineLatch,
    value,
  });
  canBackspaceClearModeChipRef.current =
    isNewDesign &&
    variant === "docked" &&
    !isExpanded &&
    !forceMultiline &&
    !isMultiLine &&
    attachedImages.length === 0 &&
    !(showAgentShellGrowControls && agentShellDockTall);

  /** `trim()` alone can't hide the overlay after Shift+Enter (`\\n`-only trims to ""). Treating lone `\\n` or phantom `<br>` as "has newline" broke empty inputs (Chrome serializes sentinel breaks as "\\n"). Hiding instead when wrapped past one line aligns with visible layout + soft breaks. */
  const showFloatingPlaceholder =
    composerTrimmedLength === 0 && !isMultiLine;

  const composerScrollFadeKey = [
    layout,
    value.length,
    isMultiLine,
    isExpanded,
    attachedImages.length,
    showAgentShellGrowControls,
    agentShellDockTall,
  ].join("\0");

  const { fade: composerEditorFade, onScroll: onComposerEditorScroll } =
    useComposerEditorScrollFade(editorRef, composerScrollFadeKey);

  const voiceButtonLabel =
    recordingState === "recording"
      ? "Stop voice input"
      : recordingState === "transcribing"
        ? "Transcribing voice input"
        : "Voice input";

  const handleVoiceButtonClick = () => {
    if (recordingState === "recording") {
      stopVoiceInput();
      return;
    }
    void startVoiceInput();
  };

  const renderVoiceButton = (variant: "primary" | "secondary"): ReactElement => {
    const isPrimary = variant === "primary";
    const buttonClassName = isPrimary
      ? `relative flex h-[20px] w-[20px] items-center justify-center rounded-full transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50 ${sendButtonBgClass[getModeTone(mode)]}`
      : `relative flex h-[20px] min-w-[20px] items-center justify-center rounded-full transition-colors ${
          recordingState === "recording" || recordingState === "transcribing"
            ? "bg-[var(--accent-bg)] text-[var(--text-primary)]"
            : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        } disabled:cursor-not-allowed disabled:opacity-50`;
    const primaryIconClassName = isPrimary ? "text-[var(--bg-main)]" : "";

    return (
      <button
        type="button"
        onClick={handleVoiceButtonClick}
        disabled={recordingState === "transcribing"}
        className={buttonClassName}
        aria-label={voiceButtonLabel}
        title={voiceButtonLabel}
      >
        {recordingState === "transcribing" ? (
          <LoaderCircle
            className={`size-[12px] shrink-0 animate-spin ${
              isPrimary ? "text-[var(--bg-main)]" : "text-[var(--text-primary)]"
            }`}
            strokeWidth={2.5}
            aria-hidden
          />
        ) : recordingState === "recording" ? (
          <span className={`flex h-[14px] items-center justify-center gap-[2.5px] ${primaryIconClassName}`}>
            {[0.35, 0.55, 0.4].map((scale, index) => (
              <span
                key={index}
                className="w-[2.5px] shrink-0 rounded-full bg-current"
                style={{
                  height: `${4 + Math.max(0.15, inputLevel * scale) * 10}px`,
                  opacity: 0.55 + inputLevel * 0.45,
                  transition: "height 80ms ease-out, opacity 80ms ease-out",
                  animation:
                    inputLevel > 0.08
                      ? "wave-bounce 280ms ease-in-out infinite alternate"
                      : "none",
                  animationDelay: `${index * 55}ms`,
                }}
              />
            ))}
          </span>
        ) : (
          <Mic className={`size-[14px] shrink-0 ${primaryIconClassName}`} strokeWidth={1.5} aria-hidden />
        )}
      </button>
    );
  };

  if (isNewDesign && variant === "docked" && !isExpanded) {
    const plusButton = (
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={configLocked}
        className="flex size-[22px] shrink-0 items-center justify-center rounded-full border border-[var(--agent-border)] bg-[var(--agent-plus-button-bg)] text-[var(--agent-plus-button-icon)] transition-colors hover:bg-[var(--agent-plus-button-bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Attach media"
        title="Attach media"
      >
        <Plus className="size-[13px] shrink-0" strokeWidth={2} aria-hidden />
      </button>
    );

    const modeChip = (
      <NewDesignModeChip
        mode={mode}
        options={modeOptions ?? DEFAULT_MODE_OPTIONS}
        onModeChange={onModeChange}
        disabled={configLocked || modeLocked}
        removable={!modeLocked}
      />
    );

    const leadingModeControls = (
      <div className="flex shrink-0 items-center gap-[6px]">
        {plusButton}
        {modeChip}
      </div>
    );

    const modelPill = (
      <ModelDropdown
        model={model}
        models={models}
        onModelChange={onModelChange}
        popoverPlacement={modeModelPopoverPlacement}
        disabled={configLocked}
        isOpen={modelDropdownOpen}
        onOpenChange={setModelDropdownOpen}
        backendId={backendId}
        backends={backends}
        onBackendChange={onBackendChange}
      />
    );

    const voiceButton = renderVoiceButton(
      primaryControlIsVoice ? "primary" : "secondary"
    );

    const sendButton = cesiumTurnPill ?? (
      primaryControlIsStop ? (
        <button
          type="button"
          onClick={() => void onCancel?.()}
          className={`flex h-[20px] w-[20px] items-center justify-center rounded-full transition-opacity hover:opacity-80 ${sendButtonBgClass[getModeTone(mode)]}`}
          aria-label="Stop"
        >
          <Square className="size-[9px] text-[var(--bg-main)]" fill="currentColor" strokeWidth={2.2} />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void submitComposer()}
          disabled={!canSubmit}
          className={`flex h-[20px] w-[20px] items-center justify-center rounded-full transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50 ${sendButtonBgClass[getModeTone(mode)]}`}
          aria-label={busy ? "Send or queue message" : "Send"}
        >
          <ArrowUp className="size-3 text-[var(--bg-main)]" strokeWidth={2.5} />
        </button>
      )
    );
    const primaryActionButton = cesiumTurnPill ?? (
      primaryControlIsVoice ? voiceButton : sendButton
    );

    /**
     * Single-line pill collapses to a fully circular shell so the composer
     * reads as one continuous capsule (Cursor 3.1). Multi-line falls back to
     * the squarer composer-radius so the bottom row corners stay tidy under a
     * tall editor.
     */
    const newDesignPillRadiusClass =
      isMultiLine || attachedImages.length > 0
        ? "rounded-[var(--agent-composer-radius)]"
        : "rounded-full";

    return (
      <div
        ref={composerRootRef}
        data-ide-input-sink
        className={`${shellMargin} flex shrink-0 flex-col gap-[8px] overflow-hidden ${newDesignPillRadiusClass} border border-[var(--agent-border)] bg-[var(--agent-card-bg)] p-[10px]`}
      >
        {attachedImages.length > 0 && (
          <ImageCarousel
            images={attachedImages}
            onRemove={handleRemoveImage}
            onRetry={handleRetryImage}
            size="compact"
          />
        )}

        {/* Main row: everything inline when single-line; editor-only when wrapped. */}
        <div
          className={
            isMultiLine
              ? "flex min-w-0"
              : "flex min-w-0 items-center gap-[10px]"
          }
        >
          {!isMultiLine ? leadingModeControls : null}
          <div
            key="editor-wrapper"
            className="relative min-w-0 flex-1"
          >
            <ComposerEditorScrollFades fade={composerEditorFade} />
            {showFloatingPlaceholder && (
              <span
                className={`pointer-events-none absolute left-0 right-0 top-0 z-10 block min-w-0 truncate font-sans text-[14px] font-normal text-[var(--text-secondary)] ${textInsetClassName}`}
                title={COMPOSER_PLACEHOLDER_TEXT}
              >
                {COMPOSER_PLACEHOLDER_TEXT}
              </span>
            )}
            <div
              ref={editorRef}
              onScroll={onComposerEditorScroll}
              contentEditable={!hardwareInputEnabled}
              suppressContentEditableWarning={!hardwareInputEnabled}
              tabIndex={hardwareInputEnabled ? 0 : undefined}
              onPointerDown={(event) => {
                if (hardwareInputEnabled) {
                  activateSurface(surfaceId, editorRef.current);
                  setComposerSelection(resolvePointerSelection(event, value.length));
                }
              }}
              onMouseUp={() => {
                if (!hardwareInputEnabled) {
                  syncNativeState();
                }
              }}
              onFocus={() => {
                setHasFocus(true);
                if (hardwareInputEnabled) {
                  activateSurface(surfaceId, editorRef.current);
                }
              }}
              onBlur={() => {
                setHasFocus(false);
                if (hardwareInputEnabled) {
                  deactivateSurface(surfaceId);
                }
              }}
              onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
                if (hardwareInputEnabled) {
                  return;
                }
                handleNativeComposerKeyDown(event);
              }}
              onInput={() => {
                if (!hardwareInputEnabled) {
                  syncNativeState();
                }
              }}
              onPaste={(event: ReactClipboardEvent<HTMLDivElement>) => {
                const cd = event.clipboardData;
                const imageFiles = collectClipboardImageFiles(cd);
                if (imageFiles.length > 0) {
                  event.preventDefault();
                  const dt = new DataTransfer();
                  for (const file of imageFiles) {
                    dt.items.add(file);
                  }
                  addImagesFromFileList(dt.files);
                  return;
                }

                const plain = clipboardPlainTextOnly(cd);
                event.preventDefault();

                if (hardwareInputEnabled) {
                  const next = replaceSelection(valueRef.current, selectionRef.current, plain);
                  setComposerValue(next.value);
                  setComposerSelection(next.selection);
                  return;
                }

                const el = editorRef.current;
                if (!el) {
                  return;
                }
                const range = getPlainTextRangeOffsets(el);
                const start = range?.start ?? getCaretOffset(el);
                const end = range?.end ?? start;
                replaceTextRange(el, start, end, plain);
                syncNativeState();
              }}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onCopy={(event: ReactClipboardEvent<HTMLDivElement>) => {
                if (!hardwareInputEnabled || selection.start === selection.end) return;
                event.preventDefault();
                event.clipboardData.setData(
                  "text/plain",
                  value.slice(selection.start, selection.end)
                );
              }}
              onCut={(event: ReactClipboardEvent<HTMLDivElement>) => {
                if (!hardwareInputEnabled || selection.start === selection.end) return;
                event.preventDefault();
                event.clipboardData.setData(
                  "text/plain",
                  value.slice(selection.start, selection.end)
                );
                const next = replaceSelection(value, selection, "");
                setComposerValue(next.value);
                setComposerSelection(next.selection);
              }}
              className={`whitespace-pre-wrap break-words font-sans text-[14px] font-normal text-[var(--text-primary)] outline-none [scrollbar-width:thin] ${textInsetClassName} min-h-[18px] overflow-y-auto ${
                showAgentShellGrowControls && agentShellDockTall
                  ? "max-h-[min(70vh,560px)]"
                  : "max-h-[min(42vh,240px)]"
              }${showAgentShellGrowControls ? " transition-[max-height] duration-300 ease-out" : ""}`}
              role={menu ? "combobox" : "textbox"}
              aria-label="Chat input"
              aria-expanded={menu ? true : undefined}
              aria-controls={menu ? "composer-autocomplete" : undefined}
              aria-autocomplete={menu ? "list" : undefined}
              aria-multiline
              data-hardware-input-surface={hardwareInputEnabled ? "" : undefined}
              data-hardware-surface-kind={hardwareInputEnabled ? "chat" : undefined}
            >
              {hardwareInputEnabled ? textNodes : null}
            </div>
          </div>
          {!isMultiLine ? modelPill : null}
          {!isMultiLine && !primaryControlIsVoice ? voiceButton : null}
          {!isMultiLine ? primaryActionButton : null}
        </div>

        {menu?.kind === "at" && (
          <ComposerAutocomplete
            items={filteredAt}
            selectedIndex={selectedIndex}
            position={menuPos}
            onSelect={pickAt}
            onHighlight={setSelectedIndex}
            listRef={listRef}
            popoverRef={popoverRef}
          />
        )}
        {menu?.kind === "slash" && (
          <ComposerSlashMenu
            sections={filteredSlashSections}
            flatItems={flatSlashItems}
            selectedIndex={selectedIndex}
            mode={mode}
            model={model}
            backendId={backendId}
            position={menuPos}
            onSelect={pickSlashItem}
            onHighlight={setSelectedIndex}
            listRef={listRef}
            popoverRef={popoverRef}
          />
        )}

        {isMultiLine ? (
          <div className="flex items-center justify-between gap-[8px]">
            <div className="flex min-w-0 items-center gap-[10px]">
              {leadingModeControls}
            </div>
            <div className="flex shrink-0 items-center gap-[9px]">
              <div className="min-w-0">{modelPill}</div>
              {!primaryControlIsVoice ? voiceButton : null}
              {primaryActionButton}
            </div>
          </div>
        ) : null}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleFileInputChange}
          className="hidden"
        />
      </div>
    );
  }

  const voiceButton = renderVoiceButton(
    primaryControlIsVoice ? "primary" : "secondary"
  );
  const sendButton = cesiumTurnPill ?? (
    primaryControlIsStop ? (
      <button
        type="button"
        onClick={() => void onCancel?.()}
        className={`flex h-[20px] w-[20px] items-center justify-center rounded-full transition-opacity hover:opacity-80 ${sendButtonBgClass[getModeTone(mode)]}`}
        aria-label="Stop"
      >
        <Square className="size-[9px] text-[var(--bg-main)]" fill="currentColor" strokeWidth={2.2} />
      </button>
    ) : (
      <button
        type="button"
        onClick={() => void submitComposer()}
        disabled={!canSubmit}
        className={`flex h-[20px] w-[20px] items-center justify-center rounded-full transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50 ${sendButtonBgClass[getModeTone(mode)]}`}
        aria-label={busy ? "Send or queue message" : "Send"}
      >
        <ArrowUp className="size-3 text-[var(--bg-main)]" strokeWidth={2.5} />
      </button>
    )
  );
  const primaryActionButton = cesiumTurnPill ?? (
    primaryControlIsVoice ? voiceButton : sendButton
  );

  return (
    <div
      ref={composerRootRef}
      data-ide-input-sink
      className={`${shellMargin} flex ${isExpanded ? "h-full min-h-0" : "shrink-0"} flex-col ${shellChrome}`}
    >
      <div
        className={`relative ${isExpanded ? "flex min-h-0 flex-1 flex-col" : ""} ${editorRegionClassName}`}
      >
        {attachedImages.length > 0 && (
          <ImageCarousel
            images={attachedImages}
            onRemove={handleRemoveImage}
            onRetry={handleRetryImage}
            size={isExpanded ? "expanded" : "compact"}
          />
        )}
        <div
          className={`relative min-w-0 ${
            isExpanded ? "flex min-h-0 flex-1 flex-col" : ""
          }`}
        >
        <ComposerEditorScrollFades
          fade={composerEditorFade}
          edgeVar={
            isExpanded ? "var(--bg-main)" : "var(--agent-card-bg)"
          }
        />
        {showFloatingPlaceholder && (
          <span
            className={`pointer-events-none absolute left-0 right-0 top-0 z-10 block min-w-0 truncate font-sans text-[14px] font-normal text-[var(--text-secondary)] ${textInsetClassName}`}
            title={COMPOSER_PLACEHOLDER_TEXT}
          >
            {COMPOSER_PLACEHOLDER_TEXT}
          </span>
        )}
        <div
          ref={editorRef}
          onScroll={onComposerEditorScroll}
          contentEditable={!hardwareInputEnabled}
          suppressContentEditableWarning={!hardwareInputEnabled}
          tabIndex={hardwareInputEnabled ? 0 : undefined}
          onPointerDown={(event) => {
            if (hardwareInputEnabled) {
              activateSurface(surfaceId, editorRef.current);
              setComposerSelection(resolvePointerSelection(event, value.length));
            }
          }}
          onMouseUp={() => {
            if (!hardwareInputEnabled) {
              syncNativeState();
            }
          }}
          onFocus={() => {
            setHasFocus(true);
            if (hardwareInputEnabled) {
              activateSurface(surfaceId, editorRef.current);
            }
          }}
          onBlur={() => {
            setHasFocus(false);
            if (hardwareInputEnabled) {
              deactivateSurface(surfaceId);
            }
          }}
          onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
            if (hardwareInputEnabled) {
              return;
            }
            handleNativeComposerKeyDown(event);
          }}
          onInput={() => {
            if (!hardwareInputEnabled) {
              syncNativeState();
            }
          }}
          onPaste={(event: ReactClipboardEvent<HTMLDivElement>) => {
            const cd = event.clipboardData;
            const imageFiles = collectClipboardImageFiles(cd);
            if (imageFiles.length > 0) {
              event.preventDefault();
              const dt = new DataTransfer();
              for (const file of imageFiles) {
                dt.items.add(file);
              }
              addImagesFromFileList(dt.files);
              return;
            }

            const plain = clipboardPlainTextOnly(cd);
            event.preventDefault();

            if (hardwareInputEnabled) {
              const next = replaceSelection(valueRef.current, selectionRef.current, plain);
              setComposerValue(next.value);
              setComposerSelection(next.selection);
              return;
            }

            const el = editorRef.current;
            if (!el) {
              return;
            }
            const range = getPlainTextRangeOffsets(el);
            const start = range?.start ?? getCaretOffset(el);
            const end = range?.end ?? start;
            replaceTextRange(el, start, end, plain);
            syncNativeState();
          }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onCopy={(event: ReactClipboardEvent<HTMLDivElement>) => {
            if (!hardwareInputEnabled || selection.start === selection.end) return;
            event.preventDefault();
            event.clipboardData.setData(
              "text/plain",
              value.slice(selection.start, selection.end)
            );
          }}
          onCut={(event: ReactClipboardEvent<HTMLDivElement>) => {
            if (!hardwareInputEnabled || selection.start === selection.end) return;
            event.preventDefault();
            event.clipboardData.setData(
              "text/plain",
              value.slice(selection.start, selection.end)
            );
            const next = replaceSelection(value, selection, "");
            setComposerValue(next.value);
            setComposerSelection(next.selection);
          }}
          className={`whitespace-pre-wrap break-words font-sans text-[14px] font-normal text-[var(--text-primary)] outline-none [scrollbar-width:thin] ${textInsetClassName} ${
            isExpanded
              ? "flex-1 overflow-y-auto pb-[2px]"
              : `min-h-[18px] overflow-y-auto ${
                  showAgentShellGrowControls && agentShellDockTall
                    ? "max-h-[min(70vh,560px)]"
                    : "max-h-[min(42vh,240px)]"
                }${showAgentShellGrowControls ? " transition-[max-height] duration-300 ease-out" : ""}`
          }`}
          role={menu ? "combobox" : "textbox"}
          aria-label="Chat input"
          aria-expanded={menu ? true : undefined}
          aria-controls={menu ? "composer-autocomplete" : undefined}
          aria-autocomplete={menu ? "list" : undefined}
          aria-multiline
          data-hardware-input-surface={hardwareInputEnabled ? "" : undefined}
          data-hardware-surface-kind={hardwareInputEnabled ? "chat" : undefined}
        >
          {hardwareInputEnabled ? textNodes : null}
        </div>
        </div>
      </div>

      {menu?.kind === "at" && (
        <ComposerAutocomplete
          items={filteredAt}
          selectedIndex={selectedIndex}
          position={menuPos}
          onSelect={pickAt}
          onHighlight={setSelectedIndex}
          listRef={listRef}
          popoverRef={popoverRef}
        />
      )}
      {menu?.kind === "slash" && (
        <ComposerSlashMenu
          sections={filteredSlashSections}
          flatItems={flatSlashItems}
          selectedIndex={selectedIndex}
          mode={mode}
          model={model}
          backendId={backendId}
          position={menuPos}
          onSelect={pickSlashItem}
          onHighlight={setSelectedIndex}
          listRef={listRef}
          popoverRef={popoverRef}
        />
      )}

      <div className={`flex items-start justify-between gap-[12px] ${controlRowClassName}`}>
        <div className="flex min-w-0 flex-1 flex-col gap-[6px]">
          <div className="flex w-full min-w-0 flex-nowrap items-center gap-[11px] overflow-hidden">
            <div className="shrink-0">
              <BackendDropdown
                backendId={backendId}
                backends={backends}
                onBackendChange={onBackendChange}
                onRequestHandoff={onRequestHandoff}
 popoverPlacement={modeModelPopoverPlacement}
 disabled={configLocked}
 labelPeekKey={backendLabelPeekKey}
                menuOpenTriggerKey={backendMenuOpenKey}
              />
            </div>
            <div className="shrink-0">
              <ModeDropdown
                mode={mode}
                onModeChange={onModeChange}
 popoverPlacement={modeModelPopoverPlacement}
 disabled={configLocked}
 modeLocked={modeLocked}
 options={modeOptions}
                labelPeekKey={modeLabelPeekKey}
                menuOpenTriggerKey={modeMenuOpenKey}
              />
            </div>
            <div className="min-w-0 shrink-0">
              <ModelDropdown
                model={model}
                models={models}
            onModelChange={onModelChange}
 popoverPlacement={modeModelPopoverPlacement}
 disabled={configLocked}
 isOpen={modelDropdownOpen}
                onOpenChange={setModelDropdownOpen}
              />
            </div>
          </div>
          {sessionConfigOptions && sessionConfigOptions.length > 0 && (
            <div className="flex max-w-full flex-wrap items-center gap-[8px]">
              {sessionConfigOptions.map((opt) => (
                <SessionConfigOptionDropdown
                  key={opt.id}
                  option={opt}
                  value={opt.currentValue}
                  popoverPlacement={modeModelPopoverPlacement}
                  disabled={configLocked || !onSessionConfigOptionChange}
                  onChange={(next) => onSessionConfigOptionChange?.(opt.id, next)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-[9px]">
          {showAgentShellGrowControls ? (
            agentShellDockTall ? (
              <button
                type="button"
                onClick={() => setAgentShellDockTall(false)}
                className="text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                aria-label="Shrink composer"
              >
                <Minimize2 className="size-[14px] shrink-0" strokeWidth={1.5} aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setAgentShellDockTall(true)}
                className="text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                aria-label="Expand composer height"
              >
                <Maximize2 className="size-[14px] shrink-0" strokeWidth={1.5} aria-hidden />
              </button>
            )
          ) : isExpanded && onCollapseComposer ? (
            <button
              type="button"
              onClick={onCollapseComposer}
              className="text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Minimize composer"
            >
              <Minimize2 className="size-[14px] shrink-0" strokeWidth={1.5} aria-hidden />
            </button>
          ) : !isExpanded ? (
            <button
              type="button"
              onClick={onExpandComposer}
              disabled={!onExpandComposer}
              className="text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Expand composer"
            >
              <Maximize2 className="size-[14px] shrink-0" strokeWidth={1.5} aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            aria-label="Upload image"
          >
            <ImageIcon className="size-[14px] shrink-0" strokeWidth={1.5} aria-hidden />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileInputChange}
            className="hidden"
          />
          {!primaryControlIsVoice ? voiceButton : null}
          {primaryActionButton}
        </div>
      </div>
    </div>
  );
}
