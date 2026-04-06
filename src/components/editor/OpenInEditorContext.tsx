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
  ModelInfo,
} from "@/lib/types";

export type OpenTranscriptPayload = {
  title: string;
  messages: ChatMessage[];
  sessionId?: string;
};

export type OpenComposerDraftPayload = {
  draftId: string;
  title: string;
  content: string;
};

export type OpenAgentConversationPayload = {
  conversationId: string;
  title: string;
  group?: "left" | "right";
};

export type ComposerDraftRecord = OpenComposerDraftPayload;

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
  models: ModelInfo[];
  modeOptions?: AgentModeOption[];
  sessionConfigOptions?: AgentConfigOption[];
  onSessionConfigOptionChange?: (configId: string, value: string) => void;
  onSubmit: (text: string) => Promise<boolean | void> | boolean | void;
  onCancel?: () => Promise<void> | void;
  busy?: boolean;
  configLocked?: boolean;
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
    patch: Partial<ComposerDraftRecord> & Pick<ComposerDraftRecord, "content">
  ) => void;
  setComposerSelection: (draftId: string, selection: TextSelection) => void;
  expandedComposerDraftId: string | null;
  setExpandedComposerDraft: (draftId: string | null) => void;
  expandedComposerController: ExpandedComposerController | null;
  setExpandedComposerController: (
    controller: ExpandedComposerController | null
  ) => void;
  activeExplorerPath: string | null;
  setActiveExplorerPath: (path: string | null) => void;
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
      patch: Partial<ComposerDraftRecord> & Pick<ComposerDraftRecord, "content">
    ) => {
      setComposerDrafts((current) => {
        const existing = current[draftId];
        const next: ComposerDraftRecord = {
          draftId,
          title: patch.title ?? existing?.title ?? "Composer",
          content: patch.content,
        };
        if (
          existing &&
          existing.title === next.title &&
          existing.content === next.content
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
      setComposerSelection,
      expandedComposerDraftId,
      setExpandedComposerDraft,
      expandedComposerController,
      setExpandedComposerController,
      activeExplorerPath,
      setActiveExplorerPath,
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
      setComposerSelection,
      expandedComposerDraftId,
      setExpandedComposerDraft,
      expandedComposerController,
      setExpandedComposerController,
      activeExplorerPath,
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
