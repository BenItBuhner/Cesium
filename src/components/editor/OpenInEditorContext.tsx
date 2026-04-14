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
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConfigOption,
} from "@/lib/agent-types";
import type {
  AgentModeOption,
  ChatMessage,
  DesignPromptSelection,
  EditorMode,
  ExplorerOpenRequest,
  ImageAttachment,
  ImageAttachmentState,
  ModelInfo,
} from "@/lib/types";
import { uploadAttachments } from "@/lib/server-api";

export type OpenTranscriptPayload = {
  title: string;
  messages: ChatMessage[];
  sessionId?: string;
};

export type OpenComposerDraftPayload = {
  draftId: string;
  title: string;
  content: string;
  attachments?: ImageAttachment[];
};

export type OpenAgentConversationPayload = {
  conversationId: string;
  title: string;
  group?: "left" | "right";
};

export type ComposerDraftRecord = OpenComposerDraftPayload;

export type ComposerDraftAssets = {
  attachments: ImageAttachmentState[];
  designSelections: DesignPromptSelection[];
};

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
  onSubmit: (
    text: string,
    attachments?: ImageAttachment[],
    designSelections?: DesignPromptSelection[]
  ) => Promise<boolean | void> | boolean | void;
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

const MAX_COMPOSER_IMAGES = 10;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const SLOW_UPLOAD_THRESHOLD_MS = 2500;

function createEmptyComposerDraftAssets(): ComposerDraftAssets {
  return {
    attachments: [],
    designSelections: [],
  };
}

