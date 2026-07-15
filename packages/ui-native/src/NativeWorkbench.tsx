import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ColorValue,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import {
  AlertCircle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  File,
  Folder,
  Infinity as InfinityIcon,
  Maximize2,
  Menu,
  MoreHorizontal,
  Paperclip,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  UserRound,
  Wrench,
  X,
} from "lucide-react-native";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import type {
  AgentBackendInfo,
  AgentConversationRecord,
  AgentSocketServerMessage,
  ChatMessage,
  FileNode,
  MobileAgentProjection,
  WorkedSessionEntry,
} from "@cesium/core";
import {
  deriveMobileAgentProjection,
  projectAgentEventsToChatMessages,
} from "@cesium/core";
import {
  answerAgentPermission,
  answerAgentQuestion,
  buildAgentWebSocketUrl,
  createAndPromptAgentConversation,
  fetchAgentConversationSnapshot,
  fetchFolderChildren,
  fetchTree,
  listAgentConversations,
  promptAgentConversation,
  readFile,
  writeFile,
} from "@cesium/client";
import type { ThemeTokens } from "@cesium/design";
import { useThemeTokens } from "./theme";
import { useNativeAuth } from "./providers/NativeAuthProvider";
import { useNativeWorkspace } from "./providers/NativeWorkspaceProvider";
import {
  flattenVisibleFileTree,
  reduceConversationFeed,
  type ConversationFeedState,
  type VisibleFileRow,
} from "./workbench-state";

export type NativeWorkbenchPanel = "files" | "editor" | "chat";

export type NativeWorkbenchProps = {
  connectionState?: "idle" | "connecting" | "open" | "closed" | "reconnecting";
  notificationConversationId?: string | null;
  onFocusedConversationChange?: (
    workspaceId: string | null,
    conversationId: string | null
  ) => void;
  onProjection?: (projection: MobileAgentProjection | null) => void;
};

type EditorDocument = {
  path: string;
  content: string;
  language: string;
  dirty: boolean;
};

type IconComponent = ComponentType<{
  color?: ColorValue;
  size?: number;
  strokeWidth?: number;
}>;

const EMPTY_FEED: ConversationFeedState = {
  conversation: null,
  events: [],
};

const PANEL_ITEMS: Array<{
  id: NativeWorkbenchPanel;
  label: string;
}> = [
  { id: "files", label: "Files" },
  { id: "editor", label: "Editor" },
  { id: "chat", label: "Chat" },
];

function tokenNumber(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatModelLabel(conversation: AgentConversationRecord | null, backend: AgentBackendInfo | null) {
  return conversation?.config.modelName || backend?.defaultModelName || "Select model";
}

function formatStatus(status: AgentConversationRecord["status"] | undefined): string {
  switch (status) {
    case "running":
      return "Working";
    case "pause_requested":
    case "pausing":
      return "Pausing";
    case "paused":
      return "Paused";
    case "awaiting_permission":
      return "Needs permission";
    case "awaiting_question":
      return "Needs input";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
    default:
      return "";
  }
}

function replaceFolderChildren(
  nodes: FileNode[] | undefined,
  targetPath: string,
  children: FileNode[],
  parentPath = ""
): FileNode[] | undefined {
  if (!nodes) {
    return nodes;
  }
  return nodes.map((node) => {
    const path = parentPath ? `${parentPath}/${node.name}` : node.name;
    if (path === targetPath && node.type === "folder") {
      return { ...node, children, childrenLoaded: true };
    }
    if (node.type !== "folder") {
      return node;
    }
    const nextChildren = replaceFolderChildren(node.children, targetPath, children, path);
    return nextChildren === node.children ? node : { ...node, children: nextChildren };
  });
}

function useConversationFeed(
  workspaceId: string | null,
  conversationId: string | null
): {
  feed: ConversationFeedState;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [feed, setFeed] = useState<ConversationFeedState>(EMPTY_FEED);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!workspaceId || !conversationId) {
      setFeed(EMPTY_FEED);
      setLoading(false);
      setError(null);
      return;
    }
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;

    const applyMessage = (message: AgentSocketServerMessage) => {
      setFeed((current) => reduceConversationFeed(current, message, conversationId));
    };

    const connect = () => {
      if (disposed) {
        return;
      }
      socket = new WebSocket(buildAgentWebSocketUrl(workspaceId));
      socket.onopen = () => {
        reconnectAttempt = 0;
        socket?.send(
          JSON.stringify({
            type: "subscribe",
            conversationIds: [conversationId],
            sinceByConversationId: {
              [conversationId]: feed.events.reduce(
                (latest, event) => Math.max(latest, event.seq),
                0
              ),
            },
          })
        );
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") {
          return;
        }
        try {
          applyMessage(JSON.parse(event.data) as AgentSocketServerMessage);
        } catch {
          setError("The server returned an invalid agent update.");
        }
      };
      socket.onclose = () => {
        if (disposed) {
          return;
        }
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(
          connect,
          Math.min(30_000, 1_000 * 2 ** reconnectAttempt)
        );
      };
    };

    setLoading(true);
    setError(null);
    setFeed(EMPTY_FEED);
    void fetchAgentConversationSnapshot(conversationId, { limitEvents: 500 })
      .then(({ snapshot }) => {
        if (disposed) {
          return;
        }
        setFeed({
          conversation: snapshot.conversation,
          events: snapshot.events,
        });
      })
      .catch((nextError) => {
        if (!disposed) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Failed to load the conversation."
          );
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false);
        }
      });
    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
    // A refresh intentionally rebuilds the socket and snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, refreshKey, workspaceId]);

  return {
    feed,
    loading,
    error,
    refresh: () => setRefreshKey((current) => current + 1),
  };
}

