"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { TextSelection } from "@/components/input/text-buffer";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConfigOption,
} from "@/lib/agent-types";
import type {
  AgentModeOption,
  ChatMessage,
  EditorMode,
  ExplorerOpenRequest,
  ImageAttachment,
  ModelInfo,
} from "@/lib/types";
import {
  makeComposerCaptureToken,
  type DesignCapture,
} from "@/lib/design-capture";

export type OpenTranscriptPayload = {
  title: string;
  messages: ChatMessage[];
  sessionId?: string;
  /** Parent agent conversation; enables real-time transcript updates in the editor tab. */
  conversationId?: string;
};

export type OpenComposerDraftPayload = {
  draftId: string;
  title: string;
  content: string;
  attachments?: ImageAttachment[];
  /** Metadata for each `⟦design:…⟧` pill currently embedded in `content`. */
  captures?: Record<string, DesignCapture>;
};

export type OpenAgentConversationPayload = {
  conversationId: string;
  title: string;
  group?: "left" | "right";
};

export type ComposerDraftRecord = OpenComposerDraftPayload;

export function hasMeaningfulComposerContent(draft: ComposerDraftRecord): boolean {
  if (draft.content && draft.content.trim().length > 0) return true;
  if (draft.attachments && draft.attachments.length > 0) return true;
  if (draft.captures && Object.keys(draft.captures).length > 0) return true;
  return false;
}

/** Highest-priority registered draft wins (see `useRegisterDesignCaptureComposer`). */
const designCaptureRegistry = new Map<string, number>();

export function getActiveDesignCaptureDraftId(): string | null {
  let bestId: string | null = null;
  let bestP = -Infinity;
  for (const [id, p] of designCaptureRegistry) {
    if (p > bestP) {
      bestP = p;
      bestId = id;
    }
  }
  return bestId;
}

export function useRegisterDesignCaptureComposer(
  draftId: string | null | undefined,
  priority: number
): void {
  useEffect(() => {
    if (!draftId) {
      return;
    }
    designCaptureRegistry.set(draftId, priority);
    return () => {
      designCaptureRegistry.delete(draftId);
    };
  }, [draftId, priority]);
}

export type BrowserDesignGuestPayload =
  | {
      kind: "select";
      label?: string;
      snippet?: string;
      imageDataUrl?: string | null;
      captureId?: string;
    }
  | {
      kind: "stroke";
      caption?: string;
      imageDataUrl?: string;
      captureId?: string;
    };

function stripBase64FromDataUrl(dataUrl: string): string {
  const i = dataUrl.indexOf(",");
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

function designCaptureAttachmentName(
  kind: "select" | "stroke",
  label: string,
  captureId: string
): string {
  const slug = label.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 40);
  return `${kind === "stroke" ? "stroke" : "design"}-${slug}-${captureId.slice(0, 8)}.png`;
}

export type ExpandedComposerController = {
  draftId: string;
  title: string;
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  model: ModelInfo;
  onModelChange: (model: ModelInfo) => void;
  backendId: AgentBackendId;
  backends: AgentBackendInfo[];
  onBackendChange: (backendId: AgentBackendId) => void;
  onRequestHandoff?: (backendId: AgentBackendId) => void;
  models: ModelInfo[];
  modeOptions?: AgentModeOption[];
  sessionConfigOptions?: AgentConfigOption[];
  onSessionConfigOptionChange?: (configId: string, value: string) => void;
  onSubmit: (text: string, attachments?: ImageAttachment[]) => Promise<boolean | void> | boolean | void;
  onCancel?: () => Promise<void> | void;
  onPause?: () => Promise<void> | void;
  onResume?: () => Promise<void> | void;
  conversationStatus?: import("@/lib/agent-types").AgentConversationStatus;
  busy?: boolean;
  configLocked?: boolean;
  /** Same terminal-style user prompt history as docked {@link ChatComposer}. */
  userMessageHistory?: string[];
  hasMoreOlderUserMessageHistory?: boolean;
  onRequestOlderUserMessageHistory?: () => void;
};

type PersistedComposerState = {
  schemaVersion: 1;
  drafts: Record<string, ComposerDraftRecord>;
  selections: Record<string, TextSelection>;
  expandedDraftId: string | null;
};

