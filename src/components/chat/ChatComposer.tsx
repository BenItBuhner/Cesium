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
import { ArrowUp, Image as ImageIcon, Maximize2, Mic, Minimize2, Square } from "lucide-react";
import { ImageCarousel } from "./ImageCarousel";
import type { ImageAttachment, ImageAttachmentState } from "@/lib/types";
import { useHardwareInput } from "@/components/input/HardwareInputProvider";
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";
import {
  applyTextBufferKey,
  clampSelection,
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
import { useClickOutside } from "@/hooks/useClickOutside";
import {
  getAllAtSuggestions,
  filterAtSuggestions,
  getSlashSuggestions,
  filterSlashSuggestions,
  type AtSuggestion,
  type SlashSuggestion,
} from "@/lib/composer-suggestions";
import {
  getCaretClientRect,
  getComposerPlainText,
  getCaretOffset,
  parseTriggerToken,
  replaceTextRange,
} from "./composer-editor-utils";
import { getModeTone } from "@/lib/chat-modes";
import type { AgentModeOption, EditorMode, KnownEditorMode, ModelInfo } from "@/lib/types";
import type { AgentBackendId, AgentBackendInfo, AgentConfigOption } from "@/lib/agent-types";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { transcribeAudio, uploadAttachments } from "@/lib/server-api";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";

const sendButtonBgClass: Record<KnownEditorMode, string> = {
  agent: "bg-[var(--accent-dark)]",
  plan: "bg-[var(--plan-accent-dark)]",
  debug: "bg-[var(--debug-accent-dark)]",
  ask: "bg-[var(--ask-accent-dark)]",
};

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

  const beforeBoundary = trailingBeforeNewlines > 0 ? "\n\n" : "";
  const afterBoundary = leadingAfterNewlines > 0 ? "\n\n" : "";

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
      after.length === 0);

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
  onSubmit: (text: string, attachments?: ImageAttachment[]) => Promise<void> | void;
  onCancel?: () => Promise<void> | void;
  busy?: boolean;
  configLocked?: boolean;
  /** Empty thread: composer sits under tabs; otherwise docked above bottom. */
  layout?: "docked-bottom" | "empty-top";
  variant?: "docked" | "expanded";
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