function createDraftAttachmentState(attachment: ImageAttachment): ImageAttachmentState {
  return {
    localId:
      globalThis.crypto?.randomUUID?.() ??
      `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    mimeType: attachment.mimeType,
    data: attachment.data,
    name: attachment.name,
    uploadState: "uploaded",
    showSlowSpinner: false,
  };
}

function attachmentStatesEqual(
  left: ImageAttachmentState[],
  right: ImageAttachmentState[]
): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => {
    const candidate = right[index];
    return (
      entry.localId === candidate?.localId &&
      entry.mimeType === candidate?.mimeType &&
      entry.data === candidate?.data &&
      entry.name === candidate?.name &&
      entry.uploadState === candidate?.uploadState &&
      entry.serverId === candidate?.serverId &&
      entry.error === candidate?.error &&
      entry.showSlowSpinner === candidate?.showSlowSpinner
    );
  });
}

function designSelectionsEqual(
  left: DesignPromptSelection[],
  right: DesignPromptSelection[]
): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => {
    const candidate = right[index];
    return (
      entry.id === candidate?.id &&
      entry.label === candidate?.label &&
      entry.selector === candidate?.selector &&
      entry.targetUrl === candidate?.targetUrl &&
      entry.html === candidate?.html &&
      entry.css === candidate?.css &&
      entry.javascript === candidate?.javascript
    );
  });
}

function normalizeDraftAttachments(
  attachments: ImageAttachment[] | undefined
): ImageAttachmentState[] {
  return (attachments ?? []).map(createDraftAttachmentState);
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
  composerDraftAssetsById: Record<string, ComposerDraftAssets>;
  composerSelections: Record<string, TextSelection>;
  upsertComposerDraft: (
    draftId: string,
    patch: Partial<ComposerDraftRecord> & Pick<ComposerDraftRecord, "content">
  ) => void;
  registerComposerSurface: (draftId: string) => () => void;
  markComposerDraftPreferred: (draftId: string) => void;
  preferredComposerDraftId: string | null;
  addFilesToComposerDraft: (draftId: string, files: File[]) => void;
  appendSerializedAssetsToComposerDraft: (input: {
    draftId: string;
    attachments?: ImageAttachment[];
    designSelections?: DesignPromptSelection[];
  }) => void;
  appendToPreferredComposer: (input: {
    files?: File[];
    designSelections?: DesignPromptSelection[];
  }) => string | null;
  removeComposerDraftAttachment: (draftId: string, localId: string) => void;
  retryComposerDraftAttachment: (draftId: string, localId: string) => void;
  appendDesignSelectionsToComposerDraft: (
    draftId: string,
    selections: DesignPromptSelection[]
  ) => void;
  removeDesignSelectionFromComposerDraft: (
    draftId: string,
    selectionId: string
  ) => void;
  clearComposerDraftAssets: (draftId: string) => void;
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
  const { pushNotification } = useWorkbenchNotifications();
  const handlerRef = useRef<TranscriptHandler | null>(null);
  const pendingRef = useRef<OpenTranscriptPayload | null>(null);
  const composerHandlerRef = useRef<ComposerDraftHandler | null>(null);
  const pendingComposerRef = useRef<OpenComposerDraftPayload | null>(null);
  const conversationHandlerRef = useRef<AgentConversationHandler | null>(null);
  const pendingConversationRef = useRef<OpenAgentConversationPayload | null>(null);
  const explorerRef = useRef<ExplorerHandler | null>(null);
  const pendingExplorerRef = useRef<ExplorerOpenRequest | null>(null);
  const mountedComposerDraftIdsRef = useRef<string[]>([]);
  const imageFilesRef = useRef<Map<string, File>>(new Map());
  const [composerDrafts, setComposerDrafts] = useState<Record<string, ComposerDraftRecord>>({});
  const [composerDraftAssetsById, setComposerDraftAssetsById] = useState<
    Record<string, ComposerDraftAssets>
  >({});
  const [composerSelections, setComposerSelections] = useState<
    Record<string, TextSelection>
  >({});
  const [preferredComposerDraftId, setPreferredComposerDraftId] = useState<string | null>(
    null
  );
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
          attachments: patch.attachments ?? existing?.attachments,
        };
        if (
          existing &&
          existing.title === next.title &&
          existing.content === next.content &&
          existing.attachments === next.attachments
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

  const updateComposerDraftAssets = useCallback(
    (
      draftId: string,
      updater: (current: ComposerDraftAssets) => ComposerDraftAssets
    ) => {
      setComposerDraftAssetsById((current) => {
        const existing = current[draftId] ?? createEmptyComposerDraftAssets();
        const next = updater(existing);
        if (
          attachmentStatesEqual(existing.attachments, next.attachments) &&
          designSelectionsEqual(existing.designSelections, next.designSelections)
        ) {
          return current;
        }
        if (next.attachments.length === 0 && next.designSelections.length === 0) {
          if (!(draftId in current)) {
            return current;
          }
          const reduced = { ...current };
          delete reduced[draftId];
          return reduced;
        }
        return {
          ...current,
          [draftId]: next,
        };
      });
    },
    []
  );

  const registerComposerSurface = useCallback((draftId: string) => {
    mountedComposerDraftIdsRef.current = [
      ...mountedComposerDraftIdsRef.current.filter((candidate) => candidate !== draftId),
      draftId,
    ];
    setPreferredComposerDraftId((current) => current ?? draftId);
    return () => {
      mountedComposerDraftIdsRef.current = mountedComposerDraftIdsRef.current.filter(
        (candidate) => candidate !== draftId
      );
      setPreferredComposerDraftId((current) => {
        if (current !== draftId) {
          return current;
        }
        return mountedComposerDraftIdsRef.current.at(-1) ?? null;
      });
    };
  }, []);

  const markComposerDraftPreferred = useCallback((draftId: string) => {
    mountedComposerDraftIdsRef.current = [
      ...mountedComposerDraftIdsRef.current.filter((candidate) => candidate !== draftId),
      draftId,
    ];
    setPreferredComposerDraftId((current) => (current === draftId ? current : draftId));
  }, []);

  const appendDesignSelectionsToComposerDraft = useCallback(
    (draftId: string, selections: DesignPromptSelection[]) => {
      if (selections.length === 0) {
        return;
      }
      updateComposerDraftAssets(draftId, (current) => {
        const existingIds = new Set(current.designSelections.map((selection) => selection.id));
        const nextSelections = [
          ...current.designSelections,
          ...selections.filter((selection) => !existingIds.has(selection.id)),
        ];
        return {
          ...current,
          designSelections: nextSelections,
        };
      });
    },
    [updateComposerDraftAssets]
  );

  const removeDesignSelectionFromComposerDraft = useCallback(
    (draftId: string, selectionId: string) => {
      updateComposerDraftAssets(draftId, (current) => ({
        ...current,
        designSelections: current.designSelections.filter(
          (selection) => selection.id !== selectionId
        ),
      }));
    },
    [updateComposerDraftAssets]
  );

  const removeComposerDraftAttachment = useCallback(
    (draftId: string, localId: string) => {
      updateComposerDraftAssets(draftId, (current) => ({
        ...current,
        attachments: current.attachments.filter((attachment) => attachment.localId !== localId),
      }));
      imageFilesRef.current.delete(`${draftId}:${localId}`);
    },
    [updateComposerDraftAssets]
  );

  const appendSerializedAssetsToComposerDraft = useCallback(
    ({
      draftId,
      attachments,
      designSelections,
    }: {
      draftId: string;
      attachments?: ImageAttachment[];
      designSelections?: DesignPromptSelection[];
    }) => {
      updateComposerDraftAssets(draftId, (current) => ({
        attachments: [...current.attachments, ...normalizeDraftAttachments(attachments)],
        designSelections: [
          ...current.designSelections,
          ...(designSelections ?? []).filter(
            (selection) =>
              !current.designSelections.some((existing) => existing.id === selection.id)
          ),
        ],
      }));
    },
    [updateComposerDraftAssets]
  );

  const addFilesToComposerDraft = useCallback(
    (draftId: string, files: File[]) => {
      const imageFiles = files.filter((file) => file.type.startsWith("image/"));
      if (imageFiles.length === 0) {
        return;
      }
      let entriesToAdd: Array<{ entry: ImageAttachmentState; file: File }> = [];
      updateComposerDraftAssets(draftId, (current) => {
        const maxImages = Math.max(0, MAX_COMPOSER_IMAGES - current.attachments.length);
        const nextFiles = imageFiles.slice(0, maxImages);
        const validFiles = nextFiles.filter((file) => {
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
        if (validFiles.length === 0) {
          return current;
        }
        entriesToAdd = validFiles.map((file) => ({
          file,
          entry: {
            localId:
              globalThis.crypto?.randomUUID?.() ??
              `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            mimeType: file.type,
            data: "",
            name: file.name,
            uploadState: "pending",
            showSlowSpinner: false,
          },
        }));
        return {
          ...current,
          attachments: [
            ...current.attachments,
            ...entriesToAdd.map(({ entry }) => entry),
          ],
        };
      });
      for (const { entry, file } of entriesToAdd) {
        imageFilesRef.current.set(`${draftId}:${entry.localId}`, file);
        const slowUploadTimer = window.setTimeout(() => {
          updateComposerDraftAssets(draftId, (current) => ({
            ...current,
            attachments: current.attachments.map((attachment) =>
              attachment.localId === entry.localId
                ? { ...attachment, showSlowSpinner: true }
                : attachment
            ),
          }));
        }, SLOW_UPLOAD_THRESHOLD_MS);
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(",")[1] ?? "";
          updateComposerDraftAssets(draftId, (current) => ({
            ...current,
            attachments: current.attachments.map((attachment) =>
              attachment.localId === entry.localId
                ? { ...attachment, data: base64, uploadState: "uploading" }
                : attachment
            ),
          }));
          uploadAttachments([file])
            .then((results) => {
              clearTimeout(slowUploadTimer);
              updateComposerDraftAssets(draftId, (current) => ({
                ...current,
                attachments: current.attachments.map((attachment) =>
                  attachment.localId === entry.localId
                    ? {
                        ...attachment,
                        uploadState: "uploaded",
                        serverId: results[0]?.id,
                        showSlowSpinner: false,
                      }
                    : attachment
                ),
              }));
            })
            .catch(() => {
              clearTimeout(slowUploadTimer);
              updateComposerDraftAssets(draftId, (current) => ({
                ...current,
                attachments: current.attachments.map((attachment) =>
                  attachment.localId === entry.localId
                    ? {
                        ...attachment,
                        uploadState: "failed",
                        showSlowSpinner: false,
                      }
                    : attachment
                ),
              }));
            });
        };
        reader.readAsDataURL(file);
      }
    },
    [pushNotification, updateComposerDraftAssets]
  );

  const retryComposerDraftAttachment = useCallback(
    (draftId: string, localId: string) => {
      const file = imageFilesRef.current.get(`${draftId}:${localId}`);
      if (!file) {
        return;
      }
      const slowUploadTimer = window.setTimeout(() => {
        updateComposerDraftAssets(draftId, (current) => ({
          ...current,
          attachments: current.attachments.map((attachment) =>
            attachment.localId === localId
              ? { ...attachment, showSlowSpinner: true }
              : attachment
          ),
        }));
      }, SLOW_UPLOAD_THRESHOLD_MS);
      updateComposerDraftAssets(draftId, (current) => ({
        ...current,
        attachments: current.attachments.map((attachment) =>
          attachment.localId === localId
            ? { ...attachment, uploadState: "uploading", showSlowSpinner: false }
            : attachment
        ),
      }));
      uploadAttachments([file])
        .then((results) => {
          clearTimeout(slowUploadTimer);
          updateComposerDraftAssets(draftId, (current) => ({
            ...current,
            attachments: current.attachments.map((attachment) =>
              attachment.localId === localId
                ? {
                    ...attachment,
                    uploadState: "uploaded",
                    serverId: results[0]?.id,
                    showSlowSpinner: false,
                  }
                : attachment
            ),
          }));
        })
        .catch(() => {
          clearTimeout(slowUploadTimer);
          updateComposerDraftAssets(draftId, (current) => ({
            ...current,
            attachments: current.attachments.map((attachment) =>
              attachment.localId === localId
                ? {
                    ...attachment,
                    uploadState: "failed",
                    showSlowSpinner: false,
                  }
                : attachment
            ),
          }));
        });
    },
    [updateComposerDraftAssets]
  );

  const clearComposerDraftAssets = useCallback((draftId: string) => {
    updateComposerDraftAssets(draftId, () => createEmptyComposerDraftAssets());
  }, [updateComposerDraftAssets]);

  const appendToPreferredComposer = useCallback(
    ({
      files,
      designSelections,
    }: {
      files?: File[];
      designSelections?: DesignPromptSelection[];
    }) => {
      const draftId =
        expandedComposerDraftId ??
        preferredComposerDraftId ??
        mountedComposerDraftIdsRef.current.at(-1) ??
        null;
      if (!draftId) {
        return null;
      }
      markComposerDraftPreferred(draftId);
      if (files && files.length > 0) {
        addFilesToComposerDraft(draftId, files);
      }
      if (designSelections && designSelections.length > 0) {
        appendDesignSelectionsToComposerDraft(draftId, designSelections);
      }
      return draftId;
    },
    [
      addFilesToComposerDraft,
      appendDesignSelectionsToComposerDraft,
      expandedComposerDraftId,
      markComposerDraftPreferred,
      preferredComposerDraftId,
    ]
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
      setComposerDraftAssetsById({});
      setComposerSelections({});
      setPreferredComposerDraftId(null);
      setExpandedComposerDraftId(null);
      setExpandedComposerControllerState(null);
      mountedComposerDraftIdsRef.current = [];
      imageFilesRef.current.clear();
      return;
    }
    const persisted = readPersistedComposerState(activeWorkspaceId);
    setComposerDrafts(persisted?.drafts ?? {});
    setComposerDraftAssetsById({});
    setComposerSelections(persisted?.selections ?? {});
    setPreferredComposerDraftId(null);
    setExpandedComposerDraftId(persisted?.expandedDraftId ?? null);
    setExpandedComposerControllerState(null);
    mountedComposerDraftIdsRef.current = [];
    imageFilesRef.current.clear();
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
      composerDraftAssetsById,
      composerSelections,
      upsertComposerDraft,
      registerComposerSurface,
      markComposerDraftPreferred,
      preferredComposerDraftId,
      addFilesToComposerDraft,
      appendSerializedAssetsToComposerDraft,
      appendToPreferredComposer,
      removeComposerDraftAttachment,
      retryComposerDraftAttachment,
      appendDesignSelectionsToComposerDraft,
      removeDesignSelectionFromComposerDraft,
      clearComposerDraftAssets,
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
      composerDraftAssetsById,
      composerSelections,
      upsertComposerDraft,
      registerComposerSurface,
      markComposerDraftPreferred,
      preferredComposerDraftId,
      addFilesToComposerDraft,
      appendSerializedAssetsToComposerDraft,
      appendToPreferredComposer,
      removeComposerDraftAttachment,
      retryComposerDraftAttachment,
      appendDesignSelectionsToComposerDraft,
      removeDesignSelectionFromComposerDraft,
      clearComposerDraftAssets,
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