function IconButton({
  accessibilityLabel,
  Icon,
  onPress,
  tokens,
  testID,
}: {
  accessibilityLabel: string;
  Icon: IconComponent;
  onPress?: () => void;
  tokens: ThemeTokens;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        sharedStyles.iconButton,
        pressed ? { backgroundColor: tokens["--accent-bg"] } : null,
      ]}
      testID={testID}
    >
      <Icon color={tokens["--text-secondary"]} size={16} strokeWidth={1.5} />
    </Pressable>
  );
}

function LoadingScreen({ label, tokens }: { label: string; tokens: ThemeTokens }) {
  return (
    <View style={[sharedStyles.centered, { backgroundColor: tokens["--bg-main"] }]}>
      <ActivityIndicator color={tokens["--text-secondary"]} />
      <Text style={[sharedStyles.loadingLabel, { color: tokens["--text-secondary"] }]}>
        {label}
      </Text>
    </View>
  );
}

function LoginScreen({ tokens }: { tokens: ThemeTokens }) {
  const { connectionError, error, login, loginPending } = useNativeAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const styles = useMemo(() => createStyles(tokens), [tokens]);

  return (
    <View style={styles.loginScreen} testID="cesium-native-login">
      <View style={styles.loginCard}>
        <Text style={styles.loginTitle}>Cesium</Text>
        <Text style={styles.loginSubtitle}>Sign in to your workbench</Text>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setUsername}
          placeholder="Username"
          placeholderTextColor={tokens["--text-disabled"]}
          style={styles.loginInput}
          value={username}
        />
        <TextInput
          onChangeText={setPassword}
          onSubmitEditing={() => void login({ username, password, remember: true })}
          placeholder="Password"
          placeholderTextColor={tokens["--text-disabled"]}
          secureTextEntry
          style={styles.loginInput}
          value={password}
        />
        {error || connectionError ? (
          <Text style={styles.errorText}>{error ?? connectionError}</Text>
        ) : null}
        <Pressable
          disabled={loginPending || !username.trim() || !password}
          onPress={() => void login({ username, password, remember: true })}
          style={({ pressed }) => [
            styles.primaryButton,
            pressed ? styles.pressed : null,
            loginPending || !username.trim() || !password ? styles.disabled : null,
          ]}
        >
          {loginPending ? (
            <ActivityIndicator color={tokens["--bg-main"]} />
          ) : (
            <Text style={styles.primaryButtonText}>Sign in</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

function FileRow({
  expanded,
  onPress,
  row,
  styles,
  tokens,
}: {
  expanded: boolean;
  onPress: () => void;
  row: VisibleFileRow;
  styles: ReturnType<typeof createStyles>;
  tokens: ThemeTokens;
}) {
  const isFolder = row.node.type === "folder";
  return (
    <Pressable
      accessibilityLabel={`${isFolder ? "Folder" : "File"} ${row.path}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.fileRow,
        { paddingLeft: 7 + row.depth * 14 },
        pressed ? styles.fileRowPressed : null,
      ]}
      testID={`file-row-${row.path}`}
    >
      {isFolder ? (
        <>
          {expanded ? (
            <ChevronDown color={tokens["--text-disabled"]} size={11} strokeWidth={1.6} />
          ) : (
            <ChevronRight color={tokens["--text-disabled"]} size={11} strokeWidth={1.6} />
          )}
          <Folder color={tokens["--text-secondary"]} size={14} strokeWidth={1.4} />
        </>
      ) : (
        <>
          <View style={sharedStyles.fileIndent} />
          <File color={tokens["--palette-icon-fallback"]} size={14} strokeWidth={1.4} />
        </>
      )}
      <Text numberOfLines={1} style={styles.fileName}>
        {row.node.name}
      </Text>
    </Pressable>
  );
}

function FilesPanel({
  activeDocumentPath,
  onOpenFile,
  styles,
  tokens,
  workspaceName,
}: {
  activeDocumentPath: string | null;
  onOpenFile: (path: string) => void;
  styles: ReturnType<typeof createStyles>;
  tokens: ThemeTokens;
  workspaceName: string;
}) {
  const [tree, setTree] = useState<FileNode | null>(null);
  const [root, setRoot] = useState("");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    void fetchTree(2)
      .then((result) => {
        if (!disposed) {
          setRoot(result.root);
          setTree(result.tree);
        }
      })
      .catch((nextError) => {
        if (!disposed) {
          setError(nextError instanceof Error ? nextError.message : "Failed to load files.");
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [refreshKey]);

  const rows = useMemo(
    () => flattenVisibleFileTree(tree?.children, expandedPaths),
    [expandedPaths, tree?.children]
  );

  const handleRowPress = useCallback(
    (row: VisibleFileRow) => {
      if (row.node.type === "file") {
        onOpenFile(row.path);
        return;
      }
      const expanding = !expandedPaths.has(row.path);
      setExpandedPaths((current) => {
        const next = new Set(current);
        if (next.has(row.path)) {
          next.delete(row.path);
        } else {
          next.add(row.path);
        }
        return next;
      });
      if (expanding && !row.node.childrenLoaded && !row.node.children?.length) {
        void fetchFolderChildren(row.path, 2)
          .then(({ children }) => {
            setTree((current) =>
              current
                ? {
                    ...current,
                    children: replaceFolderChildren(current.children, row.path, children),
                  }
                : current
            );
          })
          .catch((nextError) => {
            setError(
              nextError instanceof Error ? nextError.message : `Failed to open ${row.path}.`
            );
          });
      }
    },
    [expandedPaths, onOpenFile]
  );

  return (
    <View style={styles.panel} testID="cesium-files-panel">
      <View style={styles.explorerToolbar}>
        <View style={sharedStyles.toolbarSpacer} />
        <IconButton accessibilityLabel="Explorer menu" Icon={Menu} tokens={tokens} />
        <IconButton
          accessibilityLabel="Refresh files"
          Icon={RefreshCw}
          onPress={() => setRefreshKey((current) => current + 1)}
          tokens={tokens}
          testID="refresh-files"
        />
        <IconButton accessibilityLabel="Search files" Icon={Search} tokens={tokens} />
        <IconButton accessibilityLabel="Maximize explorer" Icon={Maximize2} tokens={tokens} />
      </View>
      <Text numberOfLines={1} style={styles.explorerTitle}>
        {workspaceName || root.split(/[\\/]/).filter(Boolean).at(-1) || "Workspace"}
      </Text>
      {loading ? (
        <LoadingScreen label="Loading files..." tokens={tokens} />
      ) : error && !tree ? (
        <View style={sharedStyles.centered}>
          <AlertCircle color={tokens["--text-secondary"]} size={18} />
          <Text style={styles.errorText}>{error}</Text>
          <Pressable
            onPress={() => setRefreshKey((current) => current + 1)}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          contentContainerStyle={styles.fileList}
          data={rows}
          keyExtractor={(row) => row.path}
          renderItem={({ item }) => (
            <View
              style={item.path === activeDocumentPath ? styles.selectedFileRow : null}
            >
              <FileRow
                expanded={expandedPaths.has(item.path)}
                onPress={() => handleRowPress(item)}
                row={item}
                styles={styles}
                tokens={tokens}
              />
            </View>
          )}
        />
      )}
    </View>
  );
}

function EditorPanel({
  document,
  loading,
  onChange,
  onClose,
  onSave,
  styles,
  tokens,
}: {
  document: EditorDocument | null;
  loading: boolean;
  onChange: (content: string) => void;
  onClose: () => void;
  onSave: () => void;
  styles: ReturnType<typeof createStyles>;
  tokens: ThemeTokens;
}) {
  const fileName = document?.path.split("/").at(-1) ?? "Editor";
  return (
    <View style={styles.panel} testID="cesium-editor-panel">
      <View style={styles.editorTabs}>
        <View style={styles.editorTab}>
          <File color={tokens["--palette-icon-ts"]} size={13} strokeWidth={1.5} />
          <Text numberOfLines={1} style={styles.editorTabText}>
            {fileName}
            {document?.dirty ? " •" : ""}
          </Text>
          {document ? (
            <Pressable accessibilityLabel="Close file" hitSlop={8} onPress={onClose}>
              <X color={tokens["--text-secondary"]} size={13} />
            </Pressable>
          ) : null}
        </View>
        <View style={sharedStyles.toolbarSpacer} />
        {document?.dirty ? (
          <IconButton
            accessibilityLabel="Save file"
            Icon={Save}
            onPress={onSave}
            tokens={tokens}
            testID="save-file"
          />
        ) : null}
        <IconButton accessibilityLabel="Editor menu" Icon={MoreHorizontal} tokens={tokens} />
      </View>
      {loading ? (
        <LoadingScreen label="Opening file..." tokens={tokens} />
      ) : document ? (
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          onChangeText={onChange}
          scrollEnabled
          selectionColor={tokens["--accent"]}
          style={styles.editorInput}
          testID="native-code-editor"
          textAlignVertical="top"
          value={document.content}
        />
      ) : (
        <View style={sharedStyles.centered}>
          <Text style={styles.emptyTitle}>Open a file to start editing</Text>
          <Text style={styles.emptySubtitle}>
            Choose a file from the Files panel.
          </Text>
        </View>
      )}
    </View>
  );
}

function WorkedEntry({
  entry,
  styles,
  tokens,
}: {
  entry: WorkedSessionEntry;
  styles: ReturnType<typeof createStyles>;
  tokens: ThemeTokens;
}) {
  const title =
    entry.kind === "tool"
      ? entry.title
      : entry.kind === "explore"
        ? `Explored ${entry.paths.join(", ")}`
        : entry.kind === "compression"
          ? "Compressed context"
          : entry.text;
  return (
    <View style={styles.workedEntry}>
      {entry.kind === "tool" ? (
        <Wrench color={tokens["--text-disabled"]} size={11} strokeWidth={1.5} />
      ) : (
        <Circle
          color={tokens["--text-disabled"]}
          fill={tokens["--text-disabled"]}
          size={5}
        />
      )}
      <Text numberOfLines={3} style={styles.workedEntryText}>
        {title}
      </Text>
    </View>
  );
}

const NativeMessage = memo(function NativeMessage({
  message,
  onPermission,
  onQuestion,
  styles,
  tokens,
}: {
  message: ChatMessage;
  onPermission: (requestId: string, optionId: string) => void;
  onQuestion: (questionId: string, answer: string) => void;
  styles: ReturnType<typeof createStyles>;
  tokens: ThemeTokens;
}) {
  if (message.type === "user") {
    return (
      <View style={styles.userMessage} testID={`chat-message-${message.id}`}>
        <UserRound color={tokens["--text-secondary"]} size={14} strokeWidth={1.5} />
        <Text selectable style={styles.messageText}>
          {message.content ?? ""}
        </Text>
      </View>
    );
  }
  if (message.type === "assistant") {
    return (
      <View style={styles.assistantMessage} testID={`chat-message-${message.id}`}>
        <Bot color={tokens["--text-secondary"]} size={14} strokeWidth={1.5} />
        <Text selectable style={styles.messageText}>
          {message.content ?? ""}
        </Text>
      </View>
    );
  }
  if (message.type === "worked-session") {
    return (
      <View style={styles.workedCard}>
        <Text style={styles.workedTitle}>{message.workedLabel ?? "Worked"}</Text>
        {message.workedEntries?.slice(0, 8).map((entry, index) => (
          <WorkedEntry
            entry={entry}
            key={`${message.id}-${index}`}
            styles={styles}
            tokens={tokens}
          />
        ))}
      </View>
    );
  }
  if (message.type === "todo" || message.type === "todo-status" || message.type === "todo-update") {
    return (
      <View style={styles.workedCard}>
        <Text style={styles.workedTitle}>{message.todoLabel ?? "Plan"}</Text>
        {message.todos?.map((todo) => (
          <View key={todo.id} style={styles.todoRow}>
            {todo.status === "completed" ? (
              <Check color={tokens["--text-secondary"]} size={12} strokeWidth={2} />
            ) : (
              <Circle color={tokens["--text-disabled"]} size={9} />
            )}
            <Text style={styles.todoText}>{todo.text}</Text>
          </View>
        ))}
      </View>
    );
  }
  if (message.type === "permission-request") {
    return (
      <View style={styles.attentionCard}>
        <Text style={styles.attentionTitle}>
          {message.permissionTitle ?? "Permission required"}
        </Text>
        {message.permissionDetail ? (
          <Text style={styles.attentionDetail}>{message.permissionDetail}</Text>
        ) : null}
        {!message.permissionResolved
          ? message.permissionOptions?.map((option) => (
              <Pressable
                key={option.id}
                onPress={() =>
                  message.permissionRequestId
                    ? onPermission(message.permissionRequestId, option.id)
                    : undefined
                }
                style={styles.choiceButton}
              >
                <Text style={styles.choiceButtonText}>{option.label}</Text>
              </Pressable>
            ))
          : null}
      </View>
    );
  }
  if (message.type === "ask-question") {
    const questionId = message.id.replace(/^question-/, "");
    const step = message.questionSteps?.[0];
    return (
      <View style={styles.attentionCard}>
        <Text style={styles.attentionTitle}>
          {step?.title ?? message.questionTitle ?? "Question"}
        </Text>
        {(step?.options ?? message.options)?.map((option) => (
          <Pressable
            key={`${option.letter}-${option.text}`}
            onPress={() => onQuestion(questionId, option.text)}
            style={styles.choiceButton}
          >
            <Text style={styles.choiceLetter}>{option.letter}</Text>
            <Text style={styles.choiceButtonText}>{option.text}</Text>
          </Pressable>
        ))}
      </View>
    );
  }
  if (message.type === "subagent") {
    return (
      <View style={styles.workedCard}>
        <Text style={styles.workedTitle}>{message.subagentTitle ?? "Subagent"}</Text>
        <Text style={styles.attentionDetail}>
          {message.recentActivity ??
            (message.subagentStatus === "running" ? "Running" : "Completed")}
        </Text>
      </View>
    );
  }
  if (message.type === "turn-footer" && message.turnDurationMs != null) {
    return (
      <Text style={styles.metaText}>
        Completed in {Math.max(1, Math.round(message.turnDurationMs / 1000))}s
      </Text>
    );
  }
  if (message.type === "agent-handoff") {
    return (
      <Text style={styles.metaText}>
        Handoff: {message.handoffFromAgent} → {message.handoffToAgent}
      </Text>
    );
  }
  if (message.type === "chat-fork") {
    return <Text style={styles.metaText}>Forked from {message.forkFromAgent}</Text>;
  }
  return (
    <Text style={styles.metaText}>
      {message.activityLabel ?? message.shellTitle ?? message.content ?? ""}
    </Text>
  );
});

function Composer({
  backend,
  busy,
  conversation,
  onSubmit,
  styles,
  tokens,
}: {
  backend: AgentBackendInfo | null;
  busy: boolean;
  conversation: AgentConversationRecord | null;
  onSubmit: (text: string) => Promise<boolean>;
  styles: ReturnType<typeof createStyles>;
  tokens: ThemeTokens;
}) {
  const [text, setText] = useState("");
  const submit = useCallback(async () => {
    const next = text.trim();
    if (!next || busy) {
      return;
    }
    if (await onSubmit(next)) {
      setText("");
    }
  }, [busy, onSubmit, text]);
  return (
    <View style={styles.composer} testID="native-chat-composer">
      <TextInput
        accessibilityLabel="Agent prompt"
        multiline
        onChangeText={setText}
        onSubmitEditing={() => void submit()}
        placeholder="Ask anything, @ for files, / for commands"
        placeholderTextColor={tokens["--text-secondary"]}
        style={styles.composerInput}
        testID="native-chat-input"
        value={text}
      />
      <View style={styles.composerActions}>
        <Pressable accessibilityLabel="Attach context" hitSlop={8} style={styles.composerIcon}>
          <Paperclip color={tokens["--text-secondary"]} size={13} strokeWidth={1.5} />
        </Pressable>
        <Pressable accessibilityLabel="More context options" hitSlop={8} style={styles.composerIcon}>
          <InfinityIcon color={tokens["--text-secondary"]} size={14} strokeWidth={1.5} />
        </Pressable>
        <Pressable style={styles.modelButton}>
          <Bot color={tokens["--text-secondary"]} size={12} strokeWidth={1.5} />
          <Text numberOfLines={1} style={styles.modelText}>
            {formatModelLabel(conversation, backend)}
          </Text>
          <ChevronDown color={tokens["--text-secondary"]} size={10} strokeWidth={1.5} />
        </Pressable>
        <View style={sharedStyles.toolbarSpacer} />
        <Pressable
          accessibilityLabel="Send prompt"
          disabled={!text.trim() || busy}
          onPress={() => void submit()}
          style={[styles.sendButton, !text.trim() || busy ? styles.disabled : null]}
          testID="native-chat-send"
        >
          {busy ? (
            <ActivityIndicator color={tokens["--bg-main"]} size="small" />
          ) : (
            <Send color={tokens["--bg-main"]} size={12} strokeWidth={2} />
          )}
        </Pressable>
      </View>
    </View>
  );
}

function ChatPanel({
  backends,
  connectionState,
  conversations,
  feed,
  feedError,
  feedLoading,
  onNewConversation,
  onPermission,
  onQuestion,
  onRefresh,
  onSelectConversation,
  onSubmit,
  selectedConversationId,
  styles,
  tokens,
  workspaceRoot,
}: {
  backends: AgentBackendInfo[];
  connectionState?: NativeWorkbenchProps["connectionState"];
  conversations: AgentConversationRecord[];
  feed: ConversationFeedState;
  feedError: string | null;
  feedLoading: boolean;
  onNewConversation: () => void;
  onPermission: (requestId: string, optionId: string) => void;
  onQuestion: (questionId: string, answer: string) => void;
  onRefresh: () => void;
  onSelectConversation: (id: string) => void;
  onSubmit: (text: string) => Promise<boolean>;
  selectedConversationId: string | null;
  styles: ReturnType<typeof createStyles>;
  tokens: ThemeTokens;
  workspaceRoot: string;
}) {
  const selectedConversation =
    feed.conversation ??
    conversations.find((conversation) => conversation.id === selectedConversationId) ??
    null;
  const backend =
    backends.find((candidate) => candidate.id === selectedConversation?.config.backendId) ??
    backends.find((candidate) => candidate.available) ??
    backends[0] ??
    null;
  const messages = useMemo(
    () =>
      projectAgentEventsToChatMessages(feed.events, {
        backendId: selectedConversation?.config.backendId,
        workspaceRoot,
      }),
    [feed.events, selectedConversation?.config.backendId, workspaceRoot]
  );
  const status = formatStatus(selectedConversation?.status);

  return (
    <View style={styles.panel} testID="cesium-chat-panel">
      <View style={styles.chatTabs}>
        <ScrollView
          contentContainerStyle={styles.chatTabsContent}
          horizontal
          showsHorizontalScrollIndicator={false}
        >
          {conversations.slice(0, 12).map((conversation) => {
            const selected = conversation.id === selectedConversationId;
            return (
              <Pressable
                key={conversation.id}
                onPress={() => onSelectConversation(conversation.id)}
                style={[styles.chatTab, selected ? styles.activeChatTab : null]}
                testID={`conversation-tab-${conversation.id}`}
              >
                <Text numberOfLines={1} style={styles.chatTabText}>
                  {conversation.title || "Untitled"}
                </Text>
              </Pressable>
            );
          })}
          {!selectedConversationId ? (
            <View style={[styles.chatTab, styles.activeChatTab]}>
              <Text style={styles.chatTabText}>New chat</Text>
            </View>
          ) : null}
        </ScrollView>
        <IconButton
          accessibilityLabel="New chat"
          Icon={Plus}
          onPress={onNewConversation}
          tokens={tokens}
          testID="new-chat"
        />
        <IconButton accessibilityLabel="Chat menu" Icon={MoreHorizontal} tokens={tokens} />
      </View>
      {!selectedConversationId ? (
        <View style={styles.newChatStage}>
          <Composer
            backend={backend}
            busy={false}
            conversation={null}
            onSubmit={onSubmit}
            styles={styles}
            tokens={tokens}
          />
        </View>
      ) : (
        <>
          {feedLoading && messages.length === 0 ? (
            <LoadingScreen label="Loading conversation..." tokens={tokens} />
          ) : feedError && messages.length === 0 ? (
            <View style={sharedStyles.centered}>
              <Text style={styles.errorText}>{feedError}</Text>
              <Pressable onPress={onRefresh} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>Retry</Text>
              </Pressable>
            </View>
          ) : (
            <FlatList
              contentContainerStyle={styles.messageList}
              data={messages}
              keyExtractor={(message) => message.id}
              ListFooterComponent={
                status ? <Text style={styles.workingLabel}>{status}</Text> : null
              }
              renderItem={({ item }) => (
                <NativeMessage
                  message={item}
                  onPermission={onPermission}
                  onQuestion={onQuestion}
                  styles={styles}
                  tokens={tokens}
                />
              )}
            />
          )}
          <Composer
            backend={backend}
            busy={false}
            conversation={selectedConversation}
            onSubmit={onSubmit}
            styles={styles}
            tokens={tokens}
          />
          <View style={styles.composerMetaRow}>
            <Text numberOfLines={1} style={styles.composerMeta}>
              workspace · {workspaceRoot}
            </Text>
            {connectionState && connectionState !== "open" ? (
              <Text style={styles.composerMeta}>{connectionState}</Text>
            ) : null}
          </View>
        </>
      )}
    </View>
  );
}

function BottomNavigation({
  activePanel,
  onChange,
  styles,
}: {
  activePanel: NativeWorkbenchPanel;
  onChange: (panel: NativeWorkbenchPanel) => void;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View accessibilityRole="tablist" style={styles.bottomNavigation}>
      {PANEL_ITEMS.map((item) => (
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: activePanel === item.id }}
          key={item.id}
          onPress={() => onChange(item.id)}
          style={styles.bottomNavigationItem}
          testID={`nav-${item.id}`}
        >
          <Text
            style={[
              styles.bottomNavigationText,
              activePanel === item.id ? styles.bottomNavigationTextActive : null,
            ]}
          >
            {item.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function WorkbenchBody({
  connectionState,
  notificationConversationId,
  onFocusedConversationChange,
  onProjection,
  tokens,
}: NativeWorkbenchProps & { tokens: ThemeTokens }) {
  const {
    activeWorkspace,
    activeWorkspaceId,
    error: workspaceError,
    loading: workspaceLoading,
    refreshWorkspaces,
  } = useNativeWorkspace();
  const styles = useMemo(() => createStyles(tokens), [tokens]);
  const [activePanel, setActivePanel] = useState<NativeWorkbenchPanel>("chat");
  const [conversations, setConversations] = useState<AgentConversationRecord[]>([]);
  const [backends, setBackends] = useState<AgentBackendInfo[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [editorDocument, setEditorDocument] = useState<EditorDocument | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const initialConversationSelected = useRef(false);
  const previousProjection = useRef<MobileAgentProjection | null>(null);
  const {
    error: feedError,
    feed,
    loading: feedLoading,
    refresh: refreshFeed,
  } = useConversationFeed(activeWorkspaceId, selectedConversationId);

  const refreshConversations = useCallback(async () => {
    if (!activeWorkspaceId) {
      setConversations([]);
      setBackends([]);
      return;
    }
    setConversationsLoading(true);
    setConversationError(null);
    try {
      const result = await listAgentConversations({ limit: 60, cache: "no-store" });
      const ordered = [...result.conversations].sort(
        (left, right) => right.updatedAt - left.updatedAt
      );
      setConversations(ordered);
      setBackends(result.backends);
      if (!initialConversationSelected.current) {
        initialConversationSelected.current = true;
        setSelectedConversationId(
          notificationConversationId &&
            ordered.some((conversation) => conversation.id === notificationConversationId)
            ? notificationConversationId
            : ordered[0]?.id ?? null
        );
      } else {
        setSelectedConversationId((current) =>
          current && ordered.some((conversation) => conversation.id === current)
            ? current
            : current
        );
      }
    } catch (nextError) {
      setConversationError(
        nextError instanceof Error ? nextError.message : "Failed to load conversations."
      );
    } finally {
      setConversationsLoading(false);
    }
  }, [activeWorkspaceId, notificationConversationId]);

  useEffect(() => {
    initialConversationSelected.current = false;
    setSelectedConversationId(null);
    void refreshConversations();
  }, [activeWorkspaceId, refreshConversations]);

  useEffect(() => {
    if (
      notificationConversationId &&
      conversations.some((conversation) => conversation.id === notificationConversationId)
    ) {
      setSelectedConversationId(notificationConversationId);
      setActivePanel("chat");
    }
  }, [conversations, notificationConversationId]);

  useEffect(() => {
    onFocusedConversationChange?.(activeWorkspaceId, selectedConversationId);
  }, [activeWorkspaceId, onFocusedConversationChange, selectedConversationId]);

  useEffect(() => {
    if (!feed.conversation) {
      previousProjection.current = null;
      onProjection?.(null);
      return;
    }
    const projection = deriveMobileAgentProjection(feed.conversation, feed.events, {
      previous: previousProjection.current,
    });
    previousProjection.current = projection;
    onProjection?.(projection);
  }, [feed.conversation, feed.events, onProjection]);

  useEffect(() => {
    if (!feed.conversation) {
      return;
    }
    setConversations((current) => {
      const next = current.map((conversation) =>
        conversation.id === feed.conversation?.id ? feed.conversation : conversation
      );
      return next.sort((left, right) => right.updatedAt - left.updatedAt);
    });
  }, [feed.conversation]);

  const openFile = useCallback(async (path: string) => {
    setEditorLoading(true);
    setActivePanel("editor");
    try {
      const result = await readFile(path, { full: true });
      setEditorDocument({
        path,
        content: result.content,
        language: result.language,
        dirty: false,
      });
    } catch (nextError) {
      setEditorDocument({
        path,
        content:
          nextError instanceof Error ? `Unable to open file: ${nextError.message}` : "Unable to open file.",
        language: "text",
        dirty: false,
      });
    } finally {
      setEditorLoading(false);
    }
  }, []);

  const saveEditorDocument = useCallback(async () => {
    if (!editorDocument?.dirty) {
      return;
    }
    await writeFile(editorDocument.path, editorDocument.content);
    setEditorDocument((current) => (current ? { ...current, dirty: false } : current));
  }, [editorDocument]);

  const submitPrompt = useCallback(
    async (text: string): Promise<boolean> => {
      try {
        if (selectedConversationId) {
          const result = await promptAgentConversation(selectedConversationId, text);
          const conversation = result.snapshot.conversation;
          setConversations((current) =>
            current.map((item) => (item.id === conversation.id ? conversation : item))
          );
          refreshFeed();
          return true;
        }
        const backend =
          backends.find((candidate) => candidate.available) ?? backends[0] ?? null;
        if (!backend) {
          setConversationError("No agent backend is configured.");
          return false;
        }
        const result = await createAndPromptAgentConversation(
          {
            backendId: backend.id,
            mode: backend.defaultMode,
            modelId: backend.defaultModelId,
            modelName: backend.defaultModelName,
          },
          text
        );
        const conversation = result.snapshot.conversation;
        setConversations((current) => [
          conversation,
          ...current.filter((item) => item.id !== conversation.id),
        ]);
        setSelectedConversationId(conversation.id);
        return true;
      } catch (nextError) {
        setConversationError(
          nextError instanceof Error ? nextError.message : "Failed to send the prompt."
        );
        return false;
      }
    },
    [backends, refreshFeed, selectedConversationId]
  );

  const answerPermission = useCallback(
    (requestId: string, optionId: string) => {
      if (!selectedConversationId) {
        return;
      }
      void answerAgentPermission(selectedConversationId, { requestId, optionId }).then(
        refreshFeed
      );
    },
    [refreshFeed, selectedConversationId]
  );

  const answerQuestion = useCallback(
    (questionId: string, answer: string) => {
      if (!selectedConversationId) {
        return;
      }
      void answerAgentQuestion(selectedConversationId, { questionId, answer }).then(
        refreshFeed
      );
    },
    [refreshFeed, selectedConversationId]
  );

  if (workspaceLoading && !activeWorkspace) {
    return <LoadingScreen label="Loading workspace..." tokens={tokens} />;
  }
  if (workspaceError && !activeWorkspace) {
    return (
      <View style={[sharedStyles.centered, { backgroundColor: tokens["--bg-main"] }]}>
        <AlertCircle color={tokens["--text-secondary"]} size={20} />
        <Text style={styles.errorText}>{workspaceError}</Text>
        <Pressable onPress={() => void refreshWorkspaces()} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.workbench}>
      <View style={styles.panelStage}>
        {activePanel === "files" ? (
          <FilesPanel
            activeDocumentPath={editorDocument?.path ?? null}
            onOpenFile={openFile}
            styles={styles}
            tokens={tokens}
            workspaceName={activeWorkspace?.name ?? "Workspace"}
          />
        ) : null}
        {activePanel === "editor" ? (
          <EditorPanel
            document={editorDocument}
            loading={editorLoading}
            onChange={(content) =>
              setEditorDocument((current) =>
                current ? { ...current, content, dirty: true } : current
              )
            }
            onClose={() => setEditorDocument(null)}
            onSave={() => void saveEditorDocument()}
            styles={styles}
            tokens={tokens}
          />
        ) : null}
        {activePanel === "chat" ? (
          conversationsLoading && conversations.length === 0 ? (
            <LoadingScreen label="Loading chats..." tokens={tokens} />
          ) : (
            <ChatPanel
              backends={backends}
              connectionState={connectionState}
              conversations={conversations}
              feed={feed}
              feedError={feedError ?? conversationError}
              feedLoading={feedLoading}
              onNewConversation={() => setSelectedConversationId(null)}
              onPermission={answerPermission}
              onQuestion={answerQuestion}
              onRefresh={() => {
                refreshFeed();
                void refreshConversations();
              }}
              onSelectConversation={setSelectedConversationId}
              onSubmit={submitPrompt}
              selectedConversationId={selectedConversationId}
              styles={styles}
              tokens={tokens}
              workspaceRoot={activeWorkspace?.root ?? ""}
            />
          )
        ) : null}
      </View>
      <BottomNavigation activePanel={activePanel} onChange={setActivePanel} styles={styles} />
    </View>
  );
}

export function NativeWorkbench(props: NativeWorkbenchProps) {
  const tokens = useThemeTokens();
  const auth = useNativeAuth();
  if (!auth.ready) {
    return <LoadingScreen label="Connecting to Cesium..." tokens={tokens} />;
  }
  if (auth.enabled && !auth.authenticated) {
    return <LoginScreen tokens={tokens} />;
  }
  return <WorkbenchBody {...props} tokens={tokens} />;
}

const sharedStyles = StyleSheet.create({
  centered: {
    alignItems: "center",
    flex: 1,
    gap: 9,
    justifyContent: "center",
    padding: 24,
  },
  composerIcon: {
    alignItems: "center",
    height: 22,
    justifyContent: "center",
    width: 22,
  },
  fileIndent: {
    width: 11,
  },
  iconButton: {
    alignItems: "center",
    borderRadius: 5,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  loadingLabel: {
    fontFamily: "sans-serif",
    fontSize: 13,
  },
  toolbarSpacer: {
    flex: 1,
  },
});

function createStyles(tokens: ThemeTokens) {
  const cardRadius = tokenNumber(tokens["--radius-card"], 10);
  const tabRadius = tokenNumber(tokens["--radius-tab"], 5);
  const bodyText: TextStyle = {
    color: tokens["--text-primary"],
    fontFamily: "sans-serif",
    fontSize: tokenNumber(tokens["--font-size-body"], 14),
  };
  const card: ViewStyle = {
    backgroundColor: tokens["--bg-card"],
    borderColor: tokens["--border-card"],
    borderRadius: cardRadius,
    borderWidth: StyleSheet.hairlineWidth,
  };
  return StyleSheet.create({
    activeChatTab: {
      backgroundColor: tokens["--bg-main"],
    },
    assistantMessage: {
      alignItems: "flex-start",
      flexDirection: "row",
      gap: 8,
      paddingHorizontal: 4,
      paddingVertical: 7,
    },
    attentionCard: {
      ...card,
      backgroundColor: tokens["--plan-accent-bg"],
      gap: 7,
      padding: 10,
    },
    attentionDetail: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif",
      fontSize: 12,
      lineHeight: 17,
    },
    attentionTitle: {
      ...bodyText,
      fontSize: 13,
      fontWeight: "600",
    },
    bottomNavigation: {
      alignItems: "stretch",
      backgroundColor: tokens["--bg-panel"],
      borderTopColor: tokens["--border-subtle"],
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      height: 44,
    },
    bottomNavigationItem: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
    },
    bottomNavigationText: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif",
      fontSize: 12,
    },
    bottomNavigationTextActive: {
      color: tokens["--accent"],
      fontWeight: "500",
    },
    chatTab: {
      alignItems: "center",
      height: 40,
      justifyContent: "center",
      maxWidth: 150,
      minWidth: 94,
      paddingHorizontal: 10,
    },
    chatTabText: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif",
      fontSize: 12,
    },
    chatTabs: {
      alignItems: "center",
      backgroundColor: tokens["--bg-panel"],
      borderBottomColor: tokens["--border-subtle"],
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      minHeight: 40,
    },
    chatTabsContent: {
      alignItems: "center",
    },
    choiceButton: {
      alignItems: "center",
      backgroundColor: tokens["--bg-main"],
      borderColor: tokens["--border-card"],
      borderRadius: tabRadius,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 8,
      minHeight: 34,
      paddingHorizontal: 9,
      paddingVertical: 7,
    },
    choiceButtonText: {
      color: tokens["--text-primary"],
      flex: 1,
      fontFamily: "sans-serif",
      fontSize: 12,
    },
    choiceLetter: {
      color: tokens["--text-secondary"],
      fontFamily: "monospace",
      fontSize: 11,
      fontWeight: "600",
    },
    composer: {
      ...card,
      gap: 7,
      marginHorizontal: 1,
      padding: 9,
    },
    composerActions: {
      alignItems: "center",
      flexDirection: "row",
      minHeight: 23,
    },
    composerIcon: sharedStyles.composerIcon,
    composerInput: {
      ...bodyText,
      lineHeight: 19,
      maxHeight: 126,
      minHeight: 38,
      padding: 0,
    },
    composerMeta: {
      color: tokens["--text-disabled"],
      flexShrink: 1,
      fontFamily: "sans-serif",
      fontSize: 9.5,
    },
    composerMetaRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      minHeight: 24,
      paddingHorizontal: 8,
    },
    disabled: {
      opacity: 0.42,
    },
    editorInput: {
      ...bodyText,
      backgroundColor: tokens["--bg-main"],
      flex: 1,
      fontFamily: "monospace",
      fontSize: 12,
      lineHeight: 18,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    editorTab: {
      alignItems: "center",
      alignSelf: "stretch",
      backgroundColor: tokens["--bg-main"],
      borderRightColor: tokens["--border-subtle"],
      borderRightWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 6,
      maxWidth: 210,
      minWidth: 118,
      paddingHorizontal: 10,
    },
    editorTabText: {
      color: tokens["--text-primary"],
      flex: 1,
      fontFamily: "sans-serif",
      fontSize: 11.5,
    },
    editorTabs: {
      alignItems: "center",
      backgroundColor: tokens["--bg-panel"],
      borderBottomColor: tokens["--border-subtle"],
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      height: 40,
    },
    emptySubtitle: {
      color: tokens["--text-disabled"],
      fontFamily: "sans-serif",
      fontSize: 12,
      textAlign: "center",
    },
    emptyTitle: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif",
      fontSize: 14,
    },
    errorText: {
      color: tokens["--debug-accent"],
      fontFamily: "sans-serif",
      fontSize: 12,
      lineHeight: 17,
      textAlign: "center",
    },
    explorerTitle: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif",
      fontSize: 12.5,
      fontWeight: "500",
      paddingBottom: 5,
      paddingHorizontal: 9,
    },
    explorerToolbar: {
      alignItems: "center",
      flexDirection: "row",
      minHeight: 34,
      paddingHorizontal: 4,
      paddingTop: 4,
    },
    fileList: {
      paddingBottom: 8,
      paddingHorizontal: 4,
    },
    fileName: {
      color: tokens["--text-primary"],
      flex: 1,
      fontFamily: "sans-serif",
      fontSize: 12,
    },
    fileRow: {
      alignItems: "center",
      borderRadius: tabRadius,
      flexDirection: "row",
      gap: 4,
      height: 24,
      paddingRight: 7,
    },
    fileRowPressed: {
      backgroundColor: tokens["--bg-card"],
    },
    loginCard: {
      ...card,
      gap: 10,
      maxWidth: 380,
      padding: 18,
      width: "100%",
    },
    loginInput: {
      ...bodyText,
      backgroundColor: tokens["--bg-main"],
      borderColor: tokens["--border-card"],
      borderRadius: tabRadius,
      borderWidth: StyleSheet.hairlineWidth,
      height: 42,
      paddingHorizontal: 11,
    },
    loginScreen: {
      alignItems: "center",
      backgroundColor: tokens["--bg-main"],
      flex: 1,
      justifyContent: "center",
      padding: 20,
    },
    loginSubtitle: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif",
      fontSize: 13,
      marginBottom: 4,
      textAlign: "center",
    },
    loginTitle: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif",
      fontSize: 24,
      fontWeight: "600",
      textAlign: "center",
    },
    messageList: {
      gap: 8,
      paddingBottom: 12,
      paddingHorizontal: 8,
      paddingTop: 10,
    },
    messageText: {
      ...bodyText,
      flex: 1,
      lineHeight: 20,
    },
    metaText: {
      color: tokens["--text-disabled"],
      fontFamily: "sans-serif",
      fontSize: 10.5,
      paddingHorizontal: 5,
      paddingVertical: 3,
    },
    modelButton: {
      alignItems: "center",
      flexDirection: "row",
      gap: 4,
      marginLeft: 2,
      maxWidth: 180,
      paddingHorizontal: 3,
    },
    modelText: {
      color: tokens["--text-secondary"],
      flexShrink: 1,
      fontFamily: "sans-serif",
      fontSize: 10.5,
    },
    newChatStage: {
      flex: 1,
    },
    panel: {
      backgroundColor: tokens["--bg-main"],
      flex: 1,
      minHeight: 0,
    },
    panelStage: {
      flex: 1,
      minHeight: 0,
    },
    pressed: {
      opacity: 0.78,
    },
    primaryButton: {
      alignItems: "center",
      backgroundColor: tokens["--accent"],
      borderRadius: tabRadius,
      height: 42,
      justifyContent: "center",
    },
    primaryButtonText: {
      color: tokens["--bg-main"],
      fontFamily: "sans-serif",
      fontSize: 13,
      fontWeight: "600",
    },
    secondaryButton: {
      borderColor: tokens["--border-card"],
      borderRadius: tabRadius,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 12,
      paddingVertical: 7,
    },
    secondaryButtonText: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif",
      fontSize: 12,
    },
    selectedFileRow: {
      backgroundColor: tokens["--bg-card"],
      borderRadius: tabRadius,
    },
    sendButton: {
      alignItems: "center",
      backgroundColor: tokens["--accent"],
      borderRadius: 12,
      height: 23,
      justifyContent: "center",
      width: 23,
    },
    todoRow: {
      alignItems: "flex-start",
      flexDirection: "row",
      gap: 6,
    },
    todoText: {
      color: tokens["--text-secondary"],
      flex: 1,
      fontFamily: "sans-serif",
      fontSize: 11.5,
      lineHeight: 16,
    },
    userMessage: {
      ...card,
      alignItems: "flex-start",
      flexDirection: "row",
      gap: 8,
      padding: 10,
    },
    workbench: {
      backgroundColor: tokens["--bg-main"],
      flex: 1,
    },
    workedCard: {
      ...card,
      backgroundColor: `${tokens["--bg-card"]}`,
      gap: 5,
      padding: 9,
    },
    workedEntry: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
      minHeight: 18,
    },
    workedEntryText: {
      color: tokens["--text-secondary"],
      flex: 1,
      fontFamily: "sans-serif",
      fontSize: 11,
      lineHeight: 15,
    },
    workedTitle: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif",
      fontSize: 11.5,
      fontWeight: "500",
    },
    workingLabel: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif",
      fontSize: 12,
      paddingHorizontal: 5,
      paddingTop: 3,
    },
  });
}
