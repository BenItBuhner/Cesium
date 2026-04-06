import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  createAgentSubscribeMessage,
  getDefaultServerUrl,
  JsonWebSocket,
  OpenCursorClient,
  type AgentConversationRecord,
  type AgentConversationSnapshot,
  type AgentSocketServerMessage,
  type AgentStoredEvent,
  type WorkspaceRecord,
  type WebSocketFactory,
} from "@opencursor/client-sdk";

const webSocketFactory: WebSocketFactory = (url: string) => new WebSocket(url);

function describeEvent(event: AgentStoredEvent): string {
  switch (event.kind) {
    case "user_message":
      return event.content;
    case "assistant_message_chunk":
      return event.text;
    case "assistant_message_end":
      return event.stopReason ? `Completed (${event.stopReason})` : "Completed";
    case "reasoning":
      return event.text;
    case "tool_call":
    case "tool_call_update":
      return `${event.title ?? "Tool call"}${event.detail ? ` - ${event.detail}` : ""}`;
    case "plan":
      return event.entries.map((entry) => `${entry.status}: ${entry.content}`).join("\n");
    case "permission_request":
      return `${event.title ?? "Permission request"}${event.detail ? ` - ${event.detail}` : ""}`;
    case "permission_resolved":
      return event.outcome === "selected"
        ? `Selected ${event.optionId ?? "permission"}`
        : "Permission cancelled";
    case "system":
      return event.text;
    case "status":
      return event.detail ? `${event.status}: ${event.detail}` : event.status;
    case "subagent":
      return `${event.title}${event.recentActivity ? ` - ${event.recentActivity}` : ""}`;
    default:
      return JSON.stringify(event);
  }
}

function eventTint(kind: AgentStoredEvent["kind"]): string {
  switch (kind) {
    case "user_message":
      return "#8bb8ff";
    case "assistant_message_chunk":
    case "assistant_message_end":
      return "#d9e5ff";
    case "reasoning":
      return "#ffd479";
    case "tool_call":
    case "tool_call_update":
    case "subagent":
      return "#9ae6b4";
    case "system":
    case "status":
      return "#f8a5c2";
    default:
      return "#c6d0f5";
  }
}

