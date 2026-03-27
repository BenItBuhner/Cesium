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
  | "activity-label"
  | "worked-session"
  | "shell-run";

/** One block inside a collapsible “Worked for …” session. */
export type WorkedSessionEntry =
  | { kind: "verbatim"; text: string }
  | { kind: "explore"; paths: string[]; caption?: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool";
      title: string;
      detail?: string;
      variant?: "default" | "terminal";
    };

/** Inline user bubble: plain text runs and file/context chips. */
export interface UserMessageSegment {
  type: "text" | "file";
  text: string;
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
  questionTitle?: string;
  options?: AskQuestionOption[];
  /** Multi-step questions; when set, takes precedence over `questionTitle` + `options`. */
  questionSteps?: AskQuestionStep[];
  /** Collapsible status row: timing, reasoning, explored files, etc. */
  activityLabel?: string;
  activityDetail?: string;
  activityFiles?: string[];
  activityDefaultOpen?: boolean;
  /** Single collapsible trace: reads, reasoning, tool calls. */
  workedLabel?: string;
  workedEntries?: WorkedSessionEntry[];
  workedDefaultOpen?: boolean;
  /** Terminal / command runner card */
  shellTitle?: string;
}

export interface EditorTab {
  id: string;
  name: string;
  language: string;
  icon:
    | "terminal"
    | "json"
    | "markdown"
    | "typescript"
    | "css"
    | "default"
    | "settings"
    | "browser";
  content: string;
  active?: boolean;
  /** Renders agent-style transcript instead of Monaco (e.g. subagent detail tab). */
  transcriptMessages?: ChatMessage[];
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
  root: string;
  name: string;
}

export interface TerminalInfo {
  id: string;
  shell: string;
  cwd: string;
  alive: boolean;
  attachedClients: number;
}

export type FileWatcherEvent =
  | { type: "add"; path: string; isDir: false }
  | { type: "addDir"; path: string; isDir: true }
  | { type: "change"; path: string }
  | { type: "unlink"; path: string; isDir: false }
  | { type: "unlinkDir"; path: string; isDir: true }
  | { type: "ready" }
  | { type: "pong" }
  | { type: "workspace_changed"; root: string; name: string };

export interface ChatTab {
  id: string;
  title: string;
  active?: boolean;
}

export type EditorMode = "agent" | "plan" | "debug" | "ask";

export interface ModelInfo {
  id: string;
  name: string;
  provider: "openai" | "anthropic" | "google" | "auto";
  selected?: boolean;
}