const COMPOSER_STATE_SCHEMA_VERSION = 1;
const COMPOSER_STATE_STORAGE_PREFIX = "opencursor.composer-state.";

function getComposerStateStorageKey(workspaceId: string): string {
  return `${COMPOSER_STATE_STORAGE_PREFIX}${workspaceId}`;
}

function readPersistedComposerState(
  workspaceId: string
): PersistedComposerState | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(
      getComposerStateStorageKey(workspaceId)
    );
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<PersistedComposerState> | null;
    if (
      !parsed ||
      parsed.schemaVersion !== COMPOSER_STATE_SCHEMA_VERSION ||
      typeof parsed !== "object"
    ) {
      return null;
    }
    return {
      schemaVersion: COMPOSER_STATE_SCHEMA_VERSION,
      drafts:
        parsed.drafts && typeof parsed.drafts === "object" ? parsed.drafts : {},
      selections:
        parsed.selections && typeof parsed.selections === "object"
          ? parsed.selections
          : {},
      expandedDraftId:
        typeof parsed.expandedDraftId === "string" ? parsed.expandedDraftId : null,
    };
  } catch {
    return null;
  }
}

function writePersistedComposerState(
  workspaceId: string,
  state: PersistedComposerState
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      getComposerStateStorageKey(workspaceId),
      JSON.stringify(state)
    );
  } catch {
    // Ignore persistence failures; in-memory state still works.
  }
}

type TranscriptHandler = (payload: OpenTranscriptPayload) => void;
type ComposerDraftHandler = (payload: OpenComposerDraftPayload) => void;
type AgentConversationHandler = (payload: OpenAgentConversationPayload) => void;
type ExplorerHandler = (payload: ExplorerOpenRequest) => void;

export type MessageCitationPayload = {
  label: string;
  htmlFragment: string;
};

type Ctx = {
  registerOpenTranscript: (handler: TranscriptHandler | null) => void;
  openSubagentTranscript: (payload: OpenTranscriptPayload) => void;
  registerOpenComposerDraft: (handler: ComposerDraftHandler | null) => void;
  openComposerDraft: (payload: OpenComposerDraftPayload) => void;
  registerOpenAgentConversation: (
    handler: AgentConversationHandler | null
  ) => void;
  openAgentConversation: (payload: OpenAgentConversationPayload) => void;
  registerOpenExplorerFile: (handler: ExplorerHandler | null) => void;
  openExplorerFile: (payload: ExplorerOpenRequest) => void;
  composerDrafts: Record<string, ComposerDraftRecord>;
  composerSelections: Record<string, TextSelection>;
  upsertComposerDraft: (
    draftId: string,
    patch: Partial<ComposerDraftRecord>
  ) => void;
  migrateComposerDraft: (oldDraftId: string, newDraftId: string) => void;
  setComposerSelection: (draftId: string, selection: TextSelection) => void;
  expandedComposerDraftId: string | null;
  setExpandedComposerDraft: (draftId: string | null) => void;
  expandedComposerController: ExpandedComposerController | null;
  setExpandedComposerController: (
    controller: ExpandedComposerController | null
  ) => void;
  activeExplorerPath: string | null;
  setActiveExplorerPath: (path: string | null) => void;
  applyBrowserDesignCapture: (payload: BrowserDesignGuestPayload) => void;
  attachImageToBrowserDesignCapture: (captureId: string, imageDataUrl: string) => void;
  /** Inserts a `⟦design:…⟧` composer pill + capture metadata (expanded on submit like design mode). */
  applyMessageCitationToDraft: (draftId: string, payload: MessageCitationPayload) => void;
};

const OpenInEditorContext = createContext<Ctx | null>(null);

