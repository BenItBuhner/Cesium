import {
  ActivityIndicator,
  Appearance,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { ChevronLeft, X } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchCesiumAgentSettings,
  saveCesiumProviderKey,
  type CesiumProviderKind,
} from "@cesium/client";
import { useGlobalSettings, useServerConnections } from "@cesium/client/react";
import type { Design2ThemeTokens as ThemeTokens } from "@cesium/design";

type SettingsSection =
  | "home"
  | "servers"
  | "appearance"
  | "models"
  | "agents"
  | "server-setup";

export type NativeSettingsShellProps = {
  onClose: () => void;
  onOpenServerSetup: () => void;
  open: boolean;
  tokens: ThemeTokens;
};

export function NativeSettingsShell({
  onClose,
  onOpenServerSetup,
  open,
  tokens,
}: NativeSettingsShellProps) {
  const styles = useMemo(() => createStyles(tokens), [tokens]);
  const [section, setSection] = useState<SettingsSection>("home");

  useEffect(() => {
    if (!open) {
      setSection("home");
    }
  }, [open]);

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={open}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="native-settings-shell">
          <View style={styles.header}>
            {section !== "home" ? (
              <Pressable
                accessibilityLabel="Back"
                hitSlop={8}
                onPress={() => setSection("home")}
                style={styles.headerButton}
              >
                <ChevronLeft color={tokens["--text-primary"]} size={20} strokeWidth={1.5} />
              </Pressable>
            ) : (
              <View style={styles.headerButton} />
            )}
            <Text style={styles.title}>
              {section === "home"
                ? "Settings"
                : section === "servers"
                  ? "Servers"
                  : section === "appearance"
                    ? "Appearance"
                    : section === "models"
                      ? "Models"
                      : section === "agents"
                        ? "Cesium Agent"
                        : "Settings"}
            </Text>
            <Pressable
              accessibilityLabel="Close settings"
              hitSlop={8}
              onPress={onClose}
              style={styles.headerButton}
              testID="close-native-settings"
            >
              <X color={tokens["--text-primary"]} size={18} strokeWidth={1.5} />
            </Pressable>
          </View>

          {section === "home" ? (
            <ScrollView contentContainerStyle={styles.content}>
              <SettingsRow
                label="Servers"
                detail="Active and saved Cesium servers"
                onPress={() => setSection("servers")}
                styles={styles}
              />
              <SettingsRow
                label="Appearance"
                detail="Theme and density preferences"
                onPress={() => setSection("appearance")}
                styles={styles}
              />
              <SettingsRow
                label="Models"
                detail="Visible models per harness"
                onPress={() => setSection("models")}
                styles={styles}
              />
              <SettingsRow
                label="Cesium Agent"
                detail="Provider keys and default model"
                onPress={() => setSection("agents")}
                styles={styles}
              />
              <SettingsRow
                label="Server on this phone"
                detail="Optional Termux backend setup"
                onPress={() => {
                  onClose();
                  onOpenServerSetup();
                }}
                styles={styles}
                testID="settings-open-server-setup"
              />
            </ScrollView>
          ) : null}
          {section === "servers" ? <ServersPanel styles={styles} tokens={tokens} /> : null}
          {section === "appearance" ? <AppearancePanel styles={styles} tokens={tokens} /> : null}
          {section === "models" ? <ModelsPanel styles={styles} tokens={tokens} /> : null}
          {section === "agents" ? <AgentsPanel styles={styles} tokens={tokens} /> : null}
        </View>
      </View>
    </Modal>
  );
}

function SettingsRow({
  detail,
  label,
  onPress,
  styles,
  testID,
}: {
  detail: string;
  label: string;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
  testID?: string;
}) {
  return (
    <Pressable onPress={onPress} style={styles.row} testID={testID}>
      <View style={styles.rowTextWrap}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowDetail}>{detail}</Text>
      </View>
    </Pressable>
  );
}

