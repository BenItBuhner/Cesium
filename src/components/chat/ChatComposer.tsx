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
  FileText,
  Flame,
  GitBranch,
  Infinity as InfinityIcon,
  Layers,
  LayoutTemplate,
  ListChecks,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Mic,
  Minimize2,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import { ImageCarousel } from "./ImageCarousel";
import { ComposerAttachMenu } from "./ComposerAttachMenu";
import type { ImageAttachment, ImageAttachmentState } from "@/lib/types";
import {
  DESIGN_2_MODE_RECIPES,
  isComposerEffectivelyEmptyForMultiline,
  resolveComposerIsMultiLine,
  shouldLatchComposerMultiline,
  type Design2ModeTone,
} from "@cesium/design";
import {
  useComposerTextIsMultiLine,
  useComposerVisualLineCount,
} from "./composer-multiline";
import {
  COMPOSER_INLINE_MIN_EDITOR_WIDTH_PX,
  shouldCompactComposerInlineControls,
  useComposerInlineControlsOverflow,
} from "./composer-inline-overflow";

const COMPOSER_DOCK_HEIGHT_OVERLAY_MIN_LINES = 3;
const COMPOSER_DOCK_MAX_HEIGHT_DEFAULT = "max-h-[min(42vh,240px)]";
const COMPOSER_DOCK_MAX_HEIGHT_EXPANDED = "max-h-[min(70vh,560px)]";
const COMPOSER_BOTTOM_GAP_CLASS = "mb-[8px]";

function ComposerDockHeightOverlayButton({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="pointer-events-auto absolute right-[2px] top-[2px] z-20 flex size-[24px] items-center justify-center border-0 bg-transparent p-0 text-[var(--text-secondary)] shadow-none outline-none ring-0 transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-0"
      aria-label={expanded ? "Shrink composer" : "Expand composer height"}
      title={expanded ? "Shrink composer" : "Expand composer height"}
    >
      {expanded ? (
        <Minimize2 className="size-[14px] shrink-0" strokeWidth={1.5} aria-hidden />
      ) : (
        <Maximize2 className="size-[14px] shrink-0" strokeWidth={1.5} aria-hidden />
      )}
    </button>
  );
}
import { useComposerEditorScrollFade } from "./composer-editor-scroll-fade";
import { scrollEdgeMaskStyle } from "./scroll-edge-mask";
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
import { ComposerStatusBar } from "./ComposerStatusBar";
import { ComposerActionPills } from "./ComposerActionPills";
import { ContextBreakdownDock } from "./ContextBreakdownDock";
import { dockedComposerCardSlot } from "./docked-card";
import {
  ComposerAutocomplete,
  type ComposerPopoverPosition,
} from "./ComposerAutocomplete";
import { ComposerSlashMenu } from "./ComposerSlashMenu";
import {
  hasVisibleFollowingSibling,
  positionComposerCommandPanel,
  resolveComposerCommandPanelPlacement,
  type ComposerCommandPanelPosition,
} from "@/lib/composer-command-panel";
import { useClickOutside } from "@/hooks/useClickOutside";
import { useHardwareKeyboard } from "@/hooks/useHardwareKeyboard";
import { shouldSubmitComposerOnEnter } from "@/lib/composer-submit-key";
import {
  getAllAtSuggestions,
  filterAtSuggestions,
  getSlashMenuSections,
  filterSlashMenuSectionsForDisplay,
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
  recordComposerDomReport,
  reconcileComposerEditorDom,
  replaceTextRange,
  setCaretOffset,
  shouldDeferComposerReconcile,
  type ComposerDomReport,
  type ComposerPillDescriptor,
} from "./composer-editor-utils";
import {
  DEFAULT_MODE_OPTIONS,
  ensureCurrentModeOption,
  getModeTone,
  isGoalMode,
  resolveNextModeInCycle,
} from "@/lib/chat-modes";
import {
  clearDesktopTaskbarGoalProgress,
  markDesktopTaskbarGoalProgressSourceOpen,
  publishDesktopTaskbarGoalProgress,
  resolveDesktopTaskbarGoalProgress,
} from "@/lib/desktop-taskbar-progress";
import type { AgentModeOption, EditorMode, KnownEditorMode, ModelInfo } from "@/lib/types";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConfigOption,
  AgentConversationStatus,
  AgentSlashCommand,
} from "@/lib/agent-types";
import {
  isAgentCesiumTurnActive,
  isAgentCesiumPauseDraining,
  isNoModelPlaceholder,
  type GoalProgressStatus,
} from "@/lib/agent-chat";
import {
  composerStatusBarHasVisibleItems,
  resolveComposerStatusBarVisibilityForConversation,
} from "@/lib/composer-status-bar";
import { useAgentContextUsage } from "@/hooks/useAgentContextUsage";
import { CesiumTurnControlPill } from "@/components/chat/CesiumTurnControlPill";
import { useCesiumTurnPillMotion } from "@/components/chat/cesium-turn-control-motion";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  getServerBaseUrl,
  saveVoiceRecording,
  transcribeAudio,
  uploadAttachments,
} from "@/lib/server-api";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useTheme } from "@/components/theme/ThemeProvider";
import {
  buildDesignCaptureBlock,
  COMPOSER_CAPTURE_TOKEN_REGEX,
  findComposerCaptureTokens,
  type DesignCapture,
} from "@/lib/design-capture";
import {
  buildTextReferenceBlock,
  COMPOSER_TEXT_REFERENCE_TOKEN_REGEX,
  findComposerTextReferenceTokens,
  LONG_PASTE_REFERENCE_THRESHOLD_CHARS,
  makeComposerTextReferenceToken,
  type TextReference,
} from "@/lib/text-reference";
import {
  buildLinkMarkdown,
  COMPOSER_LINK_REFERENCE_TOKEN_REGEX,
  fallbackTitleFromUrl,
  findComposerLinkReferenceTokens,
  makeComposerLinkReferenceToken,
  tryParsePastedLinkUrl,
  type LinkReference,
} from "@/lib/link-reference";
import { resolveLinkPreview } from "@/lib/link-preview";
import { buildBrowserProxyUrl } from "@/lib/browser-proxy-url";
import {
  buildConversationReferenceBlock,
  COMPOSER_CONVERSATION_REFERENCE_TOKEN_REGEX,
  composerVisibleHarnesses,
  type AtConversationSource,
  type ConversationReference,
} from "@cesium/core";
import { useAgentShellStateMaybe } from "@/components/agent/AgentShellStateContext";
import { LinkAttachmentPill } from "@/components/chat/LinkAttachmentPill";

const sendButtonBgClass: Record<KnownEditorMode, string> = {
  agent: "bg-[var(--accent-dark)]",
  plan: "bg-[var(--plan-accent-dark)]",
  debug: "bg-[var(--debug-accent-dark)]",
  ask: "bg-[var(--ask-accent-dark)]",
  goal: "bg-[var(--goal-accent-dark)]",
  workflow: "bg-[var(--workflow-accent-dark)]",
  orchestration: "bg-[var(--orchestration-accent-dark)]",
};

const COMPOSER_PLACEHOLDER_TEXT =
  "Ask anything, @ for files, / for commands";

function design2ModeTone(tone: KnownEditorMode): Design2ModeTone {
  return tone;
}

function modeChipColors(tone: KnownEditorMode): { text: string; bg: string } {
  const recipe = DESIGN_2_MODE_RECIPES[design2ModeTone(tone)];
  return {
    text: `var(${recipe.textToken})`,
    bg: `var(${recipe.backgroundToken})`,
  };
}

function renderModeChipIcon(tone: KnownEditorMode, color: string): ReactElement {
  const className = "size-[13px] shrink-0";
  const strokeWidth = 1.5;
  switch (tone) {
    case "plan":
      return <ListChecks className={className} strokeWidth={strokeWidth} style={{ color }} />;
    case "debug":
      return <Bug className={className} strokeWidth={strokeWidth} style={{ color }} />;
    case "ask":
      return <MessageSquare className={className} strokeWidth={strokeWidth} style={{ color }} />;
    case "goal":
      return <Flame className={className} strokeWidth={strokeWidth} style={{ color }} />;
    case "workflow":
      return <GitBranch className={className} strokeWidth={strokeWidth} style={{ color }} />;
    case "orchestration":
      return <Layers className={className} strokeWidth={strokeWidth} style={{ color }} />;
    case "agent":
      return <InfinityIcon className={className} strokeWidth={strokeWidth} style={{ color }} />;
    default: {
      const exhaustive: never = tone;
      return exhaustive;
    }
  }
}

