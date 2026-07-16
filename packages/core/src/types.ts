export type WorkedSessionEditPreviewLine = {
  kind: "context" | "add" | "remove" | "gap";
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
};

export type WorkedSessionEditPreview = {
  path?: string;
  source: "before_after" | "patch" | "replace";
  addedLines: number;
  removedLines: number;
  truncated?: boolean;
  lines: WorkedSessionEditPreviewLine[];
};

export interface FileNode {
  name: string;
  type: "file" | "folder";
  children?: FileNode[];
  language?: string;
  dimmed?: boolean;
  hasChildren?: boolean;
  childrenLoaded?: boolean;
}

export type ChatMessageType =
  | "user"
  | "assistant"
  | "todo-status"
  | "todo"
  | "todo-update"
  | "subagent"
  | "ask-question"
  | "permission-request"
  | "activity-label"
  | "worked-session"
  | "shell-run"
  | "agent-handoff"
  | "chat-fork"
  | "turn-footer";

/** One block inside a collapsible “Worked for …” session. */
export type WorkedSessionEntry =
  | { kind: "verbatim"; text: string }
  | { kind: "explore"; paths: string[]; caption?: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "compression";
      summary: string;
      retainedTurnCount: number;
      compressedTurnCount: number;
    }
  | {
      kind: "tool";
      /** Stable id from agent `toolCallId` for list keys + updates */
      toolCallId?: string;
      /** Normalized action class for dropdown summaries and UI affordances. */
      toolKind?: string;
      /** MCP config id when {@link toolKind} is `mcp` (Cesium `call_mcp_tool`, etc.). */
      mcpServerId?: string;
      pluginId?: string;
      pluginName?: string;
      pluginIconUrl?: string;
      title: string;
      detail?: string;
      /** Full stdout/file/search payload kept behind a disclosure instead of inline. */
      rawDetail?: string;
      variant?: "default" | "terminal";
      status?: "pending" | "running" | "completed" | "failed" | "cancelled";
      locations?: Array<{ path: string; line?: number }>;
      files?: string[];
      editPreview?: WorkedSessionEditPreview;
    };

export type ImageAttachment = {
  mimeType: string;
  data: string;
  name?: string;
};

export type ImageAttachmentState = {
  localId: string;
  mimeType: string;
  data: string;
  name?: string;
  uploadState?: "pending" | "uploading" | "uploaded" | "failed";
  serverId?: string;
  error?: string;
  showSlowSpinner?: boolean;
};

/** Inline user bubble: plain text runs, file/context chips, or design-capture pills. */
export interface UserMessageSegment {
  type: "text" | "file" | "context" | "image" | "design" | "text-reference";
  text: string;
  mimeType?: string;
  data?: string;
  /** Design pills: stable id so composer pills and history pills stay correlated. */
  captureId?: string;
  /** Design pills: 'select' (clicked element) or 'stroke' (lasso). */
  captureKind?: "select" | "stroke";
  /** Design pills: full HTML outer fragment sent to the agent (for tooltip/expanded view). */
  captureSnippet?: string;
  /** Text-reference pills: stable id so composer and history pills stay correlated. */
  referenceId?: string;
  /** Text-reference pills: original pasted text for tooltip/detail display. */
  referenceText?: string;
  /** Text-reference pills: original pasted character count. */
  referenceCharCount?: number;
}

export interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "blocked" | "completed";
}

export interface AskQuestionOption {
  letter: string;
  text: string;
  isOther?: boolean;
  placeholder?: string;
}