function renderComposerText(
  value: string,
  selection: TextSelection,
  active: boolean,
  caretRef: { current: HTMLSpanElement | null }
) {
  const safe = clampSelection(value, selection);
  const nodes: ReactElement[] = [];

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

  if (value.length === 0) {
    pushCaret(0);
    return nodes;
  }

  const parts = value.match(/\S+|\s+/g) ?? [];

  let index = 0;
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

  pushCaret(index);

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
  busy = false,
  configLocked = false,
  layout = "docked-bottom",
  variant = "docked",
}: ChatComposerProps) {
  const { fileTree } = useWorkspace();
  const { settings } = useGlobalSettings();
  const submitCtrlEnter = settings.agents.submitCtrlEnter;
  const { pushNotification } = useWorkbenchNotifications();
  const surfaceId = useId().replace(/:/g, "_");
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
  const [recordingState, setRecordingState] = useState<
    "idle" | "recording" | "transcribing"
  >("idle");
  const [attachedImages, setAttachedImages] = useState<ImageAttachmentState[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isDraggingRef = useRef(false);
  const imageFilesRef = useRef<Map<string, File>>(new Map());
  const [inputLevel, setInputLevel] = useState(0);
  const [menuPos, setMenuPos] = useState<ComposerPopoverPosition>({
    placement: "above",
    bottom: 100,
    left: 8,
    maxHeight: 280,
  });

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
  const filteredAtRef = useRef<AtSuggestion[]>([]);
  const filteredSlashRef = useRef<SlashSuggestion[]>([]);
  const selectedIndexRef = useRef(selectedIndex);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  menuRef.current = menu;

  const value = controlledValue ?? uncontrolledValue;
  const selection = controlledSelection ?? uncontrolledSelection;
  const atSuggestions = useMemo(() => getAllAtSuggestions(fileTree), [fileTree]);
  const slashSuggestions = useMemo(
    () =>
      getSlashSuggestions({
        modeOptions,
        models,
        backends,
        sessionConfigOptions,
      }),
    [backends, modeOptions, models, sessionConfigOptions]
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

  const handleRemoveImage = useCallback((localId: string) => {
    setAttachedImages((prev) => prev.filter((img) => img.localId !== localId));
    imageFilesRef.current.delete(localId);
  }, []);

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
      if (!hardwareInputEnabled) {
        requestAnimationFrame(() => {
          editorRef.current?.focus();
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
  const filteredSlash = useMemo(
    () =>
      menu?.kind === "slash"
        ? filterSlashSuggestions(slashSuggestions, menu.query)
        : [],
    [menu, slashSuggestions]
  );

  const isActive = hardwareInputEnabled
    ? isSurfaceActive(surfaceId)
    : hasFocus;
  const isEmpty = value.trim().length === 0;
  const isExpanded = variant === "expanded";

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
    filteredSlashRef.current = filteredSlash;
  }, [filteredAt, filteredSlash]);

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

  useClickOutside(editorRef, () => setMenu(null), !!menu, [popoverRef]);

  useEffect(() => {
    setComposerSelection(selectionRef.current);
  }, [setComposerSelection, value]);

  const submitComposer = useCallback(async () => {
    const trimmed = valueRef.current.trim();
    if (!trimmed && attachedImages.length === 0) {
      return;
    }
    const promptText = applyComposerDirectives(trimmed);
    const imagesToSubmit: ImageAttachment[] = attachedImages.map(({ mimeType, data, name }) => ({
      mimeType,
      data,
      name,
    }));
    valueRef.current = "";
    setComposerValue("");
    setComposerSelection({ start: 0, end: 0 });
    setMenu(null);
    setAttachedImages([]);
    if (promptText || imagesToSubmit.length > 0) {
      void Promise.resolve(onSubmit(promptText, imagesToSubmit)).catch(() => undefined);
    }
  }, [applyComposerDirectives, onSubmit, setComposerSelection, setComposerValue, attachedImages]);

  const syncNativeState = useCallback(() => {
    if (hardwareInputEnabled) return;
    const el = editorRef.current;
    if (!el) return;
    const text = getComposerPlainText(el);
    const caret = getCaretOffset(el);
    setComposerValue(text);
    setComposerSelection({ start: caret, end: caret });
  }, [hardwareInputEnabled, setComposerSelection, setComposerValue]);

  useEffect(() => {
    if (hardwareInputEnabled) return;
    const el = editorRef.current;
    if (!el) return;
    if (getComposerPlainText(el) !== value) {
      el.textContent = value;
    }
  }, [hardwareInputEnabled, value]);

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

  const pickSlash = useCallback(
    (item: SlashSuggestion) => {
      const currentMenu = menuRef.current;
      if (!currentMenu || currentMenu.kind !== "slash") return;
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
        return true;
      }
      if (currentMenu && event.key === "ArrowDown") {
        event.preventDefault();
        if (items.length === 0) return true;
        setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
        return true;
      }
      if (currentMenu && event.key === "ArrowUp") {
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
          pickSlash(items[idx] as SlashSuggestion);
        }
        return true;
      }
      if (!currentMenu && event.key === "Enter") {
        const mod = event.ctrlKey || event.metaKey;
        if (submitCtrlEnter && mod) {
          event.preventDefault();
          void submitComposer();
          return true;
        }
        if (!submitCtrlEnter && !event.shiftKey) {
          event.preventDefault();
          void submitComposer();
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
      pickAt,
      pickSlash,
      setComposerSelection,
      setComposerValue,
      submitComposer,
      submitCtrlEnter,
    ]
  );

  const handleNativeComposerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!menu) {
        if (event.key === "Enter") {
          const mod = event.ctrlKey || event.metaKey;
          if (submitCtrlEnter) {
            if (mod) {
              event.preventDefault();
              void submitComposer();
            }
          } else if (!event.shiftKey) {
            event.preventDefault();
            void submitComposer();
          }
        }
        return;
      }
      const items = menu.kind === "at" ? filteredAt : filteredSlash;

      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(null);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (items.length === 0) return;
        setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (items.length === 0) return;
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && items.length > 0) {
        event.preventDefault();
        const idx = Math.min(selectedIndex, items.length - 1);
        if (menu.kind === "at") {
          pickAt(items[idx] as AtSuggestion);
        } else {
          pickSlash(items[idx] as SlashSuggestion);
        }
        return;
      }
    },
    [
      filteredAt,
      filteredSlash,
      menu,
      pickAt,
      pickSlash,
      selectedIndex,
      submitComposer,
      submitCtrlEnter,
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
    surfaceId,
    unregisterSurface,
  ]);

  const shellMargin =
    isExpanded
      ? ""
      : layout === "empty-top"
      ? "mx-[10px] mt-[10px] mb-0"
      : "mx-[10px] mb-[10px]";
  const shellChrome = isExpanded
    ? "h-full min-h-0 gap-0 rounded-none border-0 bg-[var(--bg-main)] p-0"
    : "gap-[10px] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[10px]";
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
    () => renderComposerText(value, selection, isActive, caretRef),
    [isActive, selection, value]
  );
  const canSubmit = value.trim().length > 0 || attachedImages.length > 0;
  /** While the turn is running, Stop occupies the primary (send) slot until there is something to queue. */
  const primaryControlIsStop = Boolean(busy && onCancel && !canSubmit);

  return (
    <div
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
        {isEmpty && (
          <span
            className={`pointer-events-none absolute left-0 top-0 z-10 font-sans text-[14px] font-normal text-[var(--text-secondary)] ${textInsetClassName}`}
          >
            Ask anything, @ for files, / for commands
          </span>
        )}
        <div
          ref={editorRef}
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
            if (!hardwareInputEnabled) return;
            const items = event.clipboardData.items;
            let hasImages = false;
            for (let i = 0; i < items.length; i++) {
              if (items[i]?.type.startsWith("image/")) {
                hasImages = true;
                break;
              }
            }
            if (hasImages) {
              event.preventDefault();
              const imageFiles = new DataTransfer();
              for (let i = 0; i < items.length; i++) {
                if (items[i]?.type.startsWith("image/")) {
                  const file = items[i].getAsFile();
                  if (file) {
                    imageFiles.items.add(file);
                  }
                }
              }
              if (imageFiles.files.length > 0) {
                addImagesFromFileList(imageFiles.files);
              }
              return;
            }
            event.preventDefault();
            const next = replaceSelection(
              value,
              selection,
              event.clipboardData.getData("text/plain")
            );
            setComposerValue(next.value);
            setComposerSelection(next.selection);
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
              : "min-h-[18px] max-h-[min(42vh,240px)] overflow-y-auto"
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

      {menu?.kind === "at" && (
        <ComposerAutocomplete
          kind="at"
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
        <ComposerAutocomplete
          kind="slash"
          items={filteredSlash}
          selectedIndex={selectedIndex}
          position={menuPos}
          onSelect={pickSlash}
          onHighlight={setSelectedIndex}
          listRef={listRef}
          popoverRef={popoverRef}
        />
      )}

      <div className={`flex items-start justify-between gap-[12px] ${controlRowClassName}`}>
        <div className="flex min-w-0 flex-1 flex-col gap-[6px]">
          <div className="flex flex-wrap items-center gap-[11px]">
            <BackendDropdown
              backendId={backendId}
              backends={backends}
              onBackendChange={onBackendChange}
              popoverPlacement={modeModelPopoverPlacement}
              disabled={busy || configLocked}
            />
            <ModeDropdown
              mode={mode}
              onModeChange={onModeChange}
              popoverPlacement={modeModelPopoverPlacement}
              disabled={busy || configLocked}
              options={modeOptions}
            />
            <ModelDropdown
              model={model}
              models={models}
              onModelChange={onModelChange}
              popoverPlacement={modeModelPopoverPlacement}
              disabled={busy || configLocked}
            />
          </div>
          {sessionConfigOptions && sessionConfigOptions.length > 0 && (
            <div className="flex max-w-full flex-wrap items-center gap-[8px]">
              {sessionConfigOptions.map((opt) => (
                <SessionConfigOptionDropdown
                  key={opt.id}
                  option={opt}
                  value={opt.currentValue}
                  popoverPlacement={modeModelPopoverPlacement}
                  disabled={busy || configLocked || !onSessionConfigOptionChange}
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
          <button
            type="button"
            onClick={() => {
              if (recordingState === "recording") {
                stopVoiceInput();
                return;
              }
              void startVoiceInput();
            }}
            disabled={recordingState === "transcribing"}
            className={`relative flex h-[20px] min-w-[20px] items-center justify-center rounded-full transition-colors ${
              recordingState === "recording"
                ? "bg-[var(--accent-bg)] text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            } disabled:cursor-not-allowed disabled:opacity-50`}
            aria-label={
              recordingState === "recording"
                ? "Stop voice input"
                : recordingState === "transcribing"
                  ? "Transcribing voice input"
                  : "Voice input"
            }
          >
            {recordingState === "recording" ? (
              <Square className="size-[9px] shrink-0" fill="currentColor" strokeWidth={2.2} aria-hidden />
            ) : (
              <Mic className="size-[14px] shrink-0" strokeWidth={1.5} aria-hidden />
            )}
            {(recordingState === "recording" || recordingState === "transcribing") && (
              <span className="pointer-events-none absolute -bottom-[14px] left-1/2 flex -translate-x-1/2 items-end gap-[2px]">
                {[0.45, 0.8, 0.6].map((scale, index) => (
                  <span
                    key={index}
                    className="w-[2px] rounded-full bg-[var(--text-secondary)] transition-[height,opacity] duration-100"
                    style={{
                      height: `${
                        recordingState === "transcribing"
                          ? 4 + index * 2
                          : 4 + Math.max(0.12, inputLevel * scale) * 12
                      }px`,
                      opacity: recordingState === "transcribing" ? 0.7 : 0.45 + inputLevel * 0.55,
                    }}
                  />
                ))}
              </span>
            )}
          </button>
          {primaryControlIsStop ? (
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
          )}
        </div>
      </div>
    </div>
  );
}
