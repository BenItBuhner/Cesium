import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import {
  Check,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  X,
} from "lucide-react-native";
import { useServerConnections } from "@cesium/client/react";
import {
  DESIGN_2_RECIPES,
  type Design2ThemeTokens as ThemeTokens,
} from "@cesium/design";
import { useThemeTokens } from "./theme";

type ProbeState = {
  status: "idle" | "running" | "ok" | "error";
  message: string | null;
};

function tokenNumber(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Native port of the web ServerConnectionsManager / AuthGate server picker.
 * Lets users add, switch, probe, edit, and remove Cesium servers without
 * going through the Termux on-device setup path first.
 */
export function ServerConnectionsSheet({
  onClose,
  onOpenOnDeviceSetup,
  open,
}: {
  onClose: () => void;
  onOpenOnDeviceSetup?: () => void;
  open: boolean;
}) {
  const tokens = useThemeTokens();
  const styles = useMemo(() => createStyles(tokens), [tokens]);
  const {
    activeServer,
    probeServer,
    removeServer,
    saveServer,
    servers,
    serverStatusById,
    setActiveServer,
  } = useServerConnections();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [savePending, setSavePending] = useState(false);
  const [probeByServerId, setProbeByServerId] = useState<Record<string, ProbeState>>(
    {}
  );
  const [adding, setAdding] = useState(false);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setLabel("");
    setBaseUrl("");
    setFormError(null);
    setAdding(false);
  }, []);

  const startAdd = useCallback(() => {
    setEditingId(null);
    setLabel("");
    setBaseUrl("");
    setFormError(null);
    setAdding(true);
  }, []);

  const startEdit = useCallback((serverId: string, nextLabel: string, nextBaseUrl: string) => {
    setEditingId(serverId);
    setLabel(nextLabel);
    setBaseUrl(nextBaseUrl);
    setFormError(null);
    setAdding(true);
  }, []);

  const handleSave = useCallback(
    (activate: boolean) => {
      setSavePending(true);
      setFormError(null);
      try {
        const saved = saveServer({
          id: editingId ?? undefined,
          label,
          baseUrl,
        });
        setProbeByServerId((current) => ({
          ...current,
          [saved.id]: { status: "idle", message: null },
        }));
        if (activate) {
          setActiveServer(saved.id);
          resetForm();
          onClose();
          return;
        }
        resetForm();
      } catch (error) {
        setFormError(error instanceof Error ? error.message : "Failed to save server.");
      } finally {
        setSavePending(false);
      }
    },
    [baseUrl, editingId, label, onClose, resetForm, saveServer, setActiveServer]
  );

  const runProbe = useCallback(
    async (serverId: string, candidateBaseUrl: string) => {
      setProbeByServerId((current) => ({
        ...current,
        [serverId]: { status: "running", message: null },
      }));
      try {
        const result = await probeServer(candidateBaseUrl);
        setProbeByServerId((current) => ({
          ...current,
          [serverId]: {
            status: result.ok ? "ok" : "error",
            message: result.ok
              ? result.authEnabled
                ? result.authenticated
                  ? "Reachable, auth enabled, signed in."
                  : "Reachable, auth enabled."
                : "Reachable."
              : result.error,
          },
        }));
      } catch (error) {
        setProbeByServerId((current) => ({
          ...current,
          [serverId]: {
            status: "error",
            message: error instanceof Error ? error.message : "Probe failed.",
          },
        }));
      }
    },
    [probeServer]
  );

  const handleActivate = useCallback(
    (serverId: string) => {
      setActiveServer(serverId);
      onClose();
    },
    [onClose, setActiveServer]
  );

  const showForm = adding;

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={open}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="native-server-connections">
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.title}>Servers</Text>
              <Text style={styles.subtitle}>
                Add a Cesium server URL or switch to a saved one.
              </Text>
            </View>
            <Pressable
              accessibilityLabel="Close servers"
              hitSlop={8}
              onPress={onClose}
              style={styles.iconButton}
              testID="close-server-connections"
            >
              <X color={tokens["--text-secondary"]} size={18} strokeWidth={1.5} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.activeCard}>
              <Text style={styles.activeLabel}>Active</Text>
              <Text numberOfLines={1} style={styles.activeName}>
                {activeServer.label}
              </Text>
              <Text numberOfLines={1} style={styles.activeUrl}>
                {activeServer.baseUrl}
              </Text>
            </View>

            {servers.map((server) => {
              const isActive = server.id === activeServer.id;
              const probe = probeByServerId[server.id] ?? {
                status: "idle" as const,
                message: null,
              };
              const runtime = serverStatusById[server.id];
              const healthLabel =
                runtime?.health === "online"
                  ? "Connected"
                  : runtime?.health === "auth_required"
                    ? "Auth needed"
                    : runtime?.health === "offline"
                      ? "Offline"
                      : null;
              return (
                <View key={server.id} style={styles.serverRow} testID={`server-row-${server.id}`}>
                  <View style={styles.serverMeta}>
                    <View style={styles.serverTitleRow}>
                      <Server
                        color={tokens["--text-secondary"]}
                        size={14}
                        strokeWidth={1.5}
                      />
                      <Text numberOfLines={1} style={styles.serverName}>
                        {server.label}
                      </Text>
                      {isActive ? (
                        <Text style={styles.badge}>Active</Text>
                      ) : null}
                      {healthLabel ? (
                        <Text style={styles.badgeMuted}>{healthLabel}</Text>
                      ) : null}
                    </View>
                    <Text numberOfLines={1} style={styles.serverUrl}>
                      {server.baseUrl}
                    </Text>
                    {probe.message ? (
                      <Text
                        style={
                          probe.status === "error" ? styles.probeError : styles.probeOk
                        }
                      >
                        {probe.message}
                      </Text>
                    ) : null}
                  </View>
                  <View style={styles.serverActions}>
                    <Pressable
                      disabled={isActive}
                      onPress={() => handleActivate(server.id)}
                      style={[styles.actionButton, isActive ? styles.actionDisabled : null]}
                      testID={`use-server-${server.id}`}
                    >
                      <Check
                        color={tokens["--text-primary"]}
                        size={13}
                        strokeWidth={1.5}
                      />
                      <Text style={styles.actionButtonText}>
                        {isActive ? "Selected" : "Use"}
                      </Text>
                    </Pressable>
                    <Pressable
                      disabled={probe.status === "running"}
                      onPress={() => void runProbe(server.id, server.baseUrl)}
                      style={styles.actionButton}
                      testID={`test-server-${server.id}`}
                    >
                      {probe.status === "running" ? (
                        <ActivityIndicator color={tokens["--text-secondary"]} size="small" />
                      ) : (
                        <RefreshCw
                          color={tokens["--text-primary"]}
                          size={13}
                          strokeWidth={1.5}
                        />
                      )}
                      <Text style={styles.actionButtonText}>Test</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => startEdit(server.id, server.label, server.baseUrl)}
                      style={styles.actionButton}
                      testID={`edit-server-${server.id}`}
                    >
                      <Pencil
                        color={tokens["--text-primary"]}
                        size={13}
                        strokeWidth={1.5}
                      />
                      <Text style={styles.actionButtonText}>Edit</Text>
                    </Pressable>
                    <Pressable
                      disabled={servers.length <= 1}
                      onPress={() => removeServer(server.id)}
                      style={[
                        styles.actionButton,
                        servers.length <= 1 ? styles.actionDisabled : null,
                      ]}
                      testID={`remove-server-${server.id}`}
                    >
                      <Trash2
                        color={tokens["--text-primary"]}
                        size={13}
                        strokeWidth={1.5}
                      />
                      <Text style={styles.actionButtonText}>Remove</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}

            {showForm ? (
              <View style={styles.form} testID="server-connection-form">
                <Text style={styles.formTitle}>
                  {editingId ? "Edit server" : "Add server"}
                </Text>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setLabel}
                  placeholder="Label (optional)"
                  placeholderTextColor={tokens["--text-disabled"]}
                  style={styles.input}
                  testID="server-label-input"
                  value={label}
                />
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  onChangeText={setBaseUrl}
                  placeholder="https://cesium.example.com"
                  placeholderTextColor={tokens["--text-disabled"]}
                  style={styles.input}
                  testID="server-url-input"
                  value={baseUrl}
                />
                {formError ? <Text style={styles.formError}>{formError}</Text> : null}
                <View style={styles.formActions}>
                  <Pressable
                    disabled={savePending || !baseUrl.trim()}
                    onPress={() => handleSave(true)}
                    style={[
                      styles.primaryButton,
                      savePending || !baseUrl.trim() ? styles.actionDisabled : null,
                    ]}
                    testID="save-and-connect-server"
                  >
                    {savePending ? (
                      <ActivityIndicator color={tokens["--bg-main"]} />
                    ) : (
                      <Text style={styles.primaryButtonText}>Save & connect</Text>
                    )}
                  </Pressable>
                  <Pressable
                    disabled={savePending || !baseUrl.trim()}
                    onPress={() => handleSave(false)}
                    style={[
                      styles.actionButton,
                      savePending || !baseUrl.trim() ? styles.actionDisabled : null,
                    ]}
                    testID="save-server"
                  >
                    <Text style={styles.actionButtonText}>Save</Text>
                  </Pressable>
                  <Pressable onPress={resetForm} style={styles.actionButton}>
                    <Text style={styles.actionButtonText}>Cancel</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <Pressable
                onPress={startAdd}
                style={styles.addButton}
                testID="add-server"
              >
                <Plus color={tokens["--text-primary"]} size={15} strokeWidth={1.5} />
                <Text style={styles.addButtonText}>Add server</Text>
              </Pressable>
            )}

            {onOpenOnDeviceSetup ? (
              <Pressable
                onPress={() => {
                  onClose();
                  onOpenOnDeviceSetup();
                }}
                style={styles.advancedButton}
                testID="open-on-device-from-servers"
              >
                <Text style={styles.advancedButtonText}>
                  Set up server on this phone
                </Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function createStyles(tokens: ThemeTokens) {
  const cardRadius = tokenNumber(tokens["--radius-card"], 10);
  const tabRadius = tokenNumber(tokens["--radius-tab"], 5);
  const card: ViewStyle = {
    backgroundColor: tokens["--bg-card"],
    borderColor: tokens["--border-card"],
    borderRadius: cardRadius,
    borderWidth: DESIGN_2_RECIPES.cards.borderWidth,
  };
  const bodyText: TextStyle = {
    color: tokens["--text-primary"],
    fontFamily: "sans-serif",
    fontSize: 13,
  };
  return StyleSheet.create({
    actionButton: {
      alignItems: "center",
      borderColor: tokens["--border-card"],
      borderRadius: tabRadius,
      borderWidth: DESIGN_2_RECIPES.cards.borderWidth,
      flexDirection: "row",
      gap: 5,
      justifyContent: "center",
      minHeight: 34,
      minWidth: "47%",
      paddingHorizontal: 10,
      paddingVertical: 7,
    },
    actionButtonText: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif",
      fontSize: 12,
    },
    actionDisabled: {
      opacity: 0.45,
    },
    activeCard: {
      ...card,
      gap: 2,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    activeLabel: {
      color: tokens["--text-disabled"],
      fontFamily: "sans-serif",
      fontSize: 10.5,
      fontWeight: "500",
      textTransform: "uppercase",
    },
    activeName: {
      ...bodyText,
      fontWeight: "600",
    },
    activeUrl: {
      color: tokens["--text-secondary"],
      fontFamily: "monospace",
      fontSize: 11,
    },
    addButton: {
      alignItems: "center",
      borderColor: tokens["--border-card"],
      borderRadius: tabRadius,
      borderStyle: "dashed",
      borderWidth: DESIGN_2_RECIPES.cards.borderWidth,
      flexDirection: "row",
      gap: 7,
      justifyContent: "center",
      minHeight: 42,
      paddingHorizontal: 12,
    },
    addButtonText: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif",
      fontSize: 13,
      fontWeight: "500",
    },
    advancedButton: {
      alignItems: "center",
      minHeight: 40,
      justifyContent: "center",
      paddingHorizontal: 8,
    },
    advancedButtonText: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif",
      fontSize: 12,
      textAlign: "center",
    },
    backdrop: {
      backgroundColor: tokens["--palette-backdrop"],
      flex: 1,
      justifyContent: "flex-end",
    },
    badge: {
      borderColor: tokens["--border-subtle"],
      borderRadius: 999,
      borderWidth: DESIGN_2_RECIPES.cards.borderWidth,
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif",
      fontSize: 10.5,
      overflow: "hidden",
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    badgeMuted: {
      borderColor: tokens["--border-subtle"],
      borderRadius: 999,
      borderWidth: DESIGN_2_RECIPES.cards.borderWidth,
      color: tokens["--text-disabled"],
      fontFamily: "sans-serif",
      fontSize: 10.5,
      overflow: "hidden",
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    content: {
      gap: 12,
      paddingBottom: 28,
      paddingHorizontal: 16,
    },
    form: {
      ...card,
      gap: 8,
      padding: 12,
    },
    formActions: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      marginTop: 2,
    },
    formError: {
      color: tokens["--debug-accent"],
      fontFamily: "sans-serif",
      fontSize: 12,
    },
    formTitle: {
      ...bodyText,
      fontWeight: "600",
    },
    header: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      padding: 16,
    },
    headerCopy: {
      flex: 1,
      gap: 3,
      paddingRight: 12,
    },
    iconButton: {
      alignItems: "center",
      borderRadius: 5,
      height: 28,
      justifyContent: "center",
      width: 28,
    },
    input: {
      ...bodyText,
      backgroundColor: tokens["--bg-main"],
      borderColor: tokens["--border-card"],
      borderRadius: tabRadius,
      borderWidth: DESIGN_2_RECIPES.cards.borderWidth,
      height: 40,
      paddingHorizontal: 11,
    },
    primaryButton: {
      alignItems: "center",
      backgroundColor: tokens["--accent"],
      borderRadius: tabRadius,
      flexGrow: 1,
      justifyContent: "center",
      minHeight: 40,
      minWidth: "47%",
      paddingHorizontal: 12,
    },
    primaryButtonText: {
      color: tokens["--bg-main"],
      fontFamily: "sans-serif",
      fontSize: 13,
      fontWeight: "600",
    },
    probeError: {
      color: tokens["--debug-accent"],
      fontFamily: "sans-serif",
      fontSize: 11,
      marginTop: 4,
    },
    probeOk: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif",
      fontSize: 11,
      marginTop: 4,
    },
    serverActions: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
    serverMeta: {
      gap: 2,
    },
    serverName: {
      ...bodyText,
      flexShrink: 1,
      fontWeight: "600",
    },
    serverRow: {
      borderBottomColor: tokens["--border-subtle"],
      borderBottomWidth: DESIGN_2_RECIPES.cards.borderWidth,
      gap: 10,
      paddingBottom: 12,
    },
    serverTitleRow: {
      alignItems: "center",
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
    },
    serverUrl: {
      color: tokens["--text-secondary"],
      fontFamily: "monospace",
      fontSize: 11,
    },
    sheet: {
      backgroundColor: tokens["--bg-panel"],
      borderTopLeftRadius: cardRadius + 4,
      borderTopRightRadius: cardRadius + 4,
      maxHeight: "88%",
    },
    subtitle: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif",
      fontSize: 12.5,
      lineHeight: 17,
    },
    title: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif",
      fontSize: 17,
      fontWeight: "600",
    },
  });
}
