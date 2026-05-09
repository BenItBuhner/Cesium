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
  | "subagent"
  | "ask-question"
  | "permission-request"
  | "activity-label"
  | "worked-session"
  | "shell-run"
  | "agent-handoff"
  | "chat-fork";

/** One block inside a collapsible “Worked for …” session. */
export type WorkedSessionEntry =
  | { kind: "verbatim"; text: string }
  | { kind: "explore"; paths: string[]; caption?: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool";
      /** Stable id from agent `toolCallId` for list keys + updates */
      toolCallId?: string;
      /** Normalized action class for dropdown summaries and UI affordances. */
      toolKind?: string;
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
  type: "text" | "file" | "context" | "image" | "design";
  text: string;
  mimeType?: string;
  data?: string;
  /** Design pills: stable id so composer pills and history pills stay correlated. */
  captureId?: string;
  /** Design pills: 'select' (clicked element) or 'stroke' (lasso). */
  captureKind?: "select" | "stroke";
  /** Design pills: full HTML outer fragment sent to the agent (for tooltip/expanded view). */
  captureSnippet?: string;
}

export interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
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
  options: AskQuestionOption[];
}

export interface ChatMessage {
  id: string;
  type: ChatMessageType;
  content?: string;
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
    | "browser";
  content: string;
  active?: boolean;
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
  /** Relative workspace path when this tab represents a real file on disk. */
  filePath?: string;
  /** Server-side terminal session id when this tab represents a PTY. */
  terminalId?: string;
  /** In-IDE browser tab proxied through the workspace server. */
  browser?: {
    targetUrl: string;
    /** Absolute favicon URL (resolved client-side; displayed via proxy). */
    faviconUrl?: string;
    /** OSP-72: element inspect / annotate mode (guest script in proxied HTML). */
    designMode?: boolean;
    /** DevTools console panel open (CDP sidecar). */
    devtoolsOpen?: boolean;
    /** Server debug session id for CDP bridge. */
    debugSessionId?: string | null;
    /**
     * Absolute-path URL (starts with `/`) of the real Chromium DevTools frontend
     * proxied through the workspace server. Set after a successful
     * `POST /api/browser-debug/sessions`. `BrowserTab` loads this URL directly in
     * the split devtools iframe.
     */
    devtoolsPath?: string | null;
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
}

export interface WorkspaceInfo {
  id: string;
  root: string;
  name: string;
}

export interface WorkspaceRecord {
  id: string;
  root: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
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
  backendId?: import("./agent-types").AgentBackendId;
  mode?: EditorMode;
  modelId?: string;
  modelName?: string;
  setConfigOptions?: Array<{ configId: string; value: string }>;
};

/** Pending follow-up prompt while the agent turn is still running. */
export type QueuedChatPrompt = {
  id: string;
  text: string;
  attachments?: ImageAttachment[];
  clientEventId?: string;
  clientMessageId?: string;
  configOverride?: QueuedPromptConfigOverride;
};

export interface ChatTab {
  id: string;
  title: string;
  active?: boolean;
  isDraft?: boolean;
}

export type KnownEditorMode = "agent" | "plan" | "debug" | "ask";

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