export interface PermissionChoiceOption {
  id: string;
  label: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

/** One step in a docked / inline question wizard (3–5 typical). */
export interface AskQuestionStep {
  id: string;
  title: string;
  /** Shown above the answer list (body copy for the step). */
  content?: string;
  allowMultiple?: boolean;
  options: AskQuestionOption[];
}

export interface ChatMessage {
  id: string;
  type: ChatMessageType;
  content?: string;
  /** Full user prompt text when `content` is a display-friendly summary. */
  rawContent?: string;
  /** Rich user bubble; when set, overrides plain `content` for body text. */
  segments?: UserMessageSegment[];
  /** Image attachments for user messages. */
  attachments?: ImageAttachment[];
  /** Small reply/undo affordance in the user bubble corner. */
  showReplyCue?: boolean;
  todos?: TodoItem[];
  todoLabel?: string;
  subagentTitle?: string;
  subagentMeta?: string;
  /** When false, shows a spinner; omit or true when the subagent has finished. */
  subagentComplete?: boolean;
  /** Opens in editor when the subagent card is clicked. */
  subagentTranscript?: ChatMessage[];
  subagentId?: string;
  subagentStatus?: "running" | "completed" | "failed";
  recentActivity?: string;
  questionTitle?: string;
  options?: AskQuestionOption[];
  /** Multi-step questions; when set, takes precedence over `questionTitle` + `options`. */
  questionSteps?: AskQuestionStep[];
  permissionRequestId?: string;
  /** Tie permission cards to a tool in the same turn (embedding + ordering). */
  permissionLinkedToolCallId?: string;
  permissionTitle?: string;
  permissionDetail?: string;
  permissionOptions?: PermissionChoiceOption[];
  permissionResolved?: boolean;
  permissionSelectedOptionId?: string;
  /** Collapsible status row: timing, reasoning, explored files, etc. */
  activityLabel?: string;
  activityDetail?: string;
  activityFiles?: string[];
  activityDefaultOpen?: boolean;
  /** Single collapsible trace: reads, reasoning, tool calls. */
  workedLabel?: string;
  workedEntries?: WorkedSessionEntry[];
  /** When set, the primary edit diff is also surfaced outside the tool list (see `toolDetailsInWorkedCard`). */
  workedHighlightedEntry?: Extract<WorkedSessionEntry, { kind: "tool" }>;
  /** Seeds initial expand; persisted `open` overrides when set. */
  workedDefaultOpen?: boolean;
  /** Terminal / command runner card */
  shellTitle?: string;
  /** Loading/working placeholder before any agent content arrives */
  loading?: boolean;
  /** Agent handoff divider */
  handoffFromAgent?: string;
  handoffToAgent?: string;
  /** Whether this message was created as part of a handoff operation */
  isHandoffMessage?: boolean;
  /** Number of user turns included in the handoff transcript (metadata only, not rendered). */
  handoffTurnCount?: number;
  /** Number of tool calls included in the handoff transcript (metadata only, not rendered). */
  handoffToolCallCount?: number;
  /** Chat fork divider */
  forkFromAgent?: string;
  forkFromConversationId?: string;
  /** Completed turn footer: wall-clock run time in milliseconds. */
  turnDurationMs?: number;
  /** User message id to fork up to when the footer fork button is clicked. */
  turnFooterUserMessageId?: string;
}

export interface EditorTab {
  id: string;
  name: string;
  language: string;
  icon:
    | "terminal"
    | "json"
    | "markdown"
    | "agent"
    | "subagent"
    | "typescript"
    | "css"
    | "default"
    | "settings"
    | "browser"
    | "kanban"
    | "plan"
    | "extension";
  content: string;
  active?: boolean;
  /** New explicit discriminator for extension surfaces; older tab kinds still infer from legacy fields. */
  kind?:
    | "file"
    | "agentConversation"
    | "transcript"
    | "composerDraft"
    | "browser"
    | "terminal"
    | "orchestration"
    | "extension";
  /** Renders agent-style transcript instead of Monaco (e.g. subagent detail tab). */
  transcriptMessages?: ChatMessage[];
  /** Real OpenCode session id for live subagent transcript hydration. */
  transcriptSessionId?: string;
  /** When set, {@link AgentTranscriptView} replays this conversation's events for live subagent rows. */
  transcriptLiveConversationId?: string;
  /** Live primary agent conversation opened from the chat pane. */
  conversationId?: string;
  /** Source/preview toggle for previewable files like Markdown and SVG. */
  previewMode?: "source" | "preview";
  /** True when this markdown tab is a Cesium plan file with plan-specific controls. */
  planFile?: boolean;
  /** Relative workspace path when this tab represents a real file on disk. */
  filePath?: string;
  /** Server-side terminal session id when this tab represents a PTY. */
  terminalId?: string;
  /** In-IDE browser tab. Native desktop/server-Chromium engines replace the legacy proxy when available. */
  browser?: {
    targetUrl: string;
    /** Active browser engine for this tab; absent means legacy proxy. */
    engine?: "proxy" | "electron-native" | "server-chromium";
    /** Absolute favicon URL (resolved client-side; displayed via proxy). */
    faviconUrl?: string;
    /** OSP-72: element inspect / annotate mode (guest script in proxied HTML). */
    designMode?: boolean;
    /** DevTools console panel open (CDP sidecar). */
    devtoolsOpen?: boolean;
    /** Server debug session id for CDP bridge. */
    debugSessionId?: string | null;
    /** Electron main-process WebContentsView session id. Ephemeral across reloads. */
    nativeSessionId?: string | null;
    /**
     * Absolute-path URL (starts with `/`) of the real Chromium DevTools frontend
     * proxied through the workspace server. Set after a successful
     * `POST /api/browser-debug/sessions`. `BrowserTab` loads this URL directly in
     * the split devtools iframe.
     */
    devtoolsPath?: string | null;
    /** Durable OSP-96 browser-control session id, distinct from engine-specific sessions. */
    controlSessionId?: string | null;
    lockState?: {
      locked: boolean;
      lockVersion: number;
      lockedByConversationId?: string | null;
      lockReason?: string | null;
      lockedAt?: number | null;
      userUnlockedAt?: number | null;
      userAlteredAt?: number | null;
    };
    viewport?: {
      preset: "watch" | "mobile" | "tablet" | "laptop" | "desktop" | "custom";
      width: number;
      height: number;
      deviceScaleFactor?: number;
      mobile?: boolean;
      touch?: boolean;
    };
  };
  /** Server-owned Orchestration Mode board rendered as a kanban surface. */
  orchestrationBoard?: {
    boardId: string;
  };
  extensionSurface?: {
    kind: "marketplace" | "webview" | "customEditor" | "view" | "output";
    extensionId: string;
    surfaceId: string;
    title: string;
    surfaceSessionId?: string;
    placement?: "sidebar" | "editor";
    html?: string;
    viewType?: string;
    resourceRoot?: string;
  };
  /** File classification used to drive editor vs preview rendering. */
  fileKind?: "text" | "svg" | "image";
  /** Best-effort mime type from the backend. */
  mimeType?: string;
  /** Backend path for raw preview rendering (image/svg). */
  previewPath?: string;
  /** Waiting on file content to be fetched from the backend. */
  loading?: boolean;
  /** Buffer diverges from the last saved on-disk content. */
  dirty?: boolean;
  /** Last successful on-disk content snapshot for dirty detection. */
  savedContent?: string;
  /** File changed on disk while the editor also had local edits. */
  externalChange?: boolean;
  /** Ephemeral editor tab bound to the chat composer draft. */
  composerDraftId?: string;
  /** Large file: only part of the buffer is loaded from the server. */
  fileContentTruncated?: boolean;
  fileTotalBytes?: number;
  fileLoadedThroughByte?: number;
}

/** Payload to open a demo file from the explorer into the editor (deduped by `path`). */
export interface ExplorerOpenRequest {
  path: string;
  name: string;
  language: string;
  content?: string;
  icon: EditorTab["icon"];
  previewMode?: EditorTab["previewMode"];
  planFile?: boolean;
}

export interface WorkspaceInfo {
  id: string;
  root: string;
  name: string;
}

/** Persistent project folder vs ephemeral per-chat sandbox. */
export type WorkspaceKind = "workspace" | "standalone-chat";

export interface WorkspaceRecord {
  id: string;
  root: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  /**
   * When `"standalone-chat"`, this entry is a temporary per-chat sandbox (not a
   * user-managed workspace). Older records omit the field (= `"workspace"`).
   */
  kind?: WorkspaceKind;
}

/**
 * True for ephemeral chat sandboxes. Prefers explicit `kind`, then falls back to
 * the `standalone-chats` path convention used by the server.
 */
export function isStandaloneChatWorkspace(
  workspace: Pick<WorkspaceRecord, "kind" | "root">
): boolean {
  if (workspace.kind === "standalone-chat") {
    return true;
  }
  if (workspace.kind === "workspace") {
    return false;
  }
  const normalized = workspace.root.replace(/\\/g, "/");
  return normalized.includes("/standalone-chats/");
}

export type GitBranchInfo = {
  name: string;
  type: "local" | "remote";
  current: boolean;
  upstream?: string;
};

export type GitWorktreeInfo = {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  bare: boolean;
  current: boolean;
  workspaceId?: string;
  workspaceName?: string;
};

export type GitWorkspaceStatus = {
  isGitRepo: boolean;
  root: string;
  repoRoot?: string;
  repoKey?: string;
  currentBranch?: string | null;
  detached?: boolean;
  dirty?: boolean;
  aheadBehind?: { ahead: number; behind: number } | null;
  branches: GitBranchInfo[];
  worktrees: GitWorktreeInfo[];
  error?: string;
};

export type GitWorktreeSetupResult = {
  ran: boolean;
  sourcePath?: string;
  commands: string[];
  output: string[];
};

export interface WorkspaceWindowRecord {
  id: string;
  workspaceId: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  lastFocusedAt?: number;
  closedAt?: number;
}

export interface TerminalInfo {
  id: string;
  shell: string;
  cwd: string;
  alive: boolean;
  attachedClients: number;
}

export type FileWatcherEvent =
  | { type: "add"; seq: number; path: string; isDir: false }
  | { type: "addDir"; seq: number; path: string; isDir: true }
  | { type: "change"; seq: number; path: string }
  | { type: "unlink"; seq: number; path: string; isDir: false }
  | { type: "unlinkDir"; seq: number; path: string; isDir: true }
  | {
      type: "workspace_snapshot";
      workspaceId: string;
      root: string;
      name: string;
      latestSeq: number;
    }
  | { type: "ready"; latestSeq: number }
  | { type: "resync_required"; latestSeq: number }
  | { type: "pong"; latestSeq: number };

/** Live agent chat tab affordances; keyed by conversation id (not persisted). */
export type AgentTabIndicatorByConversationId = Record<
  string,
  {
    needsAttention: boolean;
    running: boolean;
    /** Turn finished while tab was in background; cleared when user focuses the tab. */
    unreadCompletion?: boolean;
  }
>;

export type QueuedPromptConfigOverride = {
  backendId?: import("./protocol").AgentBackendId;
  mode?: EditorMode;
  modelId?: string;
  modelName?: string;
  setConfigOptions?: Array<{ configId: string; value: string }>;
};

export type PlanBuildHandoff = {
  planPath: string;
  planTitle?: string;
  targetMode?: EditorMode;
  targetModelId?: string;
  targetModelName?: string;
};

/** Pending follow-up prompt while the agent turn is still running. */
export type QueuedChatPrompt = {
  id: string;
  text: string;
  delivery?: "normal" | "steer";
  attachments?: ImageAttachment[];
  clientEventId?: string;
  clientMessageId?: string;
  configOverride?: QueuedPromptConfigOverride;
  planHandoff?: PlanBuildHandoff;
  hidden?: boolean;
};

export interface ChatTab {
  id: string;
  title: string;
  active?: boolean;
  isDraft?: boolean;
}

export type KnownEditorMode =
  | "agent"
  | "plan"
  | "debug"
  | "ask"
  | "goal"
  | "burn"
  | "workflow"
  | "orchestration";

export type EditorMode = KnownEditorMode | (string & {});

export interface AgentModeOption {
  id: EditorMode;
  label: string;
  description?: string;
}

export interface ModelInfo {
  id: string;
  modelValue?: string;
  name: string;
  description?: string;
  detail?: string;
  backendId?: string;
  configSelections?: Array<{ configId: string; value: string }>;
  provider:
    | "openai"
    | "anthropic"
    | "google"
    | "auto"
    | "cursor"
    | "opencode"
    | "codex"
    | "claude"
    | "fixture";
  selected?: boolean;
}