export default function App() {
  const [serverUrlDraft, setServerUrlDraft] = useState(getDefaultServerUrl());
  const [serverUrl, setServerUrl] = useState(getDefaultServerUrl());
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceRecord | null>(null);
  const [conversations, setConversations] = useState<AgentConversationRecord[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, AgentStoredEvent[]>>({});
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState("Ready");
  const [loading, setLoading] = useState(false);
  const socketRef = useRef<JsonWebSocket<AgentSocketServerMessage> | null>(null);

  const client = useMemo(
    () =>
      new OpenCursorClient({
        config: { serverUrl },
        fetchImpl: (...args) => fetch(...args),
      }),
    [serverUrl]
  );

  const selectedEvents = selectedConversationId ? events[selectedConversationId] ?? [] : [];

  const disconnectSocket = useCallback(() => {
    socketRef.current?.disconnect();
    socketRef.current = null;
  }, []);

  const applySnapshot = useCallback((snapshot: AgentConversationSnapshot) => {
    setConversations((current) => {
      const filtered = current.filter((item) => item.id !== snapshot.conversation.id);
      return [snapshot.conversation, ...filtered].sort((a, b) => b.updatedAt - a.updatedAt);
    });
    setEvents((current) => ({
      ...current,
      [snapshot.conversation.id]: snapshot.events,
    }));
  }, []);

  const refreshConversations = useCallback(async () => {
    if (!activeWorkspace) {
      return;
    }
    client.setActiveWorkspaceId(activeWorkspace.id);
    const result = await client.listAgentConversations();
    setConversations(
      result.conversations.sort(
        (a: AgentConversationRecord, b: AgentConversationRecord) => b.updatedAt - a.updatedAt
      )
    );
    if (!selectedConversationId && result.conversations.length > 0) {
      setSelectedConversationId(result.conversations[0].id);
    }
  }, [activeWorkspace, client, selectedConversationId]);

  const refreshWorkspaces = useCallback(async () => {
    setLoading(true);
    setStatus(`Connecting to ${serverUrl}`);
    disconnectSocket();
    setEvents({});
    setConversations([]);
    setSelectedConversationId(null);

    try {
      const bootstrap = await client.fetchWorkspaceBootstrap();
      const nextWorkspace =
        bootstrap.workspaces.find(
          (item: WorkspaceRecord) => item.id === bootstrap.startupWorkspaceId
        ) ??
        bootstrap.workspaces[0] ??
        null;
      setWorkspaces(bootstrap.workspaces);
      setActiveWorkspace(nextWorkspace);
      if (nextWorkspace) {
        client.setActiveWorkspaceId(nextWorkspace.id);
        setStatus(`Connected to ${serverUrl}`);
      } else {
        setStatus("No workspaces available on the server");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to connect");
    } finally {
      setLoading(false);
    }
  }, [client, disconnectSocket, serverUrl]);

  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);

  useEffect(() => {
    if (!activeWorkspace) {
      return;
    }
    void refreshConversations();
  }, [activeWorkspace, refreshConversations]);

  useEffect(() => {
    if (!activeWorkspace || !selectedConversationId) {
      disconnectSocket();
      return;
    }

    client.setActiveWorkspaceId(activeWorkspace.id);
    const socket = new JsonWebSocket<AgentSocketServerMessage>(
      () => client.buildAgentWebSocketUrl(activeWorkspace.id),
      webSocketFactory
    );
    socketRef.current = socket;

    socket.onOpen(() => {
      setStatus(`Streaming ${activeWorkspace.name}`);
      socket.send(createAgentSubscribeMessage([selectedConversationId]));
    });
    socket.onMessage((message: AgentSocketServerMessage) => {
      if (message.type === "snapshot") {
        applySnapshot(message.snapshot);
        return;
      }
      if (message.type === "conversation") {
        setConversations((current) => {
          const filtered = current.filter((item) => item.id !== message.conversation.id);
          return [message.conversation, ...filtered].sort((a, b) => b.updatedAt - a.updatedAt);
        });
        return;
      }
      if (message.type === "event") {
        setEvents((current) => ({
          ...current,
          [message.conversationId]: [...(current[message.conversationId] ?? []), message.event],
        }));
        return;
      }
      if (message.type === "error") {
        setStatus(message.message);
      }
    });
    socket.onError(() => setStatus("Socket error"));
    socket.connect();

    void client
      .fetchAgentConversationSnapshot(selectedConversationId)
      .then(({ snapshot }: { snapshot: AgentConversationSnapshot }) => applySnapshot(snapshot))
      .catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : "Failed to load conversation");
      });

    return () => {
      socket.disconnect();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [activeWorkspace, applySnapshot, client, disconnectSocket, selectedConversationId]);

  const handleChangeServer = useCallback(() => {
    const next = serverUrlDraft.trim();
    if (!next) {
      return;
    }
    setServerUrl(next);
  }, [serverUrlDraft]);

  const handleSelectWorkspace = useCallback(
    async (workspace: WorkspaceRecord) => {
      setActiveWorkspace(workspace);
      setSelectedConversationId(null);
      client.setActiveWorkspaceId(workspace.id);
      setStatus(`Workspace: ${workspace.name}`);
      await refreshConversations();
    },
    [client, refreshConversations]
  );

  const handleCreateConversation = useCallback(async () => {
    if (!activeWorkspace) {
      return;
    }
    client.setActiveWorkspaceId(activeWorkspace.id);
    setLoading(true);
    try {
      const { conversation } = await client.createAgentConversation({
        title: "Mobile chat",
      });
      setConversations((current) => [conversation, ...current]);
      setSelectedConversationId(conversation.id);
      setStatus("Created conversation");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to create conversation");
    } finally {
      setLoading(false);
    }
  }, [activeWorkspace, client]);

  const handleSendPrompt = useCallback(async () => {
    if (!activeWorkspace || !selectedConversationId || !prompt.trim()) {
      return;
    }
    client.setActiveWorkspaceId(activeWorkspace.id);
    setLoading(true);
    try {
      await client.promptAgentConversation(selectedConversationId, prompt.trim());
      setPrompt("");
      setStatus("Prompt sent");
      const { snapshot } = await client.fetchAgentConversationSnapshot(selectedConversationId, {
        hydrateRuntime: true,
      });
      applySnapshot(snapshot);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to send prompt");
    } finally {
      setLoading(false);
    }
  }, [activeWorkspace, applySnapshot, client, prompt, selectedConversationId]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>OpenCursor Mobile</Text>
        <Text style={styles.subtitle}>
          Expo client for Android, iPhone, and iPad layouts backed by the same OpenCursor server.
        </Text>

        <View style={styles.card}>
          <Text style={styles.label}>Server URL</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setServerUrlDraft}
            style={styles.input}
            value={serverUrlDraft}
          />
          <View style={styles.row}>
            <Pressable onPress={handleChangeServer} style={styles.button}>
              <Text style={styles.buttonText}>Connect</Text>
            </Pressable>
            <Pressable onPress={() => void refreshWorkspaces()} style={styles.secondaryButton}>
              <Text style={styles.buttonText}>Refresh</Text>
            </Pressable>
          </View>
          <Text style={styles.status}>{status}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Workspaces</Text>
          {workspaces.length === 0 ? (
            <Text style={styles.muted}>No workspaces returned.</Text>
          ) : (
            workspaces.map((workspace) => {
              const active = workspace.id === activeWorkspace?.id;
              return (
                <Pressable
                  key={workspace.id}
                  onPress={() => void handleSelectWorkspace(workspace)}
                  style={[styles.listItem, active && styles.listItemActive]}
                >
                  <Text style={styles.listItemTitle}>{workspace.name}</Text>
                  <Text style={styles.listItemMeta}>{workspace.root}</Text>
                </Pressable>
              );
            })
          )}
        </View>

        <View style={styles.card}>
          <View style={styles.headerRow}>
            <Text style={styles.sectionTitle}>Agent conversations</Text>
            <Pressable onPress={() => void handleCreateConversation()} style={styles.button}>
              <Text style={styles.buttonText}>New chat</Text>
            </Pressable>
          </View>
          {conversations.length === 0 ? (
            <Text style={styles.muted}>No conversations yet.</Text>
          ) : (
            conversations.map((conversation) => {
              const selected = conversation.id === selectedConversationId;
              return (
                <Pressable
                  key={conversation.id}
                  onPress={() => setSelectedConversationId(conversation.id)}
                  style={[styles.listItem, selected && styles.listItemActive]}
                >
                  <Text style={styles.listItemTitle}>{conversation.title}</Text>
                  <Text style={styles.listItemMeta}>
                    {conversation.status} - {conversation.config.backendId}
                  </Text>
                </Pressable>
              );
            })
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Thread</Text>
          {selectedConversationId ? (
            <>
              {selectedEvents.length === 0 ? (
                <Text style={styles.muted}>Waiting for events...</Text>
              ) : (
                selectedEvents.map((event) => (
                  <View key={event.eventId} style={styles.eventRow}>
                    <Text style={[styles.eventKind, { color: eventTint(event.kind) }]}>
                      {event.kind}
                    </Text>
                    <Text style={styles.eventText}>{describeEvent(event)}</Text>
                  </View>
                ))
              )}
              <TextInput
                multiline
                onChangeText={setPrompt}
                placeholder="Prompt the agent"
                placeholderTextColor="#7f8ea3"
                style={[styles.input, styles.promptInput]}
                value={prompt}
              />
              <Pressable onPress={() => void handleSendPrompt()} style={styles.button}>
                <Text style={styles.buttonText}>Send prompt</Text>
              </Pressable>
            </>
          ) : (
            <Text style={styles.muted}>Select a conversation to start.</Text>
          )}
        </View>

        {loading ? <ActivityIndicator color="#8bb8ff" /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#0f1720",
  },
  container: {
    padding: 20,
    gap: 16,
  },
  title: {
    color: "#f7fbff",
    fontSize: 28,
    fontWeight: "700",
  },
  subtitle: {
    color: "#9fb0c6",
    fontSize: 15,
    lineHeight: 22,
  },
  card: {
    backgroundColor: "#162230",
    borderColor: "#243548",
    borderRadius: 16,
    borderWidth: 1,
    gap: 12,
    padding: 16,
  },
  label: {
    color: "#d9e5ff",
    fontSize: 13,
    fontWeight: "600",
  },
  input: {
    backgroundColor: "#0b1219",
    borderColor: "#2b3f54",
    borderRadius: 12,
    borderWidth: 1,
    color: "#f7fbff",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  promptInput: {
    minHeight: 100,
    textAlignVertical: "top",
  },
  row: {
    flexDirection: "row",
    gap: 10,
  },
  headerRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  button: {
    alignItems: "center",
    backgroundColor: "#2e6ff2",
    borderRadius: 12,
    justifyContent: "center",
    minHeight: 44,
    minWidth: 112,
    paddingHorizontal: 16,
  },
  secondaryButton: {
    alignItems: "center",
    backgroundColor: "#243548",
    borderRadius: 12,
    justifyContent: "center",
    minHeight: 44,
    minWidth: 112,
    paddingHorizontal: 16,
  },
  buttonText: {
    color: "#f7fbff",
    fontSize: 15,
    fontWeight: "600",
  },
  status: {
    color: "#9fb0c6",
    fontSize: 13,
  },
  sectionTitle: {
    color: "#f7fbff",
    fontSize: 18,
    fontWeight: "700",
  },
  muted: {
    color: "#7f8ea3",
    fontSize: 14,
  },
  listItem: {
    backgroundColor: "#0f1720",
    borderColor: "#243548",
    borderRadius: 14,
    borderWidth: 1,
    gap: 4,
    padding: 14,
  },
  listItemActive: {
    borderColor: "#4d8dff",
  },
  listItemTitle: {
    color: "#f7fbff",
    fontSize: 15,
    fontWeight: "600",
  },
  listItemMeta: {
    color: "#8ea1b8",
    fontSize: 12,
  },
  eventRow: {
    backgroundColor: "#0f1720",
    borderRadius: 14,
    gap: 6,
    padding: 14,
  },
  eventKind: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  eventText: {
    color: "#d7e4f5",
    fontSize: 14,
    lineHeight: 20,
  },
});
