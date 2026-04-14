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
  | "agent-handoff";

/** One block inside a collapsible “Worked for …” session. */
export type WorkedSessionEntry =
  | { kind: "verbatim"; text: string }
  | { kind: "explore"; paths: string[]; caption?: string }
  | { kind: "reasoning"; text: string }
  /** Model text interleaved before more tool/reasoning trace; keeps one worked-session dropdown. */
  | { kind: "assistant_inline"; text: string }
  | {
      kind: "tool";
      /** Stable id from agent `toolCallId` for list keys + updates */
      toolCallId?: string;
      /** Normalized action class for dropdown summaries and UI affordances. */
      toolKind?: string;
      title: string;
      detail?: string;
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

export type DesignPromptSelection = {
  id: string;
  label: string;
  selector?: string;
  targetUrl?: string;
  html: string;
  css?: string;
  javascript?: string;
};

/** Inline user bubble: plain text runs and file/context chips. */
export interface UserMessageSegment {
  type: "text" | "file" | "context" | "image" | "design";
  text: string;
  mimeType?: string;
  data?: string;
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
  /** Structured browser design selections attached to the user turn. */
  designSelections?: DesignPromptSelection[];
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
  /** Standalone highlighted tool row rendered outside the dropdown, e.g. edit diffs. */
  workedHighlightedEntry?: Extract<WorkedSessionEntry, { kind: "tool" }>;
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
  /** Live primary agent conversation opened from the chat pane. */
  conversationId?: string;
  /** Source/preview toggle for previewable files like Markdown and SVG. */
  previewMode?: "source" | "preview";
  /** Relative workspace path when this tab represents a real file on disk. */
  filePath?: string;
  /** Server-side terminal session id when this tab represents a PTY. */
  terminalId?: string;
  /** In-IDE browser tab proxied through the workspace server. */
  browser?: { targetUrl: string; /** Absolute favicon URL (resolved client-side; displayed via proxy). */ faviconUrl?: string };
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

/** Pending follow-up prompt while the agent turn is still running. */
export type QueuedChatPrompt = {
  id: string;
  text: string;
  attachments?: ImageAttachment[];
  designSelections?: DesignPromptSelection[];
};

export interface ChatTab {
  id: string;
  title: string;
  active?: boolean;
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