export function OpenInEditorProvider({ children }: { children: ReactNode }) {
  const { activeWorkspaceId } = useWorkspace();
  const handlerRef = useRef<TranscriptHandler | null>(null);
  const pendingRef = useRef<OpenTranscriptPayload | null>(null);
  const composerHandlerRef = useRef<ComposerDraftHandler | null>(null);
  const pendingComposerRef = useRef<OpenComposerDraftPayload | null>(null);
  const conversationHandlerRef = useRef<AgentConversationHandler | null>(null);
  const pendingConversationRef = useRef<OpenAgentConversationPayload | null>(null);
  const explorerRef = useRef<ExplorerHandler | null>(null);
  const pendingExplorerRef = useRef<ExplorerOpenRequest | null>(null);
  const [composerDrafts, setComposerDrafts] = useState<Record<string, ComposerDraftRecord>>({});
  const [composerSelections, setComposerSelections] = useState<
    Record<string, TextSelection>
  >({});
  const [expandedComposerDraftId, setExpandedComposerDraftId] = useState<string | null>(
    null
  );
  const [expandedComposerController, setExpandedComposerControllerState] =
    useState<ExpandedComposerController | null>(null);
  const [activeExplorerPath, setActiveExplorerPath] = useState<string | null>(null);

  const registerOpenTranscript = useCallback((handler: TranscriptHandler | null) => {
    handlerRef.current = handler;
    if (handler && pendingRef.current) {
      const p = pendingRef.current;
      pendingRef.current = null;
      handler(p);
    }
  }, []);

  const openSubagentTranscript = useCallback((payload: OpenTranscriptPayload) => {
    if (handlerRef.current) {
      handlerRef.current(payload);
    } else {
      pendingRef.current = payload;
    }
  }, []);

  const registerOpenComposerDraft = useCallback((handler: ComposerDraftHandler | null) => {
    composerHandlerRef.current = handler;
    if (handler && pendingComposerRef.current) {
      const pending = pendingComposerRef.current;
      pendingComposerRef.current = null;
      handler(pending);
    }
  }, []);

  const upsertComposerDraft = useCallback(
    (
      draftId: string,
      patch: Partial<ComposerDraftRecord>
    ) => {
      setComposerDrafts((current) => {
        const existing = current[draftId];
        const next: ComposerDraftRecord = {
          draftId,
          title: patch.title ?? existing?.title ?? "Composer",
          content:
            patch.content !== undefined ? patch.content : (existing?.content ?? ""),
          attachments:
            patch.attachments !== undefined ? patch.attachments : existing?.attachments,
          captures:
            patch.captures !== undefined ? patch.captures : existing?.captures,
        };
        if (
          existing &&
          existing.title === next.title &&
          existing.content === next.content &&
          existing.attachments === next.attachments &&
          existing.captures === next.captures
        ) {
          return current;
        }
        return {
          ...current,
          [draftId]: next,
        };
      });
    },
    []
  );

  const migrateComposerDraft = useCallback(
    (oldDraftId: string, newDraftId: string) => {
      setComposerDrafts((current) => {
        const draft = current[oldDraftId];
        if (!draft) {
          return current;
        }
        const { [oldDraftId]: _, ...rest } = current;
        return {
          ...rest,
          [newDraftId]: { ...draft, draftId: newDraftId },
        };
      });
      setComposerSelections((current) => {
        const selection = current[oldDraftId];
        if (!selection) {
          return current;
        }
        const { [oldDraftId]: _, ...rest } = current;
        return {
          ...rest,
          [newDraftId]: selection,
        };
      });
    },
    []
  );

  const applyBrowserDesignCapture = useCallback((payload: BrowserDesignGuestPayload) => {
    const draftId = getActiveDesignCaptureDraftId();
    if (!draftId) {
      return;
    }
    setComposerDrafts((current) => {
      const ex = current[draftId];
      const prev = ex?.content ?? "";
      const captureId =
        payload.captureId?.trim() ||
        (globalThis.crypto?.randomUUID?.() ??
          `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

      // Dedupe: if this capture is already in the draft, skip. The guest
      // script emits a stable captureId per gesture, and BrowserTab already
      // filters the postMessage stream, but this extra guard keeps the draft
      // clean if a double-send ever slips through.
      if (ex?.captures && ex.captures[captureId]) {
        return current;
      }

      const label =
        payload.kind === "stroke"
          ? (payload.caption?.trim() || "Annotation")
          : (payload.label ?? "element");
      const safeLabel = label.slice(0, 200);
      const snippet =
        payload.kind === "select" && payload.snippet
          ? payload.snippet.slice(0, 8000) +
            (payload.snippet.length > 8000 ? "\n…" : "")
          : undefined;
      const caption = payload.kind === "stroke" ? safeLabel : undefined;

      // Compact token: the composer renders this as a pill (see
      // ChatComposer.renderComposerText). Expanded to a `<design-capture>`
      // XML block at submit time so the agent gets the full HTML.
      const token = makeComposerCaptureToken(captureId);
      const nextContent = prev.trim() ? `${prev.trimEnd()} ${token}` : token;

      const prevAtt = ex?.attachments ? [...ex.attachments] : [];
      const dataUrl = payload.imageDataUrl;
      if (dataUrl) {
        const raw = stripBase64FromDataUrl(dataUrl);
        const attachmentName = designCaptureAttachmentName(payload.kind, safeLabel, captureId);
        if (!prevAtt.some((att) => att.name === attachmentName)) {
          prevAtt.push({
            mimeType: "image/png",
            data: raw,
            name: attachmentName,
          });
        }
      }

      const nextCaptures: Record<string, DesignCapture> = {
        ...(ex?.captures ?? {}),
        [captureId]: {
          id: captureId,
          kind: payload.kind,
          label: safeLabel,
          snippet,
          caption,
        },
      };

      const next: ComposerDraftRecord = {
        draftId,
        title: ex?.title ?? "Composer",
        content: nextContent,
        attachments: prevAtt,
        captures: nextCaptures,
      };
      return { ...current, [draftId]: next };
    });
  }, []);

  const applyMessageCitationToDraft = useCallback(
    (draftId: string, payload: MessageCitationPayload) => {
      if (!draftId.trim()) {
        return;
      }
      setComposerDrafts((current) => {
        const ex = current[draftId];
        const prev = ex?.content ?? "";
        const captureId =
          globalThis.crypto?.randomUUID?.() ??
          `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

        const safeLabel = payload.label.trim().slice(0, 200) || "Quoted message";
        const trimmedHtml = payload.htmlFragment.trim();
        const snippet =
          trimmedHtml.length > 8000
            ? `${trimmedHtml.slice(0, 8000)}\n…`
            : trimmedHtml || undefined;

        const token = makeComposerCaptureToken(captureId);
        const nextContent = prev.trim() ? `${prev.trimEnd()} ${token}` : token;

        const nextCaptures: Record<string, DesignCapture> = {
          ...(ex?.captures ?? {}),
          [captureId]: {
            id: captureId,
            kind: "select",
            label: safeLabel,
            snippet,
          },
        };

        const next: ComposerDraftRecord = {
          draftId,
          title: ex?.title ?? "Composer",
          content: nextContent,
          attachments: ex?.attachments,
          captures: nextCaptures,
        };
        return { ...current, [draftId]: next };
      });
    },
    []
  );

  /**
   * Backfill the screenshot for an existing design capture after an async
   * fallback finishes. This lets the pill appear instantly while the heavier
   * rendered screenshot pipeline resolves in the background.
   */
  const attachImageToBrowserDesignCapture = useCallback(
    (captureId: string, imageDataUrl: string) => {
      if (!captureId || !imageDataUrl) {
        return;
      }
      setComposerDrafts((current) => {
        let changed = false;
        const nextDrafts: Record<string, ComposerDraftRecord> = { ...current };
        for (const [draftId, draft] of Object.entries(current)) {
          const cap = draft.captures?.[captureId];
          if (!cap) {
            continue;
          }
          const nextAttachments = draft.attachments ? [...draft.attachments] : [];
          const attachmentName = designCaptureAttachmentName(cap.kind, cap.label, captureId);
          if (nextAttachments.some((att) => att.name === attachmentName)) {
            continue;
          }
          nextAttachments.push({
            mimeType: "image/png",
            data: stripBase64FromDataUrl(imageDataUrl),
            name: attachmentName,
          });
          nextDrafts[draftId] = {
            ...draft,
            attachments: nextAttachments,
          };
          changed = true;
        }
        return changed ? nextDrafts : current;
      });
    },
    []
  );

  const setComposerSelection = useCallback(
    (draftId: string, selection: TextSelection) => {
      setComposerSelections((current) => {
        const existing = current[draftId];
        if (
          existing &&
          existing.start === selection.start &&
          existing.end === selection.end
        ) {
          return current;
        }
        return {
          ...current,
          [draftId]: selection,
        };
      });
    },
    []
  );

  const setExpandedComposerDraft = useCallback((draftId: string | null) => {
    setExpandedComposerDraftId((current) => (current === draftId ? current : draftId));
  }, []);

  const setExpandedComposerController = useCallback(
    (controller: ExpandedComposerController | null) => {
      setExpandedComposerControllerState((current) =>
        current === controller ? current : controller
      );
    },
    []
  );

  const openComposerDraft = useCallback(
    (payload: OpenComposerDraftPayload) => {
      upsertComposerDraft(payload.draftId, payload);
      if (composerHandlerRef.current) {
        composerHandlerRef.current(payload);
      } else {
        pendingComposerRef.current = payload;
      }
    },
    [upsertComposerDraft]
  );

  const registerOpenAgentConversation = useCallback(
    (handler: AgentConversationHandler | null) => {
      conversationHandlerRef.current = handler;
      if (handler && pendingConversationRef.current) {
        const pending = pendingConversationRef.current;
        pendingConversationRef.current = null;
        handler(pending);
      }
    },
    []
  );

  const openAgentConversation = useCallback(
    (payload: OpenAgentConversationPayload) => {
      if (conversationHandlerRef.current) {
        conversationHandlerRef.current(payload);
      } else {
        pendingConversationRef.current = payload;
      }
    },
    []
  );

  useEffect(() => {
    if (!activeWorkspaceId) {
      setComposerDrafts({});
      setComposerSelections({});
      setExpandedComposerDraftId(null);
      setExpandedComposerControllerState(null);
      return;
    }
    const persisted = readPersistedComposerState(activeWorkspaceId);
    setComposerDrafts(persisted?.drafts ?? {});
    setComposerSelections(persisted?.selections ?? {});
    setExpandedComposerDraftId(persisted?.expandedDraftId ?? null);
    setExpandedComposerControllerState(null);
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }
    writePersistedComposerState(activeWorkspaceId, {
      schemaVersion: COMPOSER_STATE_SCHEMA_VERSION,
      drafts: composerDrafts,
      selections: composerSelections,
      expandedDraftId: expandedComposerDraftId,
    });
  }, [
    activeWorkspaceId,
    composerDrafts,
    composerSelections,
    expandedComposerDraftId,
  ]);

  const registerOpenExplorerFile = useCallback((handler: ExplorerHandler | null) => {
    explorerRef.current = handler;
    if (handler && pendingExplorerRef.current) {
      const p = pendingExplorerRef.current;
      pendingExplorerRef.current = null;
      handler(p);
    }
  }, []);

  const openExplorerFile = useCallback((payload: ExplorerOpenRequest) => {
    setActiveExplorerPath(payload.path);
    if (explorerRef.current) {
      explorerRef.current(payload);
    } else {
      pendingExplorerRef.current = payload;
    }
  }, []);

  const value = useMemo(
    () => ({
      registerOpenTranscript,
      openSubagentTranscript,
      registerOpenComposerDraft,
      openComposerDraft,
      registerOpenAgentConversation,
      openAgentConversation,
      registerOpenExplorerFile,
      openExplorerFile,
      composerDrafts,
      composerSelections,
      upsertComposerDraft,
      migrateComposerDraft,
      setComposerSelection,
      expandedComposerDraftId,
      setExpandedComposerDraft,
      expandedComposerController,
      setExpandedComposerController,
      activeExplorerPath,
      setActiveExplorerPath,
      applyBrowserDesignCapture,
      attachImageToBrowserDesignCapture,
      applyMessageCitationToDraft,
    }),
    [
      registerOpenTranscript,
      openSubagentTranscript,
      registerOpenComposerDraft,
      openComposerDraft,
      registerOpenAgentConversation,
      openAgentConversation,
      registerOpenExplorerFile,
      openExplorerFile,
      composerDrafts,
      composerSelections,
      upsertComposerDraft,
      migrateComposerDraft,
      setComposerSelection,
      expandedComposerDraftId,
      setExpandedComposerDraft,
      expandedComposerController,
      setExpandedComposerController,
      activeExplorerPath,
      setActiveExplorerPath,
      applyBrowserDesignCapture,
      attachImageToBrowserDesignCapture,
      applyMessageCitationToDraft,
    ]
  );

  return (
    <OpenInEditorContext.Provider value={value}>
      {children}
    </OpenInEditorContext.Provider>
  );
}

export function useOpenInEditor(): Ctx {
  const ctx = useContext(OpenInEditorContext);
  if (!ctx) {
    throw new Error("useOpenInEditor must be used within OpenInEditorProvider");
  }
  return ctx;
}