function ServersPanel({
  styles,
  tokens,
}: {
  styles: ReturnType<typeof createStyles>;
  tokens: ThemeTokens;
}) {
  const {
    activeServer,
    probeServer,
    saveServer,
    servers,
    setActiveServer,
    setDefaultServer,
  } = useServerConnections();
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const addServer = useCallback(async () => {
    const nextUrl = baseUrl.trim();
    if (!nextUrl) {
      setStatus("Enter a server URL.");
      return;
    }
    setSaving(true);
    setStatus("Checking server...");
    try {
      const probe = await probeServer(nextUrl);
      if (!probe.ok) {
        setStatus(probe.error || "Server is not reachable.");
        return;
      }
      const saved = saveServer({
        label: label.trim() || nextUrl.replace(/^https?:\/\//, ""),
        baseUrl: nextUrl,
      });
      setActiveServer(saved.id);
      setDefaultServer(saved.id);
      setLabel("");
      setBaseUrl("");
      setStatus("Server saved and selected.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to save server.");
    } finally {
      setSaving(false);
    }
  }, [baseUrl, label, probeServer, saveServer, setActiveServer, setDefaultServer]);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {servers.map((server) => {
        const active = server.id === activeServer.id;
        return (
          <Pressable
            key={server.id}
            onPress={() => {
              setActiveServer(server.id);
              setDefaultServer(server.id);
            }}
            style={[styles.row, active ? styles.rowSelected : null]}
          >
            <View style={styles.rowTextWrap}>
              <Text style={styles.rowLabel}>{server.label}</Text>
              <Text style={styles.rowDetail}>{server.baseUrl}</Text>
            </View>
            {active ? <Text style={styles.badge}>Active</Text> : null}
          </Pressable>
        );
      })}
      <Text style={styles.sectionLabel}>Add server</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setLabel}
        placeholder="Label"
        placeholderTextColor={tokens["--text-secondary"]}
        style={styles.input}
        value={label}
      />
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setBaseUrl}
        placeholder="https://example.com:9100"
        placeholderTextColor={tokens["--text-secondary"]}
        style={styles.input}
        value={baseUrl}
      />
      <Pressable
        disabled={saving}
        onPress={() => void addServer()}
        style={styles.primaryButton}
        testID="settings-add-server"
      >
        {saving ? (
          <ActivityIndicator color={tokens["--bg-main"]} />
        ) : (
          <Text style={styles.primaryButtonText}>Save server</Text>
        )}
      </Pressable>
      {status ? <Text style={styles.status}>{status}</Text> : null}
    </ScrollView>
  );
}

function AppearancePanel({
  styles,
  tokens,
}: {
  styles: ReturnType<typeof createStyles>;
  tokens: ThemeTokens;
}) {
  const { settings, updateSettings } = useGlobalSettings();
  const theme = settings.themeConfig.appearance;

  const setTheme = useCallback(
    (value: "system" | "light" | "dark") => {
      updateSettings((current) => ({
        ...current,
        themeConfig: {
          ...current.themeConfig,
          appearance: value,
        },
      }));
      Appearance.setColorScheme(value === "system" ? "unspecified" : value);
    },
    [updateSettings]
  );

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {(["system", "light", "dark"] as const).map((value) => (
        <Pressable
          key={value}
          onPress={() => setTheme(value)}
          style={[styles.row, theme === value ? styles.rowSelected : null]}
        >
          <Text style={styles.rowLabel}>
            {value === "system" ? "System" : value === "light" ? "Light" : "Dark"}
          </Text>
        </Pressable>
      ))}
      <View style={styles.switchRow}>
        <Text style={styles.rowLabel}>Collapse long pastes</Text>
        <Switch
          onValueChange={(next) =>
            updateSettings((current) => ({
              ...current,
              themeConfig: {
                ...current.themeConfig,
                longPasteReferencesEnabled: next,
              },
            }))
          }
          trackColor={{
            false: tokens["--border-subtle"],
            true: tokens["--text-secondary"],
          }}
          value={settings.themeConfig.longPasteReferencesEnabled}
        />
      </View>
    </ScrollView>
  );
}

function ModelsPanel({
  styles,
  tokens,
}: {
  styles: ReturnType<typeof createStyles>;
  tokens: ThemeTokens;
}) {
  const { modelsRefreshing, refreshModels, saveModelToggleUpdates, settings } =
    useGlobalSettings();
  const backends = Object.entries(settings.models.byBackend);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Pressable
        onPress={() => void refreshModels()}
        style={styles.secondaryButton}
        testID="settings-refresh-models"
      >
        {modelsRefreshing ? (
          <ActivityIndicator color={tokens["--text-primary"]} />
        ) : (
          <Text style={styles.secondaryButtonText}>Refresh models</Text>
        )}
      </Pressable>
      {backends.length === 0 ? (
        <Text style={styles.status}>No model catalog loaded yet. Refresh after connecting.</Text>
      ) : (
        backends.map(([backendId, toggles]) => (
          <View key={backendId} style={styles.group}>
            <Text style={styles.sectionLabel}>{backendId}</Text>
            {toggles.map((toggle) => (
              <View key={toggle.id} style={styles.switchRow}>
                <Text style={styles.rowLabel}>{toggle.name}</Text>
                <Switch
                  onValueChange={(on) => {
                    void saveModelToggleUpdates([{ backendId, modelId: toggle.id, on }]);
                  }}
                  trackColor={{
                    false: tokens["--border-subtle"],
                    true: tokens["--text-secondary"],
                  }}
                  value={toggle.on}
                />
              </View>
            ))}
          </View>
        ))
      )}
    </ScrollView>
  );
}