function isModeChipVisible(mode: EditorMode): boolean {
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

interface ModeChipProps {
  mode: EditorMode;
  options: AgentModeOption[];
  onModeChange: (mode: EditorMode) => void;
  disabled?: boolean;
  removable?: boolean;
  /**
   * Icon-only pill for narrow single-line composers. The whole pill becomes
   * the remove affordance (when removable) since there is no room for a
   * separate label + X.
   */
  compact?: boolean;
}

/**
 * Cursor 3.1-style mode chip. Hidden while mode resolves to `agent` (the
 * default); materializes with a small remove affordance for any other mode so
 * cycling Shift+Tab into Plan/Debug/Ask surfaces an obvious chip that can be
 * dismissed back to default without opening a menu.
 */
function ModeChip({
  mode,
  options,
  onModeChange,
  disabled,
  removable = true,
  compact = false,
}: ModeChipProps) {
  const tone = getModeTone(mode);
  if (!isModeChipVisible(mode)) {
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
  const colors = modeChipColors(tone);
  if (compact) {
    const compactClass =
      "flex h-[22px] w-[26px] shrink-0 items-center justify-center rounded-[var(--radius-pill)]";
    if (!removable) {
      return (
        <span
          className={compactClass}
          style={{ background: colors.bg }}
          title={`${label} mode`}
          aria-label={`${label} mode`}
        >
          {renderModeChipIcon(tone, colors.text)}
        </span>
      );
    }
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => onModeChange(defaultMode)}
        className={`${compactClass} touch-manipulation transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50`}
        style={{ background: colors.bg }}
        aria-label={`Remove ${label} mode`}
        title={`${label} mode - tap to remove`}
      >
        {renderModeChipIcon(tone, colors.text)}
      </button>
    );
  }
  return (
    <span
      className="inline-flex h-[22px] shrink-0 items-center gap-[3px] rounded-[var(--radius-pill)] pl-[7px] pr-[4px] font-sans text-[13px] font-normal leading-none"
      style={{ background: colors.bg }}
    >
      {renderModeChipIcon(tone, colors.text)}
      <span style={{ color: colors.text }}>{label}</span>
      {removable ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onModeChange(defaultMode)}
          className="ml-[2px] flex size-[14px] touch-manipulation items-center justify-center rounded-full transition-[background-color,opacity] hover:bg-black/15 disabled:cursor-not-allowed disabled:opacity-50"
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

/** Clipboard image files only (items first - avoids duplicate uploads when both items and `files` list them). */
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
  /** Slash commands the live agent session advertises (e.g. Antigravity `/plan`). */
  agentCommands?: AgentSlashCommand[] | null;
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
  goalProgress?: GoalProgressStatus | null;
  busy?: boolean;
  configLocked?: boolean;
  /** When true, mode cannot be changed or removed. */
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
  /** Metadata for each `⟦textref:<id>⟧` pill currently embedded in `value`. */
  draftTextReferences?: Record<string, TextReference>;
  /** Called when long pasted text references are added or their tokens are deleted. */
  onDraftTextReferencesChange?: (next: Record<string, TextReference> | undefined) => void;
  /** Metadata for each `⟦link:<id>⟧` pill currently embedded in `value`. */
  draftLinkReferences?: Record<string, LinkReference>;
  /** Called when link attachments are added, resolved, or their tokens are deleted. */
  onDraftLinkReferencesChange?: (next: Record<string, LinkReference> | undefined) => void;
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
  /** Active conversation for context usage footer (omit on ephemeral drafts). */
  conversationId?: string | null;
  /** Bumps every ~1–2 assistant completions for context usage refresh. */
  contextUsageRefreshGeneration?: number;
  /** Show repo/branch/context footer below the composer card. */
  showStatusBar?: boolean;
  /**
   * True while the host renders a docked card (completion error, ask question,
   * queued prompts, plan review) flush above the composer shell. Those cards
   * use an open-bottom frame that must touch the composer, so the action pill
   * row yields to them instead of wedging into the gap.
   */
  dockedCardVisible?: boolean;
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

function renderTextReferencePill(
  tokenStart: number,
  tokenEnd: number,
  reference: TextReference | undefined,
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
  const selected = tokenStart >= safe.start && tokenEnd <= safe.end && safe.end > safe.start;
  const charCount = reference?.charCount ?? reference?.text.length ?? 0;
  const label = reference?.label ?? "pasted text";
  const title = reference?.text
    ? `${label}\n${charCount.toLocaleString()} characters\n\n${reference.text.slice(0, 600)}${
        reference.text.length > 600 ? "…" : ""
      }`
    : label;
  nodes.push(
    <span
      key={`textref-${tokenStart}`}
      data-faux-offset-start={tokenStart}
      data-faux-offset-end={tokenEnd}
      className={`mx-[2px] inline-flex max-w-full items-center gap-[4px] rounded-[6px] border border-[var(--border-subtle)] bg-[var(--file-tag-bg)] px-[7px] py-[1px] align-baseline font-sans text-[12.5px] font-medium whitespace-nowrap ${
        selected ? "ring-2 ring-[var(--accent)]" : ""
      } ${reference ? "text-[var(--file-tag-text)]" : "text-[var(--text-secondary)] italic"}`}
      title={title}
      data-text-reference-id={reference?.id ?? ""}
    >
      <FileText
        className="size-[12px] shrink-0 text-[var(--file-tag-icon)]"
        strokeWidth={1.75}
        aria-hidden
      />
      <span className="max-w-[240px] truncate">
        {reference ? label : "missing text"}
      </span>
    </span>
  );
}

function renderLinkReferencePill(
  tokenStart: number,
  tokenEnd: number,
  reference: LinkReference | undefined,
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
  const selected = tokenStart >= safe.start && tokenEnd <= safe.end && safe.end > safe.start;
  const label = reference?.title ?? "link";
  const url = reference?.url ?? "";
  nodes.push(
    <LinkAttachmentPill
      key={`link-${tokenStart}`}
      title={reference ? label : "missing link"}
      url={url}
      faviconUrl={reference?.faviconUrl}
      selected={selected}
      data-faux-offset-start={tokenStart}
      data-faux-offset-end={tokenEnd}
      data-link-reference-id={reference?.id ?? ""}
      className={`mx-[2px] inline-flex max-w-full items-center gap-[4px] rounded-[6px] border border-[var(--border-subtle)] bg-[var(--file-tag-bg)] px-[7px] py-[1px] align-baseline font-sans text-[12.5px] font-medium whitespace-nowrap ${
        selected ? "ring-2 ring-[var(--accent)]" : ""
      } ${reference ? "text-[var(--file-tag-text)]" : "text-[var(--text-secondary)] italic"}`}
    />
  );
}

function renderComposerText(
  value: string,
  selection: TextSelection,
  active: boolean,
  caretRef: { current: HTMLSpanElement | null },
  captures: Record<string, DesignCapture> | undefined,
  textReferences: Record<string, TextReference> | undefined,
  linkReferences: Record<string, LinkReference> | undefined
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

  const tokens = [
    ...findComposerCaptureTokens(value).map((token) => ({
      ...token,
      kind: "design" as const,
    })),
    ...findComposerTextReferenceTokens(value).map((token) => ({
      ...token,
      kind: "text-reference" as const,
    })),
    ...findComposerLinkReferenceTokens(value).map((token) => ({
      ...token,
      kind: "link" as const,
    })),
  ].sort((left, right) => left.start - right.start);

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
    if (tk.kind === "design") {
      renderDesignPill(
        tk.start,
        tk.end,
        captures?.[tk.captureId],
        safe,
        active,
        caretRef,
        nodes
      );
    } else if (tk.kind === "text-reference") {
      renderTextReferencePill(
        tk.start,
        tk.end,
        textReferences?.[tk.referenceId],
        safe,
        active,
        caretRef,
        nodes
      );
    } else {
      renderLinkReferencePill(
        tk.start,
        tk.end,
        linkReferences?.[tk.linkId],
        safe,
        active,
        caretRef,
        nodes
      );
    }
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
  agentCommands,
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
  goalProgress = null,
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
  draftTextReferences,
  onDraftTextReferencesChange,
  draftLinkReferences,
  onDraftLinkReferencesChange,
  userMessageHistory,
  hasMoreOlderUserMessageHistory = false,
  onRequestOlderUserMessageHistory,
  conversationId = null,
  contextUsageRefreshGeneration,
  showStatusBar = true,
  dockedCardVisible = false,
}: ChatComposerProps) {
  const { fileTree, gitStatus, workspaceSession } = useWorkspace();
  const { settings } = useGlobalSettings();
  const { themeConfig } = useTheme();
  const submitCtrlEnter = settings.agents.submitCtrlEnter;
  const steerCtrlEnter = settings.agents.steerCtrlEnter;
  const hasHardwareKeyboard = useHardwareKeyboard();

  // The Cesium capability-profile toggle renders at the top of the agent
  // center pane (CesiumProfileToggle); the composer only hides the raw
  // "profile" config option so it does not render as a generic dropdown.
  const isCesiumBackend = backendId === "cesium-agent";
  /**
   * No connected server / backend means no model catalog. Render no model
   * pill at all in that state instead of a fake placeholder entry - the
   * submit path prompts the user to connect a server.
   */
  const hasModelCatalog = models.length > 0 && !isNoModelPlaceholder(model);
  const { pushNotification, dismiss: dismissNotification } = useWorkbenchNotifications();
  const surfaceId = useId().replace(/:/g, "_");
  const submittingPromptKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (conversationId && isGoalMode(mode)) {
      markDesktopTaskbarGoalProgressSourceOpen(surfaceId);
    }
  }, [conversationId, mode, surfaceId]);
  useEffect(() => {
    publishDesktopTaskbarGoalProgress(
      surfaceId,
      resolveDesktopTaskbarGoalProgress({
        mode,
        goalProgress,
        conversationStatus,
      })
    );
    return () => clearDesktopTaskbarGoalProgress(surfaceId);
  }, [goalProgress, conversationStatus, mode, surfaceId]);
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
  /** Bumped when Mod+Alt+Tab cycles ACP backend so `BackendDropdown` flashes the label. */
  const [backendLabelPeekKey, setBackendLabelPeekKey] = useState(0);
  const [modeMenuOpenKey, setModeMenuOpenKey] = useState(0);
  const [backendMenuOpenKey, setBackendMenuOpenKey] = useState(0);
  const [recordingState, setRecordingState] = useState<
    "idle" | "recording" | "transcribing"
  >("idle");
  /**
   * Recording kept after a failed transcription so the user can retry it
   * (mic button turns into a retry button) or save it under `.cesium/`.
   * `failures` counts user-visible failed attempts for this recording.
   */
  const [pendingVoiceRecording, setPendingVoiceRecording] = useState<{
    file: File;
    failures: number;
  } | null>(null);
  const pendingVoiceRecordingRef = useRef(pendingVoiceRecording);
  pendingVoiceRecordingRef.current = pendingVoiceRecording;
  const [attachedImages, setAttachedImages] = useState<ImageAttachmentState[]>([]);
  const [localTextReferences, setLocalTextReferences] = useState<
    Record<string, TextReference> | undefined
  >();
  const [localLinkReferences, setLocalLinkReferences] = useState<
    Record<string, LinkReference> | undefined
  >();
  const linkPreviewAbortRef = useRef<Map<string, AbortController>>(new Map());
  const consumedDraftAttachmentKeysRef = useRef<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const anyFileInputRef = useRef<HTMLInputElement>(null);
  const composerRootRef = useRef<HTMLDivElement>(null);
  /** Docked main row (measures available width) + hidden full-size controls probe. */
  const inlineRowRef = useRef<HTMLDivElement>(null);
  const inlineProbeRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const imageFilesRef = useRef<Map<string, File>>(new Map());
  const [inputLevel, setInputLevel] = useState(0);
  const [menuPos, setMenuPos] = useState<ComposerPopoverPosition>({
    placement: "above",
    bottom: 100,
    left: 8,
    maxHeight: 280,
  });
  const [commandPanelPos, setCommandPanelPos] = useState<ComposerCommandPanelPosition>({
    placement: "above",
    bottom: 100,
    left: 8,
    width: 320,
    maxHeight: 280,
  });
  const [dockComposerHeightExpanded, setDockComposerHeightExpanded] = useState(false);
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
      setDockComposerHeightExpanded(false);
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
  /** Recent texts reported upward while the DOM held them; incoming `value`
   * renders matching an entry are echoes, not external changes. Entries age
   * out instead of being consumed - the same report can echo several times. */
  const domReportsRef = useRef<ComposerDomReport[]>([]);
  /** True between compositionstart/compositionend - the DOM must not be
   * rebuilt while an IME is composing. */
  const composingRef = useRef(false);
  /** Bumped on compositionend so the reconcile effect re-runs any pass it
   * deferred while the IME was composing. */
  const [imeGeneration, setImeGeneration] = useState(0);
  menuRef.current = menu;
  modeRef.current = mode;
  modeOptionsRef.current = modeOptions;
  configLockedRef.current = configLocked;
  modeLockedRef.current = modeLocked;

  const value = controlledValue ?? uncontrolledValue;
  const selection = controlledSelection ?? uncontrolledSelection;
  const effectiveTextReferences = draftTextReferences ?? localTextReferences;
  const updateTextReferences = useCallback(
    (next: Record<string, TextReference> | undefined) => {
      if (onDraftTextReferencesChange) {
        onDraftTextReferencesChange(next);
      } else {
        setLocalTextReferences(next);
      }
    },
    [onDraftTextReferencesChange]
  );
  const effectiveLinkReferences = draftLinkReferences ?? localLinkReferences;
  const effectiveLinkReferencesRef = useRef(effectiveLinkReferences);
  // Sync from props/local state after React commits - never overwrite mid-patch
  // updates that `updateLinkReferences` already wrote synchronously.
  useEffect(() => {
    effectiveLinkReferencesRef.current = effectiveLinkReferences;
  }, [effectiveLinkReferences]);
  const updateLinkReferences = useCallback(
    (next: Record<string, LinkReference> | undefined) => {
      effectiveLinkReferencesRef.current = next;
      if (onDraftLinkReferencesChange) {
        onDraftLinkReferencesChange(next);
      } else {
        setLocalLinkReferences(next);
      }
    },
    [onDraftLinkReferencesChange]
  );
  const patchLinkReference = useCallback(
    (linkId: string, patch: Partial<LinkReference> & Pick<LinkReference, "id" | "url" | "title">) => {
      const next = {
        ...(effectiveLinkReferencesRef.current ?? {}),
        [linkId]: {
          ...(effectiveLinkReferencesRef.current?.[linkId] ?? {
            id: patch.id,
            url: patch.url,
            title: patch.title,
          }),
          ...patch,
        },
      };
      updateLinkReferences(next);
    },
    [updateLinkReferences]
  );
  // Saved conversations become taggable like files; tokens expand into
  // <conversation-reference> blocks on submit so Cesium agents can pull the
  // transcripts through the conversation tools.
  const agentShellState = useAgentShellStateMaybe();
  const conversationReferences = useMemo<Record<string, ConversationReference>>(() => {
    const out: Record<string, ConversationReference> = {};
    for (const group of agentShellState?.groups ?? []) {
      for (const conversation of group.conversations) {
        if (conversation.id === conversationId) continue;
        out[conversation.id] = {
          id: conversation.id,
          title: conversation.title || "Untitled chat",
          workspaceId: conversation.workspaceId,
          workspaceName: group.workspace.name,
        };
      }
    }
    return out;
  }, [agentShellState?.groups, conversationId]);
  const conversationAtSources = useMemo<AtConversationSource[]>(() => {
    const out: AtConversationSource[] = [];
    for (const group of agentShellState?.groups ?? []) {
      for (const conversation of group.conversations) {
        if (conversation.id === conversationId || conversation.archivedAt != null) continue;
        out.push({
          id: conversation.id,
          title: conversation.title || "Untitled chat",
          workspaceName: group.workspace.name,
          updatedAt: conversation.updatedAt,
        });
      }
    }
    return out;
  }, [agentShellState?.groups, conversationId]);
  const atSuggestions = useMemo(
    () => getAllAtSuggestions(fileTree, conversationAtSources),
    [conversationAtSources, fileTree]
  );
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
        backends: composerVisibleHarnesses(backends, {
          currentBackendId: backendId,
          enabledHarnesses: settings.agents.enabledHarnesses,
          harnessTransports: settings.agents.harnessTransports,
        }),
        sessionConfigOptions,
        agentCommands,
        gitSlashCommands,
        configLocked,
        modeLocked,
      }),
    [
      activeBackend,
      agentCommands,
      backendId,
      backends,
      configLocked,
      gitSlashCommands,
      modeLocked,
      modeOptions,
      models,
      sessionConfigOptions,
      settings.agents.enabledHarnesses,
      settings.agents.harnessTransports,
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

  const beginLinkPreviewResolve = useCallback(
    (linkId: string, url: string) => {
      const existing = linkPreviewAbortRef.current.get(linkId);
      existing?.abort();
      const controller = new AbortController();
      linkPreviewAbortRef.current.set(linkId, controller);
      void resolveLinkPreview(url, getServerBaseUrl(), controller.signal)
        .then((preview) => {
          if (controller.signal.aborted) return;
          patchLinkReference(linkId, {
            id: linkId,
            url: preview.url,
            title: preview.title,
            faviconUrl: preview.faviconUrl ?? undefined,
            status: "ready",
          });
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          patchLinkReference(linkId, {
            id: linkId,
            url,
            title: fallbackTitleFromUrl(url),
            status: "failed",
          });
        })
        .finally(() => {
          if (linkPreviewAbortRef.current.get(linkId) === controller) {
            linkPreviewAbortRef.current.delete(linkId);
          }
        });
    },
    [patchLinkReference]
  );

  const createLinkReferenceToken = useCallback(
    (rawUrl: string): string | null => {
      const trimmed = rawUrl.trim();
      const url =
        tryParsePastedLinkUrl(trimmed) ??
        (/^https?:\/\//i.test(trimmed)
          ? null
          : tryParsePastedLinkUrl(`https://${trimmed}`));
      if (!url) return null;
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `link-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      patchLinkReference(id, {
        id,
        url,
        title: fallbackTitleFromUrl(url),
        status: "loading",
      });
      beginLinkPreviewResolve(id, url);
      return makeComposerLinkReferenceToken(id);
    },
    [beginLinkPreviewResolve, patchLinkReference]
  );

  const textForPaste = useCallback(
    (plain: string): string => {
      const pastedUrl = tryParsePastedLinkUrl(plain);
      if (pastedUrl) {
        return createLinkReferenceToken(pastedUrl) ?? plain;
      }
      if (
        !settings.themeConfig.longPasteReferencesEnabled ||
        plain.length < LONG_PASTE_REFERENCE_THRESHOLD_CHARS
      ) {
        return plain;
      }
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `textref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const label = `Pasted text (${plain.length.toLocaleString()} chars)`;
      const reference: TextReference = {
        id,
        label,
        text: plain,
        charCount: plain.length,
      };
      updateTextReferences({
        ...(effectiveTextReferences ?? {}),
        [id]: reference,
      });
      return makeComposerTextReferenceToken(id);
    },
    [
      createLinkReferenceToken,
      effectiveTextReferences,
      settings.themeConfig.longPasteReferencesEnabled,
      updateTextReferences,
    ]
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

  const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB - images ship inline base64 to vision models
  const MAX_ANY_FILE_SIZE = 50 * 1024 * 1024; // 50MB - generic files only travel to disk via multipart
  const MAX_ATTACHMENT_COUNT = 10;
  const SLOW_UPLOAD_THRESHOLD_MS = 2500;

  /**
   * Attach any mix of images and generic files. Images are read to base64 for
   * inline vision delivery; every attachment (images included) is eagerly
   * uploaded so it lands in the workspace `.cesium/file-uploads/` directory
   * and the agent can be pointed at its saved path.
   */
  const addAttachmentsFromFiles = useCallback(
    (files: FileList | File[]) => {
      const currentCount = attachedImages.length;
      const filesToAdd = Array.from(files).slice(0, Math.max(0, MAX_ATTACHMENT_COUNT - currentCount));

      const validFiles = filesToAdd.filter((file) => {
        const isImage = file.type.startsWith("image/");
        const maxSize = isImage ? MAX_IMAGE_SIZE : MAX_ANY_FILE_SIZE;
        if (file.size > maxSize) {
          pushNotification({
            kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
            severity: "warning",
            title: isImage ? "Image too large" : "File too large",
            message: `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)}MB. Maximum size is ${Math.round(maxSize / 1024 / 1024)}MB.`,
            autoDismissMs: 5000,
            compact: true,
          });
          return false;
        }
        return true;
      });

      if (validFiles.length === 0) return;

      const newEntries: ImageAttachmentState[] = validFiles.map((file) => ({
        localId: globalThis.crypto?.randomUUID?.() ?? `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        mimeType: file.type || "application/octet-stream",
        data: "",
        name: file.name,
        size: file.size,
        kind: file.type.startsWith("image/") ? ("image" as const) : ("file" as const),
        uploadState: "pending",
        showSlowSpinner: false,
      }));

      // Store files in ref for retry functionality
      newEntries.forEach((entry, i) => {
        imageFilesRef.current.set(entry.localId, validFiles[i]);
      });

      setAttachedImages((prev) => [...prev, ...newEntries]);

      void Promise.all(
        validFiles.map((file, i) => {
          return new Promise<void>((resolve) => {
            const localId = newEntries[i].localId;
            const isImage = newEntries[i].kind !== "file";

            const slowUploadTimer = setTimeout(() => {
              setAttachedImages((prev) =>
                prev.map((img) =>
                  img.localId === localId ? { ...img, showSlowSpinner: true } : img
                )
              );
            }, SLOW_UPLOAD_THRESHOLD_MS);

            const startUpload = () => {
              uploadAttachments([file])
                .then((results) => {
                  clearTimeout(slowUploadTimer);
                  setAttachedImages((prev) =>
                    prev.map((img) =>
                      img.localId === localId
                        ? {
                            ...img,
                            uploadState: "uploaded" as const,
                            serverId: results[0]?.id,
                            savedPath: results[0]?.path,
                            ...(results[0]?.name ? { name: results[0].name } : {}),
                            showSlowSpinner: false,
                          }
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

            if (!isImage) {
              // Generic files never travel inline - upload straight to disk.
              setAttachedImages((prev) =>
                prev.map((img) =>
                  img.localId === localId ? { ...img, uploadState: "uploading" as const } : img
                )
              );
              startUpload();
              return;
            }

            const reader = new FileReader();
            reader.onload = () => {
              const base64 = (reader.result as string).split(",")[1] ?? "";

              setAttachedImages((prev) =>
                prev.map((img) =>
                  img.localId === localId ? { ...img, data: base64, uploadState: "uploading" as const } : img
                )
              );

              startUpload();
            };
            reader.readAsDataURL(file);
          });
        })
      );
    },
    [attachedImages.length, pushNotification, MAX_IMAGE_SIZE, MAX_ANY_FILE_SIZE, SLOW_UPLOAD_THRESHOLD_MS]
  );

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (files && files.length > 0) {
        addAttachmentsFromFiles(files);
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [addAttachmentsFromFiles]
  );

  const handleAnyFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (files && files.length > 0) {
        addAttachmentsFromFiles(files);
      }
      if (anyFileInputRef.current) {
        anyFileInputRef.current.value = "";
      }
    },
    [addAttachmentsFromFiles]
  );

  /**
   * Stable key derived purely from attachment content so the key for the same
   * image doesn't change when sibling entries are added/removed (dropping the
   * list index keeps existing keys intact across mutations).
   */
  const draftAttachmentKey = useCallback((att: ImageAttachment): string => {
    return `${att.name ?? "image"}|${att.mimeType}|${att.data.length}|${att.data.slice(0, 64)}|${att.savedPath ?? ""}`;
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
          ...(att.kind ? { kind: att.kind } : {}),
          ...(att.savedPath ? { savedPath: att.savedPath } : {}),
          ...(typeof att.size === "number" ? { size: att.size } : {}),
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

  useEffect(() => {
    if (!effectiveTextReferences) return;
    const liveIds = new Set(findComposerTextReferenceTokens(value).map((t) => t.referenceId));
    const kept: Record<string, TextReference> = {};
    let changed = false;
    for (const [id, reference] of Object.entries(effectiveTextReferences)) {
      if (liveIds.has(id)) {
        kept[id] = reference;
      } else {
        changed = true;
      }
    }
    if (changed) {
      updateTextReferences(Object.keys(kept).length > 0 ? kept : undefined);
    }
  }, [effectiveTextReferences, updateTextReferences, value]);

  useEffect(() => {
    if (!effectiveLinkReferences) return;
    const liveIds = new Set(findComposerLinkReferenceTokens(value).map((t) => t.linkId));
    const kept: Record<string, LinkReference> = {};
    let changed = false;
    for (const [id, reference] of Object.entries(effectiveLinkReferences)) {
      if (liveIds.has(id)) {
        kept[id] = reference;
      } else {
        changed = true;
        linkPreviewAbortRef.current.get(id)?.abort();
        linkPreviewAbortRef.current.delete(id);
      }
    }
    if (changed) {
      updateLinkReferences(Object.keys(kept).length > 0 ? kept : undefined);
    }
  }, [effectiveLinkReferences, updateLinkReferences, value]);

  useEffect(() => {
    return () => {
      for (const controller of linkPreviewAbortRef.current.values()) {
        controller.abort();
      }
      linkPreviewAbortRef.current.clear();
    };
  }, []);

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
      // Always pass the concrete list (possibly empty) - `undefined` is
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
                ? {
                    ...img,
                    uploadState: "uploaded" as const,
                    serverId: results[0]?.id,
                    savedPath: results[0]?.path,
                    ...(results[0]?.name ? { name: results[0].name } : {}),
                    showSlowSpinner: false,
                  }
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
        addAttachmentsFromFiles(files);
      }
    },
    [addAttachmentsFromFiles]
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

  const discardPendingVoiceRecording = useCallback(() => {
    setPendingVoiceRecording(null);
  }, []);

  const savePendingVoiceRecording = useCallback(
    async (file: File) => {
      try {
        const saved = await saveVoiceRecording(file);
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
          severity: "info",
          title: "Voice input",
          message: `Recording saved to ${saved.path}. You can retry transcription later from that file.`,
          autoDismissMs: 9000,
          compact: true,
        });
      } catch (error) {
        flashComposerError(
          error instanceof Error
            ? `Could not save recording: ${error.message}`
            : "Could not save recording."
        );
      }
    },
    [flashComposerError, pushNotification]
  );

  /**
   * Failure 1–2: compact toast pointing at the retry button. Failure 3+: a
   * persistent notification offering to save the recording under `.cesium/`
   * so the audio survives even if transcription keeps failing.
   */
  const reportVoiceTranscriptionFailure = useCallback(
    (file: File, failures: number, message: string) => {
      if (failures < 3) {
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
          severity: "error",
          title: "Voice input",
          message: `${message} Recording kept - press the retry button to try again (attempt ${failures}).`,
          autoDismissMs: 8000,
          compact: true,
        });
        return;
      }
      const nid = pushNotification({
        kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
        severity: "error",
        title: "Voice transcription keeps failing",
        message: `${message} Transcription failed ${failures} times. Save the recording to .cesium/tmp/recordings/ so you can download it or transcribe it later? You can also keep retrying.`,
        persistent: true,
        actions: [
          {
            id: "save",
            label: "Save recording",
            primary: true,
            onClick: () => {
              dismissNotification(nid);
              void savePendingVoiceRecording(file);
            },
          },
          {
            id: "discard",
            label: "Discard",
            onClick: () => {
              dismissNotification(nid);
              discardPendingVoiceRecording();
            },
          },
        ],
      });
    },
    [
      discardPendingVoiceRecording,
      dismissNotification,
      pushNotification,
      savePendingVoiceRecording,
    ]
  );

  /** Re-runs transcription for the kept recording. Retryable indefinitely. */
  const retryVoiceTranscription = useCallback(async () => {
    const pending = pendingVoiceRecordingRef.current;
    if (!pending) {
      return;
    }
    setRecordingState("transcribing");
    try {
      const result = await transcribeAudio(pending.file);
      setPendingVoiceRecording(null);
      insertTranscription(result.text);
    } catch (error) {
      const failures = pending.failures + 1;
      setPendingVoiceRecording({ file: pending.file, failures });
      reportVoiceTranscriptionFailure(
        pending.file,
        failures,
        error instanceof Error ? error.message : "Voice transcription failed."
      );
    } finally {
      setRecordingState("idle");
    }
  }, [insertTranscription, reportVoiceTranscriptionFailure]);

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
    const blob = new Blob(parts, { type: recorderMimeType });
    const extension = recorderMimeType.includes("mp4")
      ? "mp4"
      : recorderMimeType.includes("ogg")
        ? "ogg"
        : "webm";
    const file = new File([blob], `composer-recording.${extension}`, {
      type: recorderMimeType,
    });
    try {
      const result = await transcribeAudio(file);
      setPendingVoiceRecording(null);
      insertTranscription(result.text);
    } catch (error) {
      setPendingVoiceRecording({ file, failures: 1 });
      reportVoiceTranscriptionFailure(
        file,
        1,
        error instanceof Error ? error.message : "Voice transcription failed."
      );
    } finally {
      setRecordingState("idle");
    }
  }, [cleanupVoiceCapture, insertTranscription, reportVoiceTranscriptionFailure]);

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
  const filteredSlashResult = useMemo(
    () =>
      menu?.kind === "slash"
        ? filterSlashMenuSectionsForDisplay(slashMenuSections, menu.query)
        : { sections: [], totalCount: 0, visibleCount: 0, truncated: false },
    [menu, slashMenuSections]
  );
  const filteredSlashSections = filteredSlashResult.sections;
  const flatSlashItems = useMemo(
    () => flattenSlashMenuSections(filteredSlashSections),
    [filteredSlashSections]
  );

  const isActive = hardwareInputEnabled
    ? isSurfaceActive(surfaceId)
    : hasFocus;
  const isExpanded = variant === "expanded";
  const visualLineCount = useComposerVisualLineCount(editorRef);
  const showComposerHeightOverlay =
    agentShellDockHeightExpand &&
    variant === "docked" &&
    !isExpanded &&
    visualLineCount >= COMPOSER_DOCK_HEIGHT_OVERLAY_MIN_LINES;
  const dockEditorMaxHeightClass = `${
    dockComposerHeightExpanded ? COMPOSER_DOCK_MAX_HEIGHT_EXPANDED : COMPOSER_DOCK_MAX_HEIGHT_DEFAULT
  } transition-[max-height] duration-300 ease-out`;

  useEffect(() => {
    if (!showComposerHeightOverlay && dockComposerHeightExpanded) {
      setDockComposerHeightExpanded(false);
    }
  }, [dockComposerHeightExpanded, showComposerHeightOverlay]);

  const composerHeightOverlayButton = showComposerHeightOverlay ? (
    <ComposerDockHeightOverlayButton
      expanded={dockComposerHeightExpanded}
      onToggle={() => setDockComposerHeightExpanded((current) => !current)}
    />
  ) : null;

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
 if (!configLocked && hasModelCatalog) setModelDropdownOpen(true);
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
          else if (pendingVoiceRecordingRef.current) void retryVoiceTranscription();
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
            if (showComposerHeightOverlay) {
              setDockComposerHeightExpanded((t) => !t);
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
    hasModelCatalog,
    isExpanded,
    modeLocked,
    onCollapseComposer,
    onExpandComposer,
    recordingState,
    retryVoiceTranscription,
    showComposerHeightOverlay,
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
              (normalizeDirectiveToken(option.id) === wanted ||
                normalizeDirectiveToken(option.label) === wanted)
          );
          if (match) {
            onModeChange(match.id);
            continue;
          }
        }

        const bareModeMatch = line.match(/^\/([^\s/]+)$/i);
        if (bareModeMatch && !modeLockedRef.current) {
          const token = normalizeDirectiveToken(bareModeMatch[1] ?? "");
          const reservedSlashCommands = new Set([
            "model",
            "backend",
            "set",
            "mode",
            "worktree",
            "delete-worktree",
          ]);
          if (!reservedSlashCommands.has(token)) {
            const match = modeOptions?.find(
              (option) =>
                (normalizeDirectiveToken(option.id) === token ||
                  normalizeDirectiveToken(option.label) === token)
            );
            if (match) {
              onModeChange(match.id);
              continue;
            }
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
    if (!menu || menu.kind !== "at" || !editorRef.current) return;
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

  useLayoutEffect(() => {
    if (!menu || menu.kind !== "slash") {
      return;
    }
    const update = () => {
      const shell = composerRootRef.current;
      if (!shell) {
        return;
      }
      const rect = shell.getBoundingClientRect();
      const placement = resolveComposerCommandPanelPlacement({
        layout,
        isExpanded,
        hasBeneathWidgets: hasVisibleFollowingSibling(shell),
      });
      setCommandPanelPos(
        positionComposerCommandPanel(
          {
            left: rect.left,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
          },
          placement,
          { width: window.innerWidth, height: window.innerHeight }
        )
      );
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [isExpanded, layout, menu, selection.end, value]);

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
   * Expand compact reference tokens into their full XML / markdown forms so the
   * LLM can see the hidden content. Link pills expand to `[title](url)`.
   * Unknown references (metadata lost to pruning / reload) keep the raw token
   * as a signal - better than silently sending nothing.
   */
  const expandComposerReferenceTokens = useCallback(
    (text: string): string => {
      if (
        !text.includes("\u27E6design:") &&
        !text.includes("\u27E6textref:") &&
        !text.includes("\u27E6conv:") &&
        !text.includes("\u27E6link:")
      ) {
        return text;
      }
      const caps = draftCaptures ?? {};
      const expandedDesign = text.replace(
        new RegExp(COMPOSER_CAPTURE_TOKEN_REGEX.source, "g"),
        (match, id: string) => {
          const cap = caps[id];
          if (!cap) return match;
          return buildDesignCaptureBlock(cap);
        }
      );
      const textRefs = effectiveTextReferences ?? {};
      const expandedTextRefs = expandedDesign.replace(
        new RegExp(COMPOSER_TEXT_REFERENCE_TOKEN_REGEX.source, "g"),
        (match, id: string) => {
          const reference = textRefs[id];
          if (!reference) return match;
          return buildTextReferenceBlock(reference);
        }
      );
      const expandedConversations = expandedTextRefs.replace(
        new RegExp(COMPOSER_CONVERSATION_REFERENCE_TOKEN_REGEX.source, "g"),
        (match, id: string) => {
          const reference = conversationReferences[id];
          if (!reference) return match;
          return buildConversationReferenceBlock(reference);
        }
      );
      const linkRefs = effectiveLinkReferences ?? {};
      return expandedConversations.replace(
        new RegExp(COMPOSER_LINK_REFERENCE_TOKEN_REGEX.source, "g"),
        (match, id: string) => {
          const reference = linkRefs[id];
          if (!reference) return match;
          return buildLinkMarkdown(reference);
        }
      );
    },
    [conversationReferences, draftCaptures, effectiveLinkReferences, effectiveTextReferences]
  );

  const submitComposer = useCallback(async (delivery: "normal" | "steer" = "normal") => {
    const trimmed = valueRef.current.trim();
    if (!trimmed && attachedImages.length === 0) {
      return;
    }
    const directed = applyComposerDirectives(trimmed);
    const promptText = expandComposerReferenceTokens(directed);
    // Images need their inline base64 (`data`); a "pending" entry's data stays
    // "" until its FileReader completes and would submit a zero-byte image.
    // Generic files carry no inline data - they only count once their upload
    // landed on disk (`savedPath`), which is what the agent gets pointed at.
    const imagesToSubmit: ImageAttachment[] = attachedImages
      .filter((att) => (att.kind === "file" ? Boolean(att.savedPath) : att.data.length > 0))
      .map(({ mimeType, data, name, kind, savedPath, size }) => ({
        mimeType,
        data,
        name,
        ...(kind ? { kind } : {}),
        ...(savedPath ? { savedPath } : {}),
        ...(typeof size === "number" ? { size } : {}),
      }));
    if (!trimmed && imagesToSubmit.length === 0) {
      return;
    }
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
      // The DOM now holds "" - treat it as the newest report so late echoes of
      // the submitted prompt are skipped instead of resurrecting it.
      recordComposerDomReport(domReportsRef.current, "");
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
    updateTextReferences(undefined);
    updateLinkReferences(undefined);
    for (const controller of linkPreviewAbortRef.current.values()) {
      controller.abort();
    }
    linkPreviewAbortRef.current.clear();
    // Re-assert empty after metadata callbacks. Parents that incorrectly
    // re-apply a stale `content` field while clearing attachments/captures
    // would otherwise resurrect the prompt (especially on mobile agent UI).
    valueRef.current = "";
    setComposerValue("");
    setComposerSelection({ start: 0, end: 0 });
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
    expandComposerReferenceTokens,
    hardwareInputEnabled,
    onDraftAttachmentsChange,
    onDraftCapturesChange,
    updateLinkReferences,
    updateTextReferences,
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
    // Remember what the DOM itself reported: when this exact string comes back
    // down as the (by then possibly stale) controlled `value`, the reconcile
    // effect must treat it as an echo instead of rebuilding the DOM with it.
    recordComposerDomReport(domReportsRef.current, text);
    setComposerValue(text);
    setComposerSelection({ start: caret, end: caret });
  }, [hardwareInputEnabled, setComposerSelection, setComposerValue]);

  const handleCompositionStart = useCallback(() => {
    if (!hardwareInputEnabled) {
      composingRef.current = true;
    }
  }, [hardwareInputEnabled]);

  const handleCompositionEnd = useCallback(() => {
    if (hardwareInputEnabled) return;
    composingRef.current = false;
    syncNativeState();
    // Re-run whatever reconcile pass was deferred while the IME composed.
    setImeGeneration((generation) => generation + 1);
  }, [hardwareInputEnabled, syncNativeState]);

  /**
   * Map compact references into the minimal shape the DOM reconciler needs.
   * Memoized so a stable reference doesn't force an extra reconcile when the
   * backing metadata is deeply equal but referentially new.
   */
  const pillDescriptors = useMemo<Record<string, ComposerPillDescriptor> | undefined>(() => {
    const hasConversations = Object.keys(conversationReferences).length > 0;
    const hasLinks = Boolean(effectiveLinkReferences && Object.keys(effectiveLinkReferences).length > 0);
    if (!draftCaptures && !effectiveTextReferences && !hasConversations && !hasLinks) {
      return undefined;
    }
    const out: Record<string, ComposerPillDescriptor> = {};
    for (const [id, cap] of Object.entries(draftCaptures ?? {})) {
      out[`design:${id}`] = {
        kind: "design",
        id: cap.id,
        label: cap.label,
        snippet: cap.snippet,
      };
    }
    for (const [id, reference] of Object.entries(effectiveTextReferences ?? {})) {
      out[`textref:${id}`] = {
        kind: "text-reference",
        id: reference.id,
        label: reference.label,
        snippet: `${reference.charCount.toLocaleString()} characters\n\n${reference.text.slice(0, 600)}`,
      };
    }
    for (const [id, reference] of Object.entries(conversationReferences)) {
      out[`conv:${id}`] = {
        kind: "conversation",
        id: reference.id,
        label: reference.title,
        snippet: reference.workspaceName ? `Chat in ${reference.workspaceName}` : "Chat",
      };
    }
    const serverBase = getServerBaseUrl();
    for (const [id, reference] of Object.entries(effectiveLinkReferences ?? {})) {
      out[`link:${id}`] = {
        kind: "link",
        id: reference.id,
        label: reference.title || fallbackTitleFromUrl(reference.url),
        href: reference.url,
        faviconSrc: reference.faviconUrl
          ? buildBrowserProxyUrl(serverBase, reference.faviconUrl)
          : undefined,
      };
    }
    return out;
  }, [conversationReferences, draftCaptures, effectiveLinkReferences, effectiveTextReferences]);

  useEffect(() => {
    if (hardwareInputEnabled) return;
    const el = editorRef.current;
    if (!el) return;
    if (composerEditorDomInSync(el, value, pillDescriptors)) return;
    // On slow devices (Android WebViews especially) input events outrun
    // React's passive-effect flush, so this effect can run with a `value`
    // older than the live DOM. Rebuilding from it would destroy the newer
    // keystrokes and shift the caret - skip stale echoes of text the DOM
    // itself reported, and never rewrite mid-IME-composition.
    const defer = shouldDeferComposerReconcile({
      value,
      domText: getComposerPlainText(el),
      isComposing: composingRef.current,
      reportHistory: domReportsRef.current,
    });
    if (defer) return;
    reconcilingRef.current = true;
    reconcileComposerEditorDom(el, value, pillDescriptors);
    queueMicrotask(() => { reconcilingRef.current = false; });
  }, [hardwareInputEnabled, imeGeneration, pillDescriptors, value]);

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

  const tryCycleBackendWithModAltTab = useCallback(
    (
      event: Pick<
        KeyboardEvent,
        "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "preventDefault"
      >,
      obstructed: boolean
    ): boolean => {
      const mod = event.metaKey || event.ctrlKey;
      if (event.key !== "Tab" || !mod || !event.altKey || event.shiftKey || obstructed) {
        return false;
      }
 if (configLocked) {
 return false;
 }
 const cyclable = composerVisibleHarnesses(backends, {
          currentBackendId: backendId,
          enabledHarnesses: settings.agents.enabledHarnesses,
          harnessTransports: settings.agents.harnessTransports,
        }).filter((b) => b.available && b.enabled !== false);
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
 settings.agents.enabledHarnesses,
 settings.agents.harnessTransports,
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
      const next = resolveNextModeInCycle(
        mode,
        modeOptions?.length ? modeOptions : DEFAULT_MODE_OPTIONS
      );
      if (!next) {
        return false;
      }
      event.preventDefault();
      onModeChange(next);
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
   * offset 0 (start of content) AND there is history to walk into - otherwise
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
      // for them - the user can press Up again once the render settles.
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
      // About to fall off the newest entry - restore the original draft.
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
        !isModeChipVisible(currentMode) ||
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
        tryCycleBackendWithModAltTab(
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
    tryCycleBackendWithModAltTab,
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
          tryCycleBackendWithModAltTab(
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
      tryCycleBackendWithModAltTab,
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
        const insert = textForPaste(text);
        const next = replaceSelection(
          valueRef.current,
          selectionRef.current,
          insert
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
    textForPaste,
    unregisterSurface,
  ]);

  const shellMx =
    shellMxClass !== undefined ? shellMxClass : "mx-0 @min-[481px]:mx-[10px]";
  const statusBarMounted =
    showStatusBar && variant !== "expanded" && layout !== "empty-top";
  const composerStatusBarVisibility = resolveComposerStatusBarVisibilityForConversation(
    workspaceSession.chat,
    conversationId,
    settings.general.composerStatusBarVisibility
  );
  const statusBarHasVisibleItems =
    statusBarMounted &&
    composerStatusBarHasVisibleItems(composerStatusBarVisibility, gitStatus, {
      goalProgress: goalProgress != null,
    });
  const showContextUsage = composerStatusBarVisibility.context;
  const [contextBreakdownOpen, setContextBreakdownOpen] = useState(false);
  const {
    usage: contextUsage,
    loading: contextLoading,
    error: contextError,
  } = useAgentContextUsage({
    conversationId: statusBarMounted && showContextUsage ? conversationId : null,
    backendId,
    modelId: model.id,
    conversationStatus,
    refreshGeneration: contextUsageRefreshGeneration,
  });

  useEffect(() => {
    setContextBreakdownOpen(false);
  }, [conversationId]);

  useEffect(() => {
    if (!showContextUsage) {
      setContextBreakdownOpen(false);
    }
  }, [showContextUsage]);

  const statusBarEl = statusBarMounted ? (
    <ComposerStatusBar
      backendId={backendId}
      conversationId={conversationId}
      usage={contextUsage}
      contextLoading={contextLoading}
      contextBreakdownOpen={contextBreakdownOpen}
      onContextBreakdownOpenChange={setContextBreakdownOpen}
      goalProgress={goalProgress}
      shellInsetClass={shellMx}
    />
  ) : null;
  const actionPillsEl = statusBarMounted && !dockedCardVisible ? (
    <ComposerActionPills
      conversationId={conversationId}
      conversationStatus={conversationStatus}
      shellInsetClass={shellMx}
    />
  ) : null;
  const contextBreakdownDock =
    contextBreakdownOpen && statusBarMounted && showContextUsage ? (
      <div className={dockedComposerCardSlot}>
        <ContextBreakdownDock
          usage={contextUsage}
          loading={contextLoading}
          error={contextError}
          onClose={() => setContextBreakdownOpen(false)}
        />
      </div>
    ) : null;
  const shellMargin =
    isExpanded
      ? ""
      : layout === "empty-top"
      ? `${shellMx} mt-[2px] mb-0`.trim()
      : `${shellMx} ${statusBarHasVisibleItems ? "mb-0" : COMPOSER_BOTTOM_GAP_CLASS}`.trim();
  const shellChrome = isExpanded
    ? "h-full min-h-0 gap-0 rounded-none border-0 bg-[var(--bg-main)] p-0"
    : "chat-composer-surface gap-[10px] overflow-hidden rounded-[var(--agent-composer-radius)] border border-[var(--agent-border)] p-[10px]";
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
    () =>
      renderComposerText(
        value,
        selection,
        isActive,
        caretRef,
        draftCaptures,
        effectiveTextReferences,
        effectiveLinkReferences
      ),
    [
      draftCaptures,
      effectiveLinkReferences,
      effectiveTextReferences,
      isActive,
      selection,
      value,
    ]
  );
  const composerTrimmedLength = value.trim().length;
  const canSubmit = composerTrimmedLength > 0 || attachedImages.length > 0;
  const cesiumPausing =
    conversationStatus != null && isAgentCesiumPauseDraining(conversationStatus);
  const cesiumPaused = conversationStatus === "paused";
  const cesiumTurnActive = Boolean(
    conversationStatus && isAgentCesiumTurnActive(conversationStatus)
  );
  const showCesiumTurnPill =
    isCesiumBackend &&
    Boolean(onCancel) &&
    cesiumTurnActive &&
    ((busy && !canSubmit) || cesiumPaused || cesiumPausing);
  const cesiumWantMounted =
    isCesiumBackend && (showCesiumTurnPill || (canSubmit && cesiumTurnActive));
  const { mounted: cesiumTurnPillMounted, expanded: cesiumTurnPillExpanded } =
    useCesiumTurnPillMotion(cesiumWantMounted, showCesiumTurnPill);
  const cesiumTurnPill = cesiumTurnPillMounted ? (
    <CesiumTurnControlPill
      expanded={cesiumTurnPillExpanded}
      conversationStatus={conversationStatus}
      toneClass={sendButtonBgClass[getModeTone(mode)]}
      onPause={onPause}
      onResume={onResume}
      onStop={onCancel}
      onSend={() => void submitComposer()}
      sendDisabled={!canSubmit}
      sendLabel={busy ? "Send or queue message" : "Send"}
      interactive={showCesiumTurnPill}
    />
  ) : null;
  /** While the turn is running, Stop occupies the primary (send) slot until there is something to queue. */
  const primaryControlIsStop = Boolean(
    busy && onCancel && !canSubmit && !cesiumTurnPillMounted
  );
  const primaryControlIsVoice =
    !primaryControlIsStop && !cesiumTurnPillMounted && !canSubmit;

  /**
   * Flips when the contenteditable wraps beyond one visual line. The hook
   * attaches a single ResizeObserver + `input` listener on the editor ref and
   * returns a boolean; it's a cheap no-op when the editor ref hasn't attached
   * yet.
   */
  const hookMeasuresMultiline = useComposerTextIsMultiLine(editorRef);
  /**
   * Docked composer: measuring multi-line while swapping layout
   * (single-row vs stacked) changes editor width and reflow, which can flip the
   * hook true/false in a tight loop. Once wrapped, stay in the multi-line shell
   * until the user clears all content (`value === ""`).
   */
  const [multilineLatch, setMultilineLatch] = useState(false);

  useEffect(() => {
    if (isComposerEffectivelyEmptyForMultiline(value, hookMeasuresMultiline)) {
      setMultilineLatch(false);
      return;
    }
    // After clearing, ResizeObserver can still see the old tall box until layout
    // settles; never re-latch multiline while the field is effectively empty.
    if (shouldLatchComposerMultiline(value, hookMeasuresMultiline)) {
      setMultilineLatch(true);
    }
  }, [hookMeasuresMultiline, value]);

  const useStickyMultiline = variant === "docked" && !isExpanded;
  const preferDetailedComposer = themeConfig.composerLayout === "detailed";
  const effectiveForceMultiline = forceMultiline || preferDetailedComposer;
  const isMultiLine = resolveComposerIsMultiLine({
    forceMultiline: effectiveForceMultiline,
    useStickyMultiline,
    hookMeasuresMultiline,
    latchedMultiline: multilineLatch,
    value,
  });

  /**
   * Inline-controls overflow: on narrow (mobile-width) panes, mode/model
   * labels crowd the single-line capsule until the editor is unusably thin.
   * A hidden probe row mirrors the full-size controls plus a minimum editor
   * width; when the probe outgrows the composer row - or the row itself is
   * at mobile width - the mode/model triggers compact to icon-only pills
   * (short model names included; length must not opt out of compaction).
   * Once content wraps to the stacked layout the controls get their full
   * labels back.
   */
  const inlineOverflowEnabled = variant === "docked" && !isExpanded;
  const { overflow: inlineControlsOverflow, rowWidthPx: inlineRowWidthPx } =
    useComposerInlineControlsOverflow(
      inlineRowRef,
      inlineProbeRef,
      inlineOverflowEnabled
    );
  const compactInlineControls = shouldCompactComposerInlineControls({
    inlineControlsOverflow,
    contentIsMultiLine: isMultiLine,
    rowWidthPx: inlineRowWidthPx,
  });
  canBackspaceClearModeChipRef.current =
    variant === "docked" &&
    !isExpanded &&
    !effectiveForceMultiline &&
    !isMultiLine &&
    attachedImages.length === 0 &&
    !(showComposerHeightOverlay && dockComposerHeightExpanded);

  /**
   * Hide the overlay after a real wrap (including Shift+Enter blank lines).
   * `trim()` alone is wrong: `\\n`-only input trims to "" while the field is
   * visibly multi-line. Treat phantom empty newlines as empty so detailed
   * (always-stacked) mode still shows the placeholder.
   */
  const showFloatingPlaceholder = isComposerEffectivelyEmptyForMultiline(
    value,
    hookMeasuresMultiline
  );

  const composerScrollFadeKey = [
    layout,
    value.length,
    isMultiLine,
    isExpanded,
    attachedImages.length,
    showComposerHeightOverlay,
    dockComposerHeightExpanded,
  ].join("\0");

  const { fade: composerEditorFade, onScroll: onComposerEditorScroll } =
    useComposerEditorScrollFade(editorRef, composerScrollFadeKey);

  const voiceButtonLabel =
    recordingState === "recording"
      ? "Stop voice input"
      : recordingState === "transcribing"
        ? "Transcribing voice input"
        : pendingVoiceRecording
          ? `Retry transcription (${pendingVoiceRecording.failures} failed attempt${pendingVoiceRecording.failures === 1 ? "" : "s"})`
          : "Voice input";

  const handleVoiceButtonClick = () => {
    if (recordingState === "recording") {
      stopVoiceInput();
      return;
    }
    if (pendingVoiceRecording) {
      void retryVoiceTranscription();
      return;
    }
    void startVoiceInput();
  };

  const renderVoiceButton = (variant: "primary" | "secondary"): ReactElement => {
    const isPrimary = variant === "primary";
    const buttonClassName = isPrimary
      ? `relative flex h-[var(--d2-composer-send-size)] w-[var(--d2-composer-send-size)] touch-manipulation items-center justify-center rounded-full transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50 ${sendButtonBgClass[getModeTone(mode)]}`
      : `relative flex h-[var(--d2-composer-send-size)] min-w-[var(--d2-composer-send-size)] touch-manipulation items-center justify-center rounded-full transition-colors ${
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
        ) : pendingVoiceRecording ? (
          <RotateCcw
            className={`size-[14px] shrink-0 ${
              isPrimary ? primaryIconClassName : "text-[var(--status-warning)]"
            }`}
            strokeWidth={1.75}
            aria-hidden
          />
        ) : (
          <Mic className={`size-[14px] shrink-0 ${primaryIconClassName}`} strokeWidth={1.5} aria-hidden />
        )}
      </button>
    );
  };

  if (variant === "docked" && !isExpanded) {
    const plusButton = (
      <ComposerAttachMenu
        variant="plus"
        disabled={configLocked}
        onPickFiles={() => anyFileInputRef.current?.click()}
        onPickMedia={() => fileInputRef.current?.click()}
        anchorRef={composerRootRef}
        composerLayout={layout}
        composerExpanded={isExpanded}
        suppressed={menu?.kind === "slash"}
      />
    );

    const modeChip = (
      <ModeChip
        mode={mode}
        options={modeOptions ?? DEFAULT_MODE_OPTIONS}
        onModeChange={onModeChange}
        disabled={configLocked || modeLocked}
        removable={!modeLocked}
        compact={compactInlineControls}
      />
    );

    const leadingModeControls = (
      <div className="flex shrink-0 items-center gap-[6px]">
        {plusButton}
        {modeChip}
      </div>
    );

    const modelPill = hasModelCatalog ? (
      <ModelDropdown
        model={model}
        models={models}
        onModelChange={onModelChange}
        popoverPlacement={modeModelPopoverPlacement}
        disabled={configLocked}
        compact={compactInlineControls}
        isOpen={modelDropdownOpen}
        onOpenChange={setModelDropdownOpen}
        backendId={backendId}
        backends={backends}
        onBackendChange={onBackendChange}
      />
    ) : null;

    /**
     * Invisible measurement row mirroring the single-line layout at full size:
     * plus button, full mode chip, a minimum editor width, untruncated model
     * label, and the action buttons (with their real gaps). Overflow handling
     * keys off this probe - not the live controls - so compacting/stacking the
     * real row never feeds back into the measurement.
     */
    const inlineOverflowProbe = (
      <div
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-0 h-0 overflow-hidden"
      >
        <div
          ref={inlineProbeRef}
          className="flex w-max items-center gap-[10px] whitespace-nowrap"
        >
          <div className="flex shrink-0 items-center gap-[6px]">
            <span className="block size-[var(--d2-composer-plus-size)] shrink-0" />
            <ModeChip
              mode={mode}
              options={modeOptions ?? DEFAULT_MODE_OPTIONS}
              onModeChange={() => {}}
              disabled
              removable={!modeLocked}
            />
          </div>
          <span
            className="block shrink-0"
            style={{ width: COMPOSER_INLINE_MIN_EDITOR_WIDTH_PX }}
          />
          <span className="inline-flex shrink-0 items-center gap-[4px]">
            <span className="block size-[14px] shrink-0" />
            <span className="font-sans text-[13px] font-normal">
              {hasModelCatalog ? model.name : ""}
            </span>
            <span className="block w-[8px] shrink-0" />
          </span>
          {!primaryControlIsVoice ? (
            <span className="block w-[var(--d2-composer-send-size)] shrink-0" />
          ) : null}
          <span className="block w-[var(--d2-composer-send-size)] shrink-0" />
        </div>
      </div>
    );

    const voiceButton = renderVoiceButton(
      primaryControlIsVoice ? "primary" : "secondary"
    );

    const sendButton = cesiumTurnPill ?? (
      primaryControlIsStop ? (
        <button
          type="button"
          onClick={() => void onCancel?.()}
          className={`flex h-[var(--d2-composer-send-size)] w-[var(--d2-composer-send-size)] touch-manipulation items-center justify-center rounded-full transition-opacity hover:opacity-80 ${sendButtonBgClass[getModeTone(mode)]}`}
          aria-label="Stop"
        >
          <Square className="size-[10px] text-[var(--bg-main)]" fill="currentColor" strokeWidth={2.2} />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void submitComposer()}
          disabled={!canSubmit}
          className={`flex h-[var(--d2-composer-send-size)] w-[var(--d2-composer-send-size)] touch-manipulation items-center justify-center rounded-full transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50 ${sendButtonBgClass[getModeTone(mode)]}`}
          aria-label={busy ? "Send or queue message" : "Send"}
        >
          <ArrowUp className="size-[14px] text-[var(--bg-main)]" strokeWidth={2.5} />
        </button>
      )
    );
    const primaryActionButton = cesiumTurnPill ?? (
      primaryControlIsVoice ? voiceButton : sendButton
    );

    /**
     * Single-line pill collapses to a fully circular shell so the composer
     * reads as one continuous capsule (Cursor 3.1). Multi-line keeps the same
     * visible corner roundness: `--agent-composer-radius` equals half the
     * collapsed shell height, so growing past one line never sharpens the
     * corners.
     */
    const pillRadiusClass =
      isMultiLine || attachedImages.length > 0
        ? "rounded-[var(--agent-composer-radius)]"
        : "rounded-full";

    return (
      <>
      {actionPillsEl}
      {contextBreakdownDock}
      <div
        ref={composerRootRef}
        data-ide-input-sink
        data-composer-shell
        data-composer-layout={themeConfig.composerLayout}
        data-composer-stacked={isMultiLine ? "true" : "false"}
        className={`${shellMargin} chat-composer-surface relative flex shrink-0 flex-col gap-[8px] overflow-hidden ${pillRadiusClass} border border-[var(--agent-border)] p-[10px]`}
      >
        {inlineOverflowProbe}
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
          ref={inlineRowRef}
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
            {composerHeightOverlayButton}
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
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              onPaste={(event: ReactClipboardEvent<HTMLDivElement>) => {
                const cd = event.clipboardData;
                const imageFiles = collectClipboardImageFiles(cd);
                if (imageFiles.length > 0) {
                  event.preventDefault();
                  const dt = new DataTransfer();
                  for (const file of imageFiles) {
                    dt.items.add(file);
                  }
                  addAttachmentsFromFiles(dt.files);
                  return;
                }

                const plain = clipboardPlainTextOnly(cd);
                const insert = textForPaste(plain);
                event.preventDefault();

                if (hardwareInputEnabled) {
                  const next = replaceSelection(valueRef.current, selectionRef.current, insert);
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
                replaceTextRange(el, start, end, insert);
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
                showComposerHeightOverlay ? dockEditorMaxHeightClass : COMPOSER_DOCK_MAX_HEIGHT_DEFAULT
              }`}
              style={scrollEdgeMaskStyle(composerEditorFade, { size: 28 })}
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
            totalItems={filteredSlashResult.totalCount}
            truncated={filteredSlashResult.truncated}
            selectedIndex={selectedIndex}
            query={menu.query}
            mode={mode}
            model={model}
            backendId={backendId}
            position={commandPanelPos}
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
        <input
          ref={anyFileInputRef}
          type="file"
          multiple
          onChange={handleAnyFileInputChange}
          className="hidden"
        />
      </div>
      {statusBarEl}
      </>
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
        className={`flex h-[var(--d2-composer-send-size)] w-[var(--d2-composer-send-size)] touch-manipulation items-center justify-center rounded-full transition-opacity hover:opacity-80 ${sendButtonBgClass[getModeTone(mode)]}`}
        aria-label="Stop"
      >
        <Square className="size-[10px] text-[var(--bg-main)]" fill="currentColor" strokeWidth={2.2} />
      </button>
    ) : (
      <button
        type="button"
        onClick={() => void submitComposer()}
        disabled={!canSubmit}
        className={`flex h-[var(--d2-composer-send-size)] w-[var(--d2-composer-send-size)] touch-manipulation items-center justify-center rounded-full transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50 ${sendButtonBgClass[getModeTone(mode)]}`}
        aria-label={busy ? "Send or queue message" : "Send"}
      >
        <ArrowUp className="size-[14px] text-[var(--bg-main)]" strokeWidth={2.5} />
      </button>
    )
  );
  const primaryActionButton = cesiumTurnPill ?? (
    primaryControlIsVoice ? voiceButton : sendButton
  );

  return (
    <>
    {actionPillsEl}
    {contextBreakdownDock}
    <div
      ref={composerRootRef}
      data-ide-input-sink
      data-composer-shell={isExpanded ? undefined : true}
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
        {composerHeightOverlayButton}
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
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onPaste={(event: ReactClipboardEvent<HTMLDivElement>) => {
            const cd = event.clipboardData;
            const imageFiles = collectClipboardImageFiles(cd);
            if (imageFiles.length > 0) {
              event.preventDefault();
              const dt = new DataTransfer();
              for (const file of imageFiles) {
                dt.items.add(file);
              }
              addAttachmentsFromFiles(dt.files);
              return;
            }

            const plain = clipboardPlainTextOnly(cd);
            const insert = textForPaste(plain);
            event.preventDefault();

            if (hardwareInputEnabled) {
              const next = replaceSelection(valueRef.current, selectionRef.current, insert);
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
            replaceTextRange(el, start, end, insert);
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
                  showComposerHeightOverlay ? dockEditorMaxHeightClass : COMPOSER_DOCK_MAX_HEIGHT_DEFAULT
                }`
          }`}
          style={scrollEdgeMaskStyle(composerEditorFade, { size: 28 })}
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
          totalItems={filteredSlashResult.totalCount}
          truncated={filteredSlashResult.truncated}
          selectedIndex={selectedIndex}
          query={menu.query}
          mode={mode}
          model={model}
          backendId={backendId}
          position={commandPanelPos}
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
            {hasModelCatalog ? (
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
            ) : null}
          </div>
          {sessionConfigOptions && sessionConfigOptions.length > 0 && (
            <div className="flex max-w-full flex-wrap items-center gap-[8px]">
              {sessionConfigOptions
                // The profile option renders as the center-pane CesiumProfileToggle.
                .filter((opt) => !(isCesiumBackend && opt.id === "profile"))
                .map((opt) => (
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
          {isExpanded && onCollapseComposer ? (
            <button
              type="button"
              onClick={onCollapseComposer}
              className="-m-[4px] touch-manipulation p-[4px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Minimize composer"
            >
              <Minimize2 className="size-[14px] shrink-0" strokeWidth={1.5} aria-hidden />
            </button>
          ) : !isExpanded ? (
            <button
              type="button"
              onClick={onExpandComposer}
              disabled={!onExpandComposer}
              className="-m-[4px] touch-manipulation p-[4px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Expand composer"
            >
              <Maximize2 className="size-[14px] shrink-0" strokeWidth={1.5} aria-hidden />
            </button>
          ) : null}
          <ComposerAttachMenu
            variant="icon"
            onPickFiles={() => anyFileInputRef.current?.click()}
            onPickMedia={() => fileInputRef.current?.click()}
            anchorRef={composerRootRef}
            composerLayout={layout}
            composerExpanded={isExpanded}
            suppressed={menu?.kind === "slash"}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileInputChange}
            className="hidden"
          />
          <input
            ref={anyFileInputRef}
            type="file"
            multiple
            onChange={handleAnyFileInputChange}
            className="hidden"
          />
          {!primaryControlIsVoice ? voiceButton : null}
          {primaryActionButton}
        </div>
      </div>
    </div>
    {statusBarEl}
    </>
  );
}
