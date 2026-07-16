import {
  ActivityIndicator,
  FlatList,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type ColorValue,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import {
  AlertCircle,
  ArrowUp,
  Boxes,
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  File,
  Flame,
  Folder,
  FolderOpen,
  GitBranch,
  Globe2,
  House,
  Laptop,
  ListChecks,
  ListFilter,
  Maximize2,
  Menu,
  MessageCircleQuestion,
  Mic,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Square,
  Workflow,
  Wrench,
  X,
} from "lucide-react-native";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import type {
  AgentBackendInfo,
  AgentConversationRecord,
  AgentSocketServerMessage,
  ChatMessage,
  FileNode,
  MobileAgentProjection,
  WorkedSessionEntry,
  WorkspaceRecord,
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
  fetchWorkspaceGitStatus,
  listAgentConversations,
  promptAgentConversation,
  readFile,
  writeFile,
} from "@cesium/client";
import { useServerConnections } from "@cesium/client/react";
import {
  DESIGN_2_MODE_RECIPES,
  DESIGN_2_RECIPES,
  resolveDesign2ComposerLayout,
  resolveDesign2ModeTone,
  type Design2ModeTone,
  type Design2ThemeTokens as ThemeTokens,
} from "@cesium/design";
import { useThemeTokens } from "./theme";
import { useNativeAuth } from "./providers/NativeAuthProvider";
import { useNativeWorkspace } from "./providers/NativeWorkspaceProvider";
import {
  flattenVisibleFileTree,
  reduceConversationFeed,
  type ConversationFeedState,
  type VisibleFileRow,
} from "./workbench-state";

export type NativeWorkbenchPanel = "center" | "rail" | "workbench";

export type NativeWorkbenchProps = {
  connectionState?: "idle" | "connecting" | "open" | "closed" | "reconnecting";
  notificationConversationId?: string | null;
  onFocusedConversationChange?: (
    workspaceId: string | null,
    conversationId: string | null
  ) => void;
  onProjection?: (projection: MobileAgentProjection | null) => void;
  onServerBaseUrlChange?: (baseUrl: string) => void;
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

function tokenNumber(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const MODE_ICONS: Record<Design2ModeTone, IconComponent> = {
  agent: Workflow,
  plan: ListChecks,
  debug: Bug,
  ask: MessageCircleQuestion,
  burn: Flame,
  workflow: Workflow,
  orchestration: Boxes,
};

function modeToken(
  tokens: ThemeTokens,
  token: string
): string {
  return tokens[token as keyof ThemeTokens] ?? tokens["--text-primary"];
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
  compact = false,
  Icon,
  onPress,
  surface = false,
  tokens,
  testID,
}: {
  accessibilityLabel: string;
  compact?: boolean;
  Icon: IconComponent;
  onPress?: () => void;
  surface?: boolean;
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
        compact ? sharedStyles.compactIconButton : sharedStyles.iconButton,
        surface ? { backgroundColor: tokens["--bg-panel"] } : null,
        pressed ? { backgroundColor: tokens["--accent-bg"] } : null,
      ]}
      testID={testID}
    >
      <Icon
        color={tokens["--text-secondary"]}
        size={DESIGN_2_RECIPES.rail.toolbarIconSize}
        strokeWidth={1.5}
      />
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
        <IconButton accessibilityLabel="Explorer menu" compact Icon={Menu} tokens={tokens} />
        <IconButton
          accessibilityLabel="Refresh files"
          compact
          Icon={RefreshCw}
          onPress={() => setRefreshKey((current) => current + 1)}
          tokens={tokens}
          testID="refresh-files"
        />
        <IconButton accessibilityLabel="Search files" compact Icon={Search} tokens={tokens} />
        <IconButton accessibilityLabel="Maximize explorer" compact Icon={Maximize2} tokens={tokens} />
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
  onClosePane,
  onOpenFiles,
  onSave,
  styles,
  tokens,
}: {
  document: EditorDocument | null;
  loading: boolean;
  onChange: (content: string) => void;
  onClose: () => void;
  onClosePane: () => void;
  onOpenFiles: () => void;
  onSave: () => void;
  styles: ReturnType<typeof createStyles>;
  tokens: ThemeTokens;
}) {
  const fileName = document?.path.split("/").at(-1) ?? "Editor";
  const [initialSelection, setInitialSelection] = useState<
    { start: number; end: number } | undefined
  >(document ? { start: 0, end: 0 } : undefined);
  const editorScrollRef = useRef<ScrollView>(null);
  const shouldScrollToTop = useRef(Boolean(document));

  useEffect(() => {
    setInitialSelection(document ? { start: 0, end: 0 } : undefined);
    shouldScrollToTop.current = Boolean(document);
  }, [document?.path]);

  useEffect(() => {
    if (!document) {
      return;
    }
    const scrollToTop = () => editorScrollRef.current?.scrollTo({ animated: false, y: 0 });
    const timers = [0, 120, 500].map((delay) => setTimeout(scrollToTop, delay));
    return () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [document?.path]);

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
        <IconButton
          accessibilityLabel="Open workspace file"
          compact
          Icon={FolderOpen}
          onPress={onOpenFiles}
          tokens={tokens}
          testID="open-workbench-file-picker"
        />
        {document?.dirty ? (
          <IconButton
            accessibilityLabel="Save file"
            compact
            Icon={Save}
            onPress={onSave}
            tokens={tokens}
            testID="save-file"
          />
        ) : null}
        <IconButton accessibilityLabel="Editor menu" compact Icon={MoreHorizontal} tokens={tokens} />
        <IconButton
          accessibilityLabel="Hide workbench pane"
          compact
          Icon={PanelRightClose}
          onPress={onClosePane}
          tokens={tokens}
          testID="close-workbench-pane"
        />
      </View>
      {loading ? (
        <LoadingScreen label="Opening file..." tokens={tokens} />
      ) : document ? (
        <ScrollView
          contentContainerStyle={styles.editorScrollContent}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => {
            if (shouldScrollToTop.current) {
              shouldScrollToTop.current = false;
              editorScrollRef.current?.scrollTo({ animated: false, y: 0 });
            }
          }}
          ref={editorScrollRef}
        >
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            onChangeText={onChange}
            onTouchStart={() => setInitialSelection(undefined)}
            scrollEnabled={false}
            selection={initialSelection}
            selectionColor={tokens["--accent"]}
            style={styles.editorInput}
            testID="native-code-editor"
            textAlignVertical="top"
            value={document.content}
          />
        </ScrollView>
      ) : (
        <View style={sharedStyles.centered}>
          <Text style={styles.emptyTitle}>No files open</Text>
          <Text style={styles.emptySubtitle}>
            Open a workspace file to start editing.
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
        <Text selectable style={styles.messageText}>
          {message.content ?? ""}
        </Text>
      </View>
    );
  }
  if (message.type === "assistant") {
    return (
      <View style={styles.assistantMessage} testID={`chat-message-${message.id}`}>
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
  mode,
  onSubmit,
  styles,
  tokens,
}: {
  backend: AgentBackendInfo | null;
  busy: boolean;
  conversation: AgentConversationRecord | null;
  mode: string;
  onSubmit: (text: string) => Promise<boolean>;
  styles: ReturnType<typeof createStyles>;
  tokens: ThemeTokens;
}) {
  const [text, setText] = useState("");
  const [measuredMultiline, setMeasuredMultiline] = useState(false);
  const [multilineLatch, setMultilineLatch] = useState(false);
  const layout = resolveDesign2ComposerLayout({
    measuredMultiline,
    latchedMultiline: multilineLatch,
    hasAttachments: false,
    value: text,
  });
  const tone = resolveDesign2ModeTone(mode);
  const modeRecipe = DESIGN_2_MODE_RECIPES[tone];
  const ModeIcon = MODE_ICONS[tone];
  const canSubmit = text.trim().length > 0;

  useEffect(() => {
    if (!text) {
      setMeasuredMultiline(false);
      setMultilineLatch(false);
      return;
    }
    if (measuredMultiline) {
      setMultilineLatch(true);
    }
  }, [measuredMultiline, text]);

  const submit = useCallback(async () => {
    const next = text.trim();
    if (!next || busy) {
      return;
    }
    if (await onSubmit(next)) {
      setText("");
    }
  }, [busy, onSubmit, text]);

  const plusButton = (
    <Pressable
      accessibilityLabel="Attach media"
      hitSlop={6}
      style={styles.composerPlusButton}
    >
      <Plus
        color={tokens["--agent-plus-button-icon"]}
        size={DESIGN_2_RECIPES.composer.plusIconSize}
        strokeWidth={2}
      />
    </Pressable>
  );
  const modeChip = !modeRecipe.hiddenWhenDefault ? (
    <View
      style={[
        styles.composerModeChip,
        { backgroundColor: modeToken(tokens, modeRecipe.backgroundToken) },
      ]}
    >
      <ModeIcon
        color={modeToken(tokens, modeRecipe.textToken)}
        size={13}
        strokeWidth={1.5}
      />
      <Text
        style={[
          styles.composerModeChipText,
          { color: modeToken(tokens, modeRecipe.textToken) },
        ]}
      >
        {modeRecipe.label}
      </Text>
      <X color={modeToken(tokens, modeRecipe.textToken)} size={9} strokeWidth={2} />
    </View>
  ) : null;
  const leadingControls = (
    <View style={styles.composerLeadingControls}>
      {plusButton}
      {modeChip}
    </View>
  );
  const modelPill = (
    <Pressable style={styles.modelButton}>
      <Text numberOfLines={1} style={styles.modelText}>
        {formatModelLabel(conversation, backend)}
      </Text>
      <ChevronDown color={tokens["--text-secondary"]} size={10} strokeWidth={1.5} />
    </Pressable>
  );
  const primaryControl = (
    <Pressable
      accessibilityLabel={busy ? "Stop" : canSubmit ? "Send" : "Voice input"}
      onPress={canSubmit && !busy ? () => void submit() : undefined}
      style={[
        styles.sendButton,
        { backgroundColor: modeToken(tokens, modeRecipe.sendToken) },
      ]}
      testID="native-chat-send"
    >
      {busy ? (
        <Square color={tokens["--bg-main"]} fill="currentColor" size={9} strokeWidth={2.2} />
      ) : canSubmit ? (
        <ArrowUp
          color={tokens["--bg-main"]}
          size={DESIGN_2_RECIPES.composer.sendIconSize}
          strokeWidth={DESIGN_2_RECIPES.composer.sendIconStrokeWidth}
        />
      ) : (
        <Mic color={tokens["--bg-main"]} size={13} strokeWidth={1.5} />
      )}
    </Pressable>
  );
  const editor = (
    <TextInput
      accessibilityLabel="Agent prompt"
      multiline
      onChangeText={setText}
      onContentSizeChange={(event) => {
        setMeasuredMultiline(
          event.nativeEvent.contentSize.height >
            DESIGN_2_RECIPES.composer.multilineThreshold
        );
      }}
      onSubmitEditing={() => void submit()}
      numberOfLines={layout.multiline ? 4 : 1}
      placeholder={
        layout.multiline
          ? DESIGN_2_RECIPES.composer.placeholder
          : modeRecipe.hiddenWhenDefault
            ? DESIGN_2_RECIPES.composer.compactPlaceholder
            : DESIGN_2_RECIPES.composer.modePlaceholder
      }
      placeholderTextColor={tokens["--text-secondary"]}
      scrollEnabled={layout.multiline}
      style={[
        styles.composerInput,
        layout.multiline ? styles.composerInputMultiline : styles.composerInputSingle,
      ]}
      testID="native-chat-input"
      value={text}
    />
  );

  return (
    <View
      style={[styles.composer, { borderRadius: layout.radius }]}
      testID="native-chat-composer"
    >
      {layout.multiline ? (
        <>
          {editor}
          <View style={styles.composerActions}>
            {leadingControls}
            <View style={sharedStyles.toolbarSpacer} />
            {modelPill}
            {primaryControl}
          </View>
        </>
      ) : (
        <View style={styles.composerSingleRow}>
          {leadingControls}
          {editor}
          {modelPill}
          {primaryControl}
        </View>
      )}
    </View>
  );
}

function ChatPanel({
  backends,
  connectionState,
  feed,
  feedError,
  feedLoading,
  onOpenWorkbench,
  onPermission,
  onQuestion,
  onRefresh,
  onSubmit,
  selectedConversationId,
  styles,
  tokens,
  workspaceBranch,
  workspaceName,
  workspaceRoot,
}: {
  backends: AgentBackendInfo[];
  connectionState?: NativeWorkbenchProps["connectionState"];
  feed: ConversationFeedState;
  feedError: string | null;
  feedLoading: boolean;
  onOpenWorkbench: () => void;
  onPermission: (requestId: string, optionId: string) => void;
  onQuestion: (questionId: string, answer: string) => void;
  onRefresh: () => void;
  onSubmit: (text: string, mode?: string) => Promise<boolean>;
  selectedConversationId: string | null;
  styles: ReturnType<typeof createStyles>;
  tokens: ThemeTokens;
  workspaceBranch: string | null;
  workspaceName: string;
  workspaceRoot: string;
}) {
  const [draftMode, setDraftMode] = useState("agent");
  const selectedConversation = selectedConversationId
    ? feed.conversation?.id === selectedConversationId
      ? feed.conversation
      : null
    : null;
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
      {!selectedConversationId ? (
        <View style={styles.newChatStage}>
          <View style={styles.newChatContent}>
            <View style={styles.workspaceContextRow}>
              <Pressable style={styles.workspaceContextPill}>
                <Folder color={tokens["--file-tag-icon"]} size={13} strokeWidth={1.5} />
                <Text numberOfLines={1} style={styles.workspaceContextText}>
                  {workspaceName}
                </Text>
                <ChevronDown color={tokens["--text-secondary"]} size={11} strokeWidth={1.5} />
              </Pressable>
              <Pressable style={styles.workspaceContextPill}>
                <GitBranch color={tokens["--text-disabled"]} size={12} strokeWidth={1.5} />
                <Text numberOfLines={1} style={styles.workspaceRootText}>
                  {workspaceBranch ?? workspaceRoot.split("/").filter(Boolean).at(-1) ?? workspaceRoot}
                </Text>
                <ChevronDown color={tokens["--text-secondary"]} size={11} strokeWidth={1.5} />
              </Pressable>
              <Pressable style={styles.workspaceTargetPill}>
                <Laptop color={tokens["--text-secondary"]} size={13} strokeWidth={1.5} />
                <ChevronDown color={tokens["--text-secondary"]} size={11} strokeWidth={1.5} />
              </Pressable>
            </View>
            <Composer
              backend={backend}
              busy={false}
              conversation={null}
              mode={draftMode}
              onSubmit={(text) => onSubmit(text, draftMode)}
              styles={styles}
              tokens={tokens}
            />
            {feedError ? <Text style={styles.landingError}>{feedError}</Text> : null}
            <View style={styles.quickActions}>
              <Pressable
                onPress={() => setDraftMode("plan")}
                style={styles.quickActionButton}
              >
                <Text style={styles.quickActionText}>Plan new idea (Ctrl+I)</Text>
              </Pressable>
              <Pressable
                onPress={onOpenWorkbench}
                style={styles.quickActionButton}
                testID="open-editor-panel"
              >
                <Text style={styles.quickActionText}>Open editor panel</Text>
              </Pressable>
            </View>
          </View>
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
            mode={selectedConversation?.config.mode ?? "agent"}
            onSubmit={(text) =>
              onSubmit(text, selectedConversation?.config.mode)
            }
            styles={styles}
            tokens={tokens}
          />
          <View style={styles.composerMetaRow}>
            <Text style={styles.composerMeta}>workspace</Text>
            <Text numberOfLines={1} style={styles.composerBranchMeta}>
              {workspaceBranch ?? workspaceRoot.split("/").filter(Boolean).at(-1) ?? workspaceRoot}
            </Text>
            <View style={sharedStyles.toolbarSpacer} />
            <Text numberOfLines={1} style={styles.composerMeta}>
              {backend?.label ?? ""}
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

function AgentRail({
  activeWorkspaceId,
  branchLabel,
  conversations,
  onClose,
  onNewConversation,
  onOpenServerSetup,
  onSelectConversation,
  onSelectWorkspace,
  serverLabel,
  selectedConversationId,
  styles,
  tokens,
  workspaces,
}: {
  activeWorkspaceId: string | null;
  branchLabel: string | null;
  conversations: AgentConversationRecord[];
  onClose: () => void;
  onNewConversation: () => void;
  onOpenServerSetup: () => void;
  onSelectConversation: (conversationId: string) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  serverLabel: string;
  selectedConversationId: string | null;
  styles: ReturnType<typeof createStyles>;
  tokens: ThemeTokens;
  workspaces: WorkspaceRecord[];
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const visibleConversations = normalizedQuery
    ? conversations.filter((conversation) =>
        conversation.title.toLowerCase().includes(normalizedQuery)
      )
    : conversations;
  const orderedWorkspaces = [...workspaces].sort((left, right) => {
    if (left.id === activeWorkspaceId) return -1;
    if (right.id === activeWorkspaceId) return 1;
    return left.name.localeCompare(right.name);
  });

  return (
    <View style={styles.agentRail} testID="agent-workspace-rail">
      <View style={styles.railTopBar}>
        <IconButton
          accessibilityLabel="Hide workspace rail"
          compact
          Icon={PanelLeftClose}
          onPress={onClose}
          tokens={tokens}
          testID="close-agent-rail"
        />
        <IconButton
          accessibilityLabel="Search all chats"
          compact
          Icon={Search}
          onPress={() => setSearchOpen((open) => !open)}
          tokens={tokens}
          testID="search-agent-chats"
        />
        <View style={sharedStyles.toolbarSpacer} />
        <IconButton
          accessibilityLabel="Start new chat"
          compact
          Icon={Plus}
          onPress={onNewConversation}
          tokens={tokens}
          testID="rail-new-chat"
        />
      </View>
      {searchOpen ? (
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder="Search conversations..."
          placeholderTextColor={tokens["--text-disabled"]}
          style={styles.railSearchInput}
          testID="agent-rail-search-input"
          value={query}
        />
      ) : null}
      <ScrollView contentContainerStyle={styles.railList}>
        {orderedWorkspaces.map((workspace) => {
          const active = workspace.id === activeWorkspaceId;
          return (
            <View key={workspace.id} style={styles.railWorkspaceSection}>
              <Pressable
                onPress={() => onSelectWorkspace(workspace.id)}
                style={styles.railWorkspaceHeader}
                testID={`workspace-row-${workspace.id}`}
              >
                {workspace.name.toLowerCase() === "home" ? (
                  <House
                    color={tokens["--debug-accent"]}
                    size={11}
                    strokeWidth={1.7}
                  />
                ) : (
                  <Folder
                    color={active ? tokens["--file-tag-icon"] : tokens["--text-disabled"]}
                    size={11}
                    strokeWidth={1.7}
                  />
                )}
                <Text
                  numberOfLines={1}
                  style={[
                    styles.railWorkspaceLabel,
                    active ? styles.railWorkspaceLabelActive : null,
                  ]}
                >
                  {workspace.name}
                </Text>
                {active && branchLabel ? (
                  <Text numberOfLines={1} style={styles.railBranchLabel}>
                    {branchLabel}
                  </Text>
                ) : null}
              </Pressable>
              {active ? (
                visibleConversations.length > 0 ? (
                  visibleConversations.map((conversation) => {
                    const selected = conversation.id === selectedConversationId;
                    return (
                      <Pressable
                        key={conversation.id}
                        onPress={() => onSelectConversation(conversation.id)}
                        style={[
                          styles.railConversationRow,
                          selected ? styles.railConversationRowSelected : null,
                        ]}
                        testID={`rail-conversation-${conversation.id}`}
                      >
                        <Circle
                          color={
                            selected
                              ? tokens["--text-primary"]
                              : conversation.status === "running"
                                ? tokens["--ask-accent"]
                                : tokens["--text-disabled"]
                          }
                          fill={
                            selected
                              ? tokens["--text-primary"]
                              : conversation.status === "running"
                                ? tokens["--ask-accent"]
                                : tokens["--text-disabled"]
                          }
                          size={5}
                          strokeWidth={1.5}
                        />
                        <Text numberOfLines={1} style={styles.railConversationTitle}>
                          {conversation.title || "Untitled"}
                        </Text>
                      </Pressable>
                    );
                  })
                ) : (
                  <Text style={styles.railEmptyText}>
                    {normalizedQuery ? "No matching conversations" : "No conversations yet"}
                  </Text>
                )
              ) : null}
            </View>
          );
        })}
      </ScrollView>
      <View style={styles.railFooter}>
        <Globe2 color={tokens["--text-secondary"]} size={17} strokeWidth={1.5} />
        <Text numberOfLines={1} style={styles.railFooterLabel}>
          {serverLabel}
        </Text>
        <View style={styles.railFooterIconButton}>
          <ChevronDown color={tokens["--text-secondary"]} size={12} strokeWidth={1.5} />
        </View>
        <View style={styles.railFooterIconButton}>
          <ListFilter color={tokens["--text-secondary"]} size={15} strokeWidth={1.5} />
        </View>
        <Pressable
          accessibilityLabel="Open server setup"
          hitSlop={6}
          onPress={onOpenServerSetup}
          style={styles.railFooterIconButton}
          testID="open-server-setup"
        >
          <Settings color={tokens["--text-secondary"]} size={15} strokeWidth={1.5} />
        </Pressable>
      </View>
    </View>
  );
}

const TERMUX_SERVER_URL = "http://127.0.0.1:9100";
// apt (not pkg) first: Termux pkg depends on curl, and a partial openssl/curl
// upgrade leaves curl unlinkable (SSL_set_quic_tls_transport_params). Only
// apt full-upgrade can repair that state before curl can fetch the installer.
const TERMUX_INSTALL_COMMAND =
  "apt update && apt full-upgrade -y && apt install -y curl && curl -fsSL https://raw.githubusercontent.com/BenItBuhner/Cesium/main/apps/mobile/termux/install-cesium-server.sh | bash";

function OnDeviceServerSetup({
  onClose,
  open,
  styles,
  tokens,
}: {
  onClose: () => void;
  open: boolean;
  styles: ReturnType<typeof createStyles>;
  tokens: ThemeTokens;
}) {
  const { probeServer, saveServer, setActiveServer } = useServerConnections();
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const connect = useCallback(async () => {
    setChecking(true);
    setStatus("Checking the on-device server...");
    try {
      const probe = await probeServer(TERMUX_SERVER_URL);
      if (!probe.ok) {
        setStatus(probe.error || "The Termux server is not reachable yet.");
        return;
      }
      const saved = saveServer({
        label: "This phone",
        baseUrl: TERMUX_SERVER_URL,
      });
      setActiveServer(saved.id);
      setStatus("Connected to the server running on this phone.");
      onClose();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Server check failed.");
    } finally {
      setChecking(false);
    }
  }, [onClose, probeServer, saveServer, setActiveServer]);

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      transparent
      visible={open}
    >
      <View style={styles.setupBackdrop}>
        <View style={styles.setupSheet} testID="on-device-server-setup">
          <View style={styles.setupHeader}>
            <View>
              <Text style={styles.setupTitle}>Server on this phone</Text>
              <Text style={styles.setupSubtitle}>Optional · Android phone only</Text>
            </View>
            <IconButton
              accessibilityLabel="Close server setup"
              Icon={X}
              onPress={onClose}
              tokens={tokens}
            />
          </View>
          <ScrollView contentContainerStyle={styles.setupContent}>
            <Text style={styles.setupBody}>
              Termux runs the real Cesium Node backend locally at 127.0.0.1.
              Wear OS never installs or runs the server.
            </Text>
            <Text style={styles.setupStep}>1 · Install Termux from F-Droid.</Text>
            <Pressable
              onPress={() =>
                void Linking.openURL("https://f-droid.org/packages/com.termux/")
              }
              style={styles.setupButton}
            >
              <Text style={styles.setupButtonText}>Open Termux installer</Text>
            </Pressable>
            <Text style={styles.setupStep}>
              2 · Paste this in Termux. It upgrades packages first (fixes broken curl), then installs the server.
            </Text>
            <View style={styles.setupCommand}>
              <Text selectable style={styles.setupCommandText}>
                {TERMUX_INSTALL_COMMAND}
              </Text>
            </View>
            <Pressable
              onPress={() =>
                void Share.share({
                  message: TERMUX_INSTALL_COMMAND,
                  title: "Cesium Termux installer",
                })
              }
              style={styles.setupButton}
            >
              <Text style={styles.setupButtonText}>Share installer command</Text>
            </Pressable>
            <Text style={styles.setupStep}>3 · Connect Cesium when installation finishes.</Text>
            <Pressable
              disabled={checking}
              onPress={() => void connect()}
              style={[styles.setupPrimaryButton, checking ? styles.disabled : null]}
              testID="connect-on-device-server"
            >
              {checking ? (
                <ActivityIndicator color={tokens["--bg-main"]} />
              ) : (
                <Text style={styles.setupPrimaryButtonText}>Check and use this phone</Text>
              )}
            </Pressable>
            {status ? <Text style={styles.setupStatus}>{status}</Text> : null}
            <Text style={styles.setupFootnote}>
              If apt complains about mirrors, run termux-change-repo, then retry.
              The installer skips native addons Termux cannot build (node-pty) and
              uses legacy-json storage bound to loopback. Integrated terminals are
              limited on-device; external agent CLIs remain optional.
            </Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function WorkbenchBody({
  connectionState,
  notificationConversationId,
  onFocusedConversationChange,
  onProjection,
  onServerBaseUrlChange,
  tokens,
}: NativeWorkbenchProps & { tokens: ThemeTokens }) {
  const {
    activeWorkspace,
    activeWorkspaceId,
    error: workspaceError,
    loading: workspaceLoading,
    refreshWorkspaces,
    setActiveWorkspace,
    workspaces,
  } = useNativeWorkspace();
  const { activeServer } = useServerConnections();
  const { width: viewportWidth } = useWindowDimensions();
  const serverLabel =
    activeServer.baseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "") ||
    activeServer.label;
  const styles = useMemo(() => createStyles(tokens), [tokens]);
  const [railOpen, setRailOpen] = useState(false);
  const [rightPaneOpen, setRightPaneOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [serverSetupOpen, setServerSetupOpen] = useState(false);
  const [conversations, setConversations] = useState<AgentConversationRecord[]>([]);
  const [backends, setBackends] = useState<AgentBackendInfo[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [editorDocument, setEditorDocument] = useState<EditorDocument | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [workspaceBranch, setWorkspaceBranch] = useState<string | null>(null);
  const initialConversationSelected = useRef(false);
  const previousProjection = useRef<MobileAgentProjection | null>(null);
  const openedPlanFiles = useRef(new Set<string>());
  const {
    error: feedError,
    feed,
    loading: feedLoading,
    refresh: refreshFeed,
  } = useConversationFeed(activeWorkspaceId, selectedConversationId);

  useEffect(() => {
    onServerBaseUrlChange?.(activeServer.baseUrl);
  }, [activeServer.baseUrl, onServerBaseUrlChange]);

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
            : null
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
    if (!activeWorkspaceId) {
      setWorkspaceBranch(null);
      return;
    }
    let disposed = false;
    void fetchWorkspaceGitStatus(activeWorkspaceId)
      .then(({ status }) => {
        if (!disposed) {
          setWorkspaceBranch(status.currentBranch ?? null);
        }
      })
      .catch(() => {
        if (!disposed) {
          setWorkspaceBranch(null);
        }
      });
    return () => {
      disposed = true;
    };
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (
      notificationConversationId &&
      conversations.some((conversation) => conversation.id === notificationConversationId)
    ) {
      setSelectedConversationId(notificationConversationId);
      setRailOpen(false);
      setRightPaneOpen(false);
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
    setFilePickerOpen(false);
    setRightPaneOpen(true);
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

  useEffect(() => {
    if (!selectedConversationId) {
      openedPlanFiles.current.clear();
      return;
    }
    const latestPlanFile = [...feed.events]
      .reverse()
      .find((event) => event.kind === "plan_file");
    if (
      latestPlanFile?.kind === "plan_file" &&
      !openedPlanFiles.current.has(latestPlanFile.path)
    ) {
      openedPlanFiles.current.add(latestPlanFile.path);
      void openFile(latestPlanFile.path);
    }
  }, [feed.events, openFile, selectedConversationId]);

  const saveEditorDocument = useCallback(async () => {
    if (!editorDocument?.dirty) {
      return;
    }
    await writeFile(editorDocument.path, editorDocument.content);
    setEditorDocument((current) => (current ? { ...current, dirty: false } : current));
  }, [editorDocument]);

  const submitPrompt = useCallback(
    async (text: string, modeOverride?: string): Promise<boolean> => {
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
            mode:
              (modeOverride ?? backend.defaultMode) as AgentConversationRecord["config"]["mode"],
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
    return (
      <View style={[sharedStyles.centered, { backgroundColor: tokens["--bg-main"] }]}>
        <ActivityIndicator color={tokens["--text-secondary"]} />
        <Text style={styles.emptySubtitle}>Loading workspace...</Text>
        <Pressable
          onPress={() => setServerSetupOpen(true)}
          style={styles.secondaryButton}
          testID="loading-open-server-setup"
        >
          <Text style={styles.secondaryButtonText}>Set up server on this phone</Text>
        </Pressable>
        <OnDeviceServerSetup
          onClose={() => setServerSetupOpen(false)}
          open={serverSetupOpen}
          styles={styles}
          tokens={tokens}
        />
      </View>
    );
  }
  if (workspaceError && !activeWorkspace) {
    return (
      <View style={[sharedStyles.centered, { backgroundColor: tokens["--bg-main"] }]}>
        <AlertCircle color={tokens["--text-secondary"]} size={20} />
        <Text style={styles.errorText}>{workspaceError}</Text>
        <Pressable onPress={() => void refreshWorkspaces()} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Retry</Text>
        </Pressable>
        <Pressable
          onPress={() => setServerSetupOpen(true)}
          style={styles.secondaryButton}
          testID="error-open-server-setup"
        >
          <Text style={styles.secondaryButtonText}>Set up server on this phone</Text>
        </Pressable>
        <OnDeviceServerSetup
          onClose={() => setServerSetupOpen(false)}
          open={serverSetupOpen}
          styles={styles}
          tokens={tokens}
        />
      </View>
    );
  }

  return (
    <View style={styles.workbench}>
      <View style={styles.agentCenterStage}>
        {conversationsLoading && conversations.length === 0 ? (
          <LoadingScreen label="Loading chats..." tokens={tokens} />
        ) : (
          <ChatPanel
            backends={backends}
            connectionState={connectionState}
            feed={feed}
            feedError={feedError ?? conversationError}
            feedLoading={feedLoading}
            onOpenWorkbench={() => {
              setFilePickerOpen(false);
              setRightPaneOpen(true);
            }}
            onPermission={answerPermission}
            onQuestion={answerQuestion}
            onRefresh={() => {
              refreshFeed();
              void refreshConversations();
            }}
            onSubmit={submitPrompt}
            selectedConversationId={selectedConversationId}
            styles={styles}
            tokens={tokens}
            workspaceBranch={workspaceBranch}
            workspaceName={activeWorkspace?.name ?? "Workspace"}
            workspaceRoot={activeWorkspace?.root ?? ""}
          />
        )}
      </View>

      <View pointerEvents="box-none" style={styles.agentTopLeftAction}>
        {!railOpen ? (
          <IconButton
            accessibilityLabel="Show workspace rail"
            compact
            Icon={PanelLeftOpen}
            onPress={() => setRailOpen(true)}
            surface
            tokens={tokens}
            testID="open-agent-rail"
          />
        ) : null}
      </View>
      <View pointerEvents="box-none" style={styles.agentTopRightAction}>
        {!rightPaneOpen && selectedConversationId ? (
          <IconButton
            accessibilityLabel="Show workbench pane"
            compact
            Icon={PanelRightOpen}
            onPress={() => {
              setFilePickerOpen(false);
              setRightPaneOpen(true);
            }}
            surface
            tokens={tokens}
            testID="open-workbench-pane"
          />
        ) : null}
      </View>

      {railOpen ? (
        <>
          <Pressable
            accessibilityLabel="Close workspace rail"
            onPress={() => setRailOpen(false)}
            style={styles.agentScrim}
            testID="agent-rail-scrim"
          />
          <View
            style={[
              styles.agentRailDrawer,
              { width: Math.min(290, viewportWidth * 0.84) },
            ]}
          >
            <AgentRail
              activeWorkspaceId={activeWorkspaceId}
              branchLabel={workspaceBranch}
              conversations={conversations}
              onClose={() => setRailOpen(false)}
              onNewConversation={() => {
                setSelectedConversationId(null);
                setRightPaneOpen(false);
                setRailOpen(false);
              }}
              onOpenServerSetup={() => {
                setRailOpen(false);
                setServerSetupOpen(true);
              }}
              onSelectConversation={(conversationId) => {
                setSelectedConversationId(conversationId);
                setRailOpen(false);
              }}
              onSelectWorkspace={(workspaceId) => {
                setActiveWorkspace(workspaceId);
                setSelectedConversationId(null);
                setRightPaneOpen(false);
                setRailOpen(false);
              }}
              serverLabel={serverLabel}
              selectedConversationId={selectedConversationId}
              styles={styles}
              tokens={tokens}
              workspaces={workspaces}
            />
          </View>
        </>
      ) : null}

      {rightPaneOpen ? (
        <View
          style={[
            styles.agentRightPane,
            { width: Math.min(viewportWidth, 550) },
          ]}
          testID="agent-workbench-pane"
        >
          {filePickerOpen ? (
            <FilesPanel
              activeDocumentPath={editorDocument?.path ?? null}
              onOpenFile={openFile}
              styles={styles}
              tokens={tokens}
              workspaceName={activeWorkspace?.name ?? "Workspace"}
            />
          ) : (
            <EditorPanel
              document={editorDocument}
              loading={editorLoading}
              onChange={(content) =>
                setEditorDocument((current) =>
                  current ? { ...current, content, dirty: true } : current
                )
              }
              onClose={() => setEditorDocument(null)}
              onClosePane={() => setRightPaneOpen(false)}
              onOpenFiles={() => setFilePickerOpen(true)}
              onSave={() => void saveEditorDocument()}
              styles={styles}
              tokens={tokens}
            />
          )}
          {filePickerOpen ? (
            <View style={styles.filePickerClose}>
              <IconButton
                accessibilityLabel="Return to editor"
                compact
                Icon={PanelRightClose}
                onPress={() => setFilePickerOpen(false)}
                tokens={tokens}
                testID="close-workbench-file-picker"
              />
            </View>
          ) : null}
        </View>
      ) : null}
      <OnDeviceServerSetup
        onClose={() => setServerSetupOpen(false)}
        open={serverSetupOpen}
        styles={styles}
        tokens={tokens}
      />
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
  compactIconButton: {
    alignItems: "center",
    borderRadius: 5,
    height: DESIGN_2_RECIPES.rail.toolbarButtonSize,
    justifyContent: "center",
    width: DESIGN_2_RECIPES.rail.toolbarButtonSize,
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
    borderWidth: DESIGN_2_RECIPES.cards.borderWidth,
  };
  return StyleSheet.create({
    agentCenterStage: {
      flex: 1,
      minHeight: 0,
      paddingHorizontal: 8,
    },
    agentRail: {
      backgroundColor: tokens["--bg-panel"],
      flex: 1,
    },
    agentRailDrawer: {
      backgroundColor: tokens["--bg-panel"],
      borderRightColor: tokens["--border-subtle"],
      borderRightWidth: DESIGN_2_RECIPES.cards.borderWidth,
      bottom: 0,
      elevation: 12,
      left: 0,
      position: "absolute",
      top: 0,
      zIndex: 40,
    },
    agentRightPane: {
      backgroundColor: tokens["--bg-panel"],
      borderLeftColor: tokens["--border-subtle"],
      borderLeftWidth: DESIGN_2_RECIPES.cards.borderWidth,
      bottom: 0,
      elevation: 14,
      position: "absolute",
      right: 0,
      top: 0,
      zIndex: 40,
    },
    agentScrim: {
      backgroundColor: tokens["--palette-backdrop"],
      bottom: 0,
      left: 0,
      position: "absolute",
      right: 0,
      top: 0,
      zIndex: 30,
    },
    agentTopLeftAction: {
      left: 11,
      position: "absolute",
      top: 11,
      zIndex: 20,
    },
    agentTopRightAction: {
      position: "absolute",
      right: 11,
      top: 11,
      zIndex: 20,
    },
    assistantMessage: {
      paddingHorizontal: 4,
      paddingVertical: 7,
    },
    attentionCard: {
      ...card,
      backgroundColor: tokens["--bg-card"],
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
    choiceButton: {
      alignItems: "center",
      backgroundColor: tokens["--bg-main"],
      borderColor: tokens["--border-card"],
      borderRadius: tabRadius,
      borderWidth: DESIGN_2_RECIPES.cards.borderWidth,
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
      gap: DESIGN_2_RECIPES.composer.stackedGap,
      marginHorizontal: 0,
      padding: DESIGN_2_RECIPES.composer.padding,
    },
    composerActions: {
      alignItems: "center",
      flexDirection: "row",
      gap: DESIGN_2_RECIPES.composer.gap,
      minHeight: DESIGN_2_RECIPES.composer.plusSize,
    },
    composerLeadingControls: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
      flexShrink: 0,
    },
    composerModeChip: {
      alignItems: "center",
      borderRadius: DESIGN_2_RECIPES.composer.singleLineRadius,
      flexDirection: "row",
      gap: DESIGN_2_RECIPES.composer.modeChipGap,
      height: DESIGN_2_RECIPES.composer.modeChipHeight,
      paddingLeft: DESIGN_2_RECIPES.composer.modeChipPaddingLeft,
      paddingRight: DESIGN_2_RECIPES.composer.modeChipPaddingRight,
    },
    composerModeChipText: {
      fontFamily: "sans-serif",
      fontSize: 11,
      fontWeight: "500",
    },
    composerPlusButton: {
      alignItems: "center",
      backgroundColor: tokens["--agent-plus-button-bg"] ?? tokens["--bg-panel"],
      borderColor: tokens["--border-card"],
      borderRadius: DESIGN_2_RECIPES.composer.singleLineRadius,
      borderWidth: DESIGN_2_RECIPES.composer.borderWidth,
      height: DESIGN_2_RECIPES.composer.plusSize,
      justifyContent: "center",
      width: DESIGN_2_RECIPES.composer.plusSize,
    },
    composerSingleRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: DESIGN_2_RECIPES.composer.gap,
      minWidth: 0,
    },
    composerInput: {
      ...bodyText,
      flex: 1,
      lineHeight: DESIGN_2_RECIPES.composer.lineHeight,
      maxHeight: DESIGN_2_RECIPES.composer.maxHeight,
      padding: 0,
    },
    composerInputSingle: {
      height: DESIGN_2_RECIPES.composer.plusSize,
      minHeight: DESIGN_2_RECIPES.composer.plusSize,
      overflow: "hidden",
      paddingVertical: 0,
      textAlignVertical: "center",
    },
    composerInputMultiline: {
      minHeight: 40,
      textAlignVertical: "top",
    },
    composerMeta: {
      color: tokens["--text-disabled"],
      flexShrink: 1,
      fontFamily: "sans-serif",
      fontSize: 9.5,
    },
    composerBranchMeta: {
      color: tokens["--text-disabled"],
      flexShrink: 1,
      fontFamily: "monospace",
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
      fontFamily: "monospace",
      fontSize: 12,
      lineHeight: 18,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    editorScrollContent: {
      backgroundColor: tokens["--bg-main"],
      flexGrow: 1,
    },
    editorTab: {
      alignItems: "center",
      alignSelf: "stretch",
      backgroundColor: tokens["--bg-main"],
      borderRightColor: tokens["--border-subtle"],
      borderRightWidth: DESIGN_2_RECIPES.cards.borderWidth,
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
      borderBottomWidth: DESIGN_2_RECIPES.cards.borderWidth,
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
    filePickerClose: {
      position: "absolute",
      right: 4,
      top: 4,
      zIndex: 50,
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
      borderWidth: DESIGN_2_RECIPES.cards.borderWidth,
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
      paddingTop: 48,
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
      maxWidth: 145,
      minHeight: DESIGN_2_RECIPES.composer.sendSize,
      paddingHorizontal: 0,
    },
    modelText: {
      color: tokens["--text-secondary"],
      flexShrink: 1,
      fontFamily: "sans-serif",
      fontSize: 11,
    },
    newChatStage: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
      paddingHorizontal: 2,
      paddingVertical: 54,
    },
    newChatContent: {
      gap: 2,
      maxWidth: DESIGN_2_RECIPES.landing.contentMaxWidth,
      width: "100%",
    },
    panel: {
      backgroundColor: tokens["--bg-main"],
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
    quickActionButton: {
      backgroundColor: tokens["--bg-panel"],
      borderColor: tokens["--border-card"],
      borderRadius: DESIGN_2_RECIPES.composer.singleLineRadius,
      borderWidth: DESIGN_2_RECIPES.cards.borderWidth,
      paddingHorizontal: DESIGN_2_RECIPES.landing.quickActionHorizontalPadding,
      paddingVertical: DESIGN_2_RECIPES.landing.quickActionVerticalPadding,
    },
    quickActionText: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif",
      fontSize: 12,
    },
    quickActions: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: DESIGN_2_RECIPES.landing.quickActionGap,
      marginTop: 10,
    },
    railConversationRow: {
      alignItems: "center",
      borderRadius: tabRadius,
      flexDirection: "row",
      gap: 7,
      height: DESIGN_2_RECIPES.rail.rowHeight,
      paddingHorizontal: DESIGN_2_RECIPES.rail.rowHorizontalPadding,
    },
    railConversationRowSelected: {
      backgroundColor: tokens["--bg-card"],
    },
    railConversationTitle: {
      color: tokens["--text-primary"],
      flex: 1,
      fontFamily: "sans-serif",
      fontSize: 12.5,
      fontWeight: "500",
    },
    railBranchLabel: {
      color: tokens["--text-disabled"],
      flexShrink: 1,
      fontFamily: "monospace",
      fontSize: 9.5,
      maxWidth: 118,
    },
    railEmptyText: {
      color: tokens["--text-disabled"],
      fontFamily: "sans-serif",
      fontSize: 11.5,
      paddingHorizontal: 18,
      paddingVertical: 8,
    },
    railFooter: {
      alignItems: "center",
      flexDirection: "row",
      gap: DESIGN_2_RECIPES.rail.footerGap,
      minHeight:
        DESIGN_2_RECIPES.rail.footerControlSize +
        DESIGN_2_RECIPES.rail.footerVerticalPadding * 2,
      paddingHorizontal: DESIGN_2_RECIPES.rail.footerHorizontalPadding,
      paddingVertical: DESIGN_2_RECIPES.rail.footerVerticalPadding,
    },
    railFooterLabel: {
      color: tokens["--text-primary"],
      flex: 1,
      fontFamily: "sans-serif",
      fontSize: 12.5,
    },
    railFooterIconButton: {
      alignItems: "center",
      borderRadius: tabRadius,
      height: DESIGN_2_RECIPES.rail.footerControlSize,
      justifyContent: "center",
      width: DESIGN_2_RECIPES.rail.footerControlSize,
    },
    railList: {
      flexGrow: 1,
      paddingBottom: 12,
      paddingHorizontal: 10,
      paddingTop: 10,
    },
    railSearchInput: {
      ...bodyText,
      borderBottomColor: tokens["--border-subtle"],
      borderBottomWidth: DESIGN_2_RECIPES.cards.borderWidth,
      fontSize: 12.5,
      height: 38,
      marginHorizontal: 10,
      paddingHorizontal: 3,
    },
    railTopBar: {
      alignItems: "center",
      flexDirection: "row",
      gap: DESIGN_2_RECIPES.rail.toolbarGap,
      minHeight: 40,
      paddingHorizontal: DESIGN_2_RECIPES.rail.footerHorizontalPadding,
      paddingTop: 11,
    },
    railWorkspaceHeader: {
      alignItems: "center",
      flexDirection: "row",
      gap: 5,
      minHeight: 24,
      paddingHorizontal: 1,
    },
    railWorkspaceLabel: {
      color: tokens["--text-disabled"],
      flex: 1,
      fontFamily: "sans-serif",
      fontSize: 10.5,
      fontWeight: "500",
    },
    railWorkspaceLabelActive: {
      color: tokens["--text-primary"],
    },
    railWorkspaceSection: {
      gap: 2,
      marginBottom: 10,
    },
    secondaryButton: {
      borderColor: tokens["--border-card"],
      borderRadius: tabRadius,
      borderWidth: DESIGN_2_RECIPES.cards.borderWidth,
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
    setupBackdrop: {
      backgroundColor: tokens["--palette-backdrop"],
      flex: 1,
      justifyContent: "flex-end",
    },
    setupBody: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif",
      fontSize: 13,
      lineHeight: 19,
    },
    setupButton: {
      ...card,
      alignItems: "center",
      minHeight: 40,
      justifyContent: "center",
      paddingHorizontal: 12,
    },
    setupButtonText: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif",
      fontSize: 12.5,
      fontWeight: "500",
    },
    setupCommand: {
      backgroundColor: tokens["--bg-main"],
      borderColor: tokens["--border-subtle"],
      borderRadius: tabRadius,
      borderWidth: DESIGN_2_RECIPES.cards.borderWidth,
      padding: 10,
    },
    setupCommandText: {
      color: tokens["--text-secondary"],
      fontFamily: "monospace",
      fontSize: 10.5,
      lineHeight: 15,
    },
    setupContent: {
      gap: 10,
      paddingBottom: 28,
      paddingHorizontal: 16,
    },
    setupFootnote: {
      color: tokens["--text-disabled"],
      fontFamily: "sans-serif",
      fontSize: 10.5,
      lineHeight: 15,
    },
    setupHeader: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      padding: 16,
    },
    setupPrimaryButton: {
      alignItems: "center",
      backgroundColor: tokens["--accent"],
      borderRadius: tabRadius,
      justifyContent: "center",
      minHeight: 42,
      paddingHorizontal: 12,
    },
    setupPrimaryButtonText: {
      color: tokens["--bg-main"],
      fontFamily: "sans-serif",
      fontSize: 12.5,
      fontWeight: "600",
    },
    setupSheet: {
      backgroundColor: tokens["--bg-panel"],
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      maxHeight: "88%",
    },
    setupStatus: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif",
      fontSize: 11.5,
      textAlign: "center",
    },
    setupStep: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif",
      fontSize: 12.5,
      fontWeight: "500",
      marginTop: 4,
    },
    setupSubtitle: {
      color: tokens["--text-disabled"],
      fontFamily: "sans-serif",
      fontSize: 10.5,
      marginTop: 2,
    },
    setupTitle: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif",
      fontSize: 17,
      fontWeight: "600",
    },
    landingError: {
      color: tokens["--debug-accent"],
      fontFamily: "sans-serif",
      fontSize: 11,
      marginTop: 5,
    },
    sendButton: {
      alignItems: "center",
      borderRadius: DESIGN_2_RECIPES.composer.singleLineRadius,
      height: DESIGN_2_RECIPES.composer.sendSize,
      justifyContent: "center",
      width: DESIGN_2_RECIPES.composer.sendSize,
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
      overflow: "hidden",
      padding: DESIGN_2_RECIPES.cards.padding,
    },
    workbench: {
      backgroundColor: tokens["--bg-main"],
      flex: 1,
      overflow: "hidden",
    },
    workspaceContextRow: {
      alignItems: "center",
      flexDirection: "row",
      flexWrap: "wrap",
      gap: DESIGN_2_RECIPES.landing.contextGap,
      minHeight: 27,
    },
    workspaceContextPill: {
      alignItems: "center",
      borderRadius: DESIGN_2_RECIPES.composer.singleLineRadius,
      flexDirection: "row",
      gap: 5,
      maxWidth: 220,
      paddingHorizontal: DESIGN_2_RECIPES.landing.contextHorizontalPadding,
      paddingVertical: DESIGN_2_RECIPES.landing.contextVerticalPadding,
    },
    workspaceTargetPill: {
      alignItems: "center",
      borderRadius: DESIGN_2_RECIPES.composer.singleLineRadius,
      flexDirection: "row",
      gap: 5,
      paddingHorizontal: DESIGN_2_RECIPES.landing.contextHorizontalPadding,
      paddingVertical: DESIGN_2_RECIPES.landing.contextVerticalPadding,
    },
    workspaceContextText: {
      color: tokens["--text-secondary"],
      flexShrink: 1,
      fontFamily: "sans-serif",
      fontSize: 12.5,
    },
    workspaceRootText: {
      color: tokens["--text-disabled"],
      flexShrink: 1,
      fontFamily: "monospace",
      fontSize: 10.5,
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