function AgentsPanel({
  styles,
  tokens,
}: {
  styles: ReturnType<typeof createStyles>;
  tokens: ThemeTokens;
}) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [apiKind, setApiKind] = useState<CesiumProviderKind>("openai-compatible");
  const [defaultModelId, setDefaultModelId] = useState("");
  const [configured, setConfigured] = useState(false);
  const [providerCount, setProviderCount] = useState(0);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchCesiumAgentSettings();
      setConfigured(result.settings.configured);
      setDefaultModelId(result.settings.defaultModelId);
      setProviderCount(result.settings.providerKeys.length);
      setStatus(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to load agent settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const saveKey = useCallback(async () => {
    if (!apiKey.trim()) {
      setStatus("Paste an API key first.");
      return;
    }
    setLoading(true);
    try {
      await saveCesiumProviderKey({
        providerId: apiKind === "anthropic" ? "anthropic" : apiKind === "google-genai" ? "google" : "openai",
        apiKind,
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim() || undefined,
        label: "Mobile",
      });
      setApiKey("");
      setStatus("Provider key saved.");
      await reload();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to save provider key.");
      setLoading(false);
    }
  }, [apiKey, apiKind, baseUrl, reload]);

  if (loading && providerCount === 0 && !configured) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator color={tokens["--text-secondary"]} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.status}>
        {configured
          ? `Configured · ${providerCount} provider key${providerCount === 1 ? "" : "s"}`
          : "Not configured yet"}
      </Text>
      <Text style={styles.sectionLabel}>Default model id</Text>
      <Text style={styles.rowDetail}>{defaultModelId || "—"}</Text>
      <Text style={styles.sectionLabel}>Add OpenAI-compatible key</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setBaseUrl}
        placeholder="Base URL"
        placeholderTextColor={tokens["--text-secondary"]}
        style={styles.input}
        value={baseUrl}
      />
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setApiKey}
        placeholder="API key"
        placeholderTextColor={tokens["--text-secondary"]}
        secureTextEntry
        style={styles.input}
        value={apiKey}
      />
      <View style={styles.kindRow}>
        {(
          [
            ["openai-compatible", "Compatible"],
            ["openai-chat-completions", "Chat"],
            ["anthropic", "Anthropic"],
            ["google-genai", "Google"],
          ] as const
        ).map(([value, label]) => (
          <Pressable
            key={value}
            onPress={() => setApiKind(value)}
            style={[styles.kindChip, apiKind === value ? styles.rowSelected : null]}
          >
            <Text style={styles.kindChipText}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable
        disabled={loading}
        onPress={() => void saveKey()}
        style={styles.primaryButton}
        testID="settings-save-provider-key"
      >
        <Text style={styles.primaryButtonText}>Save provider key</Text>
      </Pressable>
      {status ? <Text style={styles.status}>{status}</Text> : null}
    </ScrollView>
  );
}

function createStyles(tokens: ThemeTokens) {
  return StyleSheet.create({
    backdrop: {
      backgroundColor: "rgba(0,0,0,0.45)",
      flex: 1,
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: tokens["--bg-main"],
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      maxHeight: "92%",
      minHeight: "70%",
      paddingBottom: 20,
    },
    header: {
      alignItems: "center",
      borderBottomColor: tokens["--border-subtle"],
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingHorizontal: 12,
      paddingVertical: 12,
    },
    headerButton: {
      alignItems: "center",
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    title: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif-medium",
      fontSize: 17,
    },
    content: {
      gap: 8,
      padding: 16,
    },
    row: {
      backgroundColor: tokens["--bg-card"],
      borderRadius: 12,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 14,
      paddingVertical: 14,
    },
    rowSelected: {
      borderColor: tokens["--text-secondary"],
      borderWidth: StyleSheet.hairlineWidth,
    },
    rowTextWrap: {
      flex: 1,
      gap: 2,
    },
    rowLabel: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif-medium",
      fontSize: 15,
    },
    rowDetail: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif",
      fontSize: 12,
    },
    badge: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif-medium",
      fontSize: 11,
      marginLeft: 8,
    },
    sectionLabel: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif-medium",
      fontSize: 12,
      marginTop: 8,
      textTransform: "uppercase",
    },
    input: {
      backgroundColor: tokens["--bg-card"],
      borderRadius: 10,
      color: tokens["--text-primary"],
      fontFamily: "sans-serif",
      fontSize: 14,
      paddingHorizontal: 12,
      paddingVertical: 12,
    },
    primaryButton: {
      alignItems: "center",
      backgroundColor: tokens["--text-primary"],
      borderRadius: 12,
      justifyContent: "center",
      minHeight: 44,
      paddingHorizontal: 14,
    },
    primaryButtonText: {
      color: tokens["--bg-main"],
      fontFamily: "sans-serif-medium",
      fontSize: 14,
    },
    secondaryButton: {
      alignItems: "center",
      backgroundColor: tokens["--bg-card"],
      borderRadius: 12,
      justifyContent: "center",
      minHeight: 40,
      paddingHorizontal: 14,
    },
    secondaryButtonText: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif-medium",
      fontSize: 14,
    },
    status: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif",
      fontSize: 13,
    },
    switchRow: {
      alignItems: "center",
      backgroundColor: tokens["--bg-card"],
      borderRadius: 12,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    group: {
      gap: 8,
    },
    loadingWrap: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
      padding: 24,
    },
    kindRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
    kindChip: {
      backgroundColor: tokens["--bg-card"],
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    kindChipText: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif",
      fontSize: 12,
    },
  });
}
