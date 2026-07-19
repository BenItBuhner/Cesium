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
import {
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Palette,
  Server,
  Smartphone,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
            <Pressable
              accessibilityLabel={section === "home" ? "Close settings" : "Back to settings"}
              hitSlop={8}
              onPress={section === "home" ? onClose : () => setSection("home")}
              style={styles.headerButton}
              testID={section === "home" ? "close-native-settings" : "settings-back-home"}
            >
              <ChevronLeft color={tokens["--text-primary"]} size={22} strokeWidth={1.7} />
            </Pressable>
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
            <View style={styles.headerButton} />
          </View>

          {section === "home" ? (
            <SettingsHome
              onOpenAppearance={() => setSection("appearance")}
              onOpenAgents={() => setSection("agents")}
              onOpenModels={() => setSection("models")}
              onOpenServers={() => setSection("servers")}
              onOpenServerSetup={() => {
                onClose();
                onOpenServerSetup();
              }}
              styles={styles}
              tokens={tokens}
            />
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

function SettingsHome({
  onOpenAppearance,
  onOpenAgents,
  onOpenModels,
  onOpenServers,
  onOpenServerSetup,
  styles,
  tokens,
}: {
  onOpenAppearance: () => void;
  onOpenAgents: () => void;
  onOpenModels: () => void;
  onOpenServers: () => void;
  onOpenServerSetup: () => void;
  styles: ReturnType<typeof createStyles>;
  tokens: ThemeTokens;
}) {
  const { activeServer } = useServerConnections();
  const { settings } = useGlobalSettings();
  const modelCount = Object.values(settings.models.byBackend).reduce(
    (total, models) => total + models.filter((model) => model.on).length,
    0
  );
  const theme = settings.themeConfig.appearance;
  const themeLabel = theme === "system" ? "System" : theme === "light" ? "Light" : "Dark";
  const iconColor = tokens["--text-primary"];

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <SettingsGroup label="Workspace" styles={styles}>
        <NavigationRow
          detail={activeServer.label}
          icon={<Server color={iconColor} size={19} strokeWidth={1.6} />}
          label="Servers"
          onPress={onOpenServers}
          styles={styles}
          testID="settings-nav-servers"
        />
      </SettingsGroup>

      <SettingsGroup label="AI configuration" styles={styles}>
        <NavigationRow
          detail="Provider keys and default model"
          icon={<Bot color={iconColor} size={19} strokeWidth={1.6} />}
          label="Cesium Agent"
          onPress={onOpenAgents}
          styles={styles}
          testID="settings-nav-agents"
        />
        <NavigationRow
          detail={`${modelCount} visible model${modelCount === 1 ? "" : "s"}`}
          icon={<Cpu color={iconColor} size={19} strokeWidth={1.6} />}
          label="Models"
          last
          onPress={onOpenModels}
          styles={styles}
          testID="settings-nav-models"
        />
      </SettingsGroup>

      <SettingsGroup label="Preferences" styles={styles}>
        <NavigationRow
          detail={`${themeLabel} theme`}
          icon={<Palette color={iconColor} size={19} strokeWidth={1.6} />}
          label="Appearance"
          last
          onPress={onOpenAppearance}
          styles={styles}
          testID="settings-nav-appearance"
        />
      </SettingsGroup>

      <SettingsGroup label="On this device" styles={styles}>
        <NavigationRow
          detail="Optional Termux backend"
          icon={<Smartphone color={iconColor} size={19} strokeWidth={1.6} />}
          label="Server on this phone"
          last
          onPress={onOpenServerSetup}
          styles={styles}
          testID="settings-open-server-setup"
        />
      </SettingsGroup>
    </ScrollView>
  );
}

function SettingsGroup({
  children,
  label,
  styles,
}: {
  children: ReactNode;
  label: string;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <View style={styles.groupCard}>{children}</View>
    </View>
  );
}

function NavigationRow({
  detail,
  icon,
  label,
  last = false,
  onPress,
  styles,
  testID,
}: {
  detail: string;
  icon: ReactNode;
  label: string;
  last?: boolean;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.navigationRow, last ? null : styles.rowDivider]}
      testID={testID}
    >
      <View style={styles.iconWrap}>{icon}</View>
      <View style={styles.rowTextWrap}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowDetail}>{detail}</Text>
      </View>
      <ChevronRight color={styles.chevron.color} size={18} strokeWidth={1.6} />
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
      <SettingsGroup label="Saved servers" styles={styles}>
        {servers.map((server, index) => {
          const active = server.id === activeServer.id;
          return (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              key={server.id}
              onPress={() => {
                setActiveServer(server.id);
                setDefaultServer(server.id);
              }}
              style={[
                styles.listRow,
                index < servers.length - 1 ? styles.rowDivider : null,
                active ? styles.listRowSelected : null,
              ]}
            >
              <View style={styles.rowTextWrap}>
                <Text style={styles.rowLabel}>{server.label}</Text>
                <Text numberOfLines={1} style={styles.rowDetail}>
                  {server.baseUrl}
                </Text>
              </View>
              {active ? (
                <View style={styles.activeBadge}>
                  <Check color={tokens["--text-primary"]} size={13} strokeWidth={2} />
                  <Text style={styles.badge}>Active</Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </SettingsGroup>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Add server</Text>
        <View style={styles.formCard}>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setLabel}
            placeholder="Name (optional)"
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
            style={({ pressed }) => [
              styles.primaryButton,
              pressed ? styles.buttonPressed : null,
              saving ? styles.buttonDisabled : null,
            ]}
            testID="settings-add-server"
          >
            {saving ? (
              <ActivityIndicator color={tokens["--bg-main"]} />
            ) : (
              <Text style={styles.primaryButtonText}>Check and save</Text>
            )}
          </Pressable>
        </View>
        {status ? <Text style={styles.status}>{status}</Text> : null}
      </View>
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
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Theme</Text>
        <View accessibilityRole="radiogroup" style={styles.segmentedControl}>
          {(["system", "light", "dark"] as const).map((value) => {
            const selected = theme === value;
            const label = value === "system" ? "System" : value === "light" ? "Light" : "Dark";
            return (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                key={value}
                onPress={() => setTheme(value)}
                style={[styles.segment, selected ? styles.segmentSelected : null]}
                testID={`settings-theme-${value}`}
              >
                <Text style={[styles.segmentText, selected ? styles.segmentTextSelected : null]}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.sectionHint}>
          System follows your device and changes automatically.
        </Text>
      </View>

      <SettingsGroup label="Chat" styles={styles}>
        <View style={styles.preferenceRow}>
          <View style={styles.rowTextWrap}>
            <Text style={styles.rowLabel}>Collapse long pastes</Text>
            <Text style={styles.rowDetail}>Show large pasted content as a compact reference</Text>
          </View>
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
      </SettingsGroup>
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
        style={({ pressed }) => [styles.secondaryButton, pressed ? styles.buttonPressed : null]}
        testID="settings-refresh-models"
      >
        {modelsRefreshing ? (
          <ActivityIndicator color={tokens["--text-primary"]} />
        ) : (
          <Text style={styles.secondaryButtonText}>Refresh models</Text>
        )}
      </Pressable>
      {backends.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No models yet</Text>
          <Text style={styles.status}>Connect to a server, then refresh the model catalog.</Text>
        </View>
      ) : (
        backends.map(([backendId, toggles]) => (
          <SettingsGroup key={backendId} label={backendId} styles={styles}>
            {toggles.map((toggle, index) => (
              <View
                key={toggle.id}
                style={[
                  styles.preferenceRow,
                  index < toggles.length - 1 ? styles.rowDivider : null,
                ]}
              >
                <View style={styles.rowTextWrap}>
                  <Text style={styles.rowLabel}>{toggle.name}</Text>
                  <Text numberOfLines={1} style={styles.rowDetail}>
                    {toggle.id}
                  </Text>
                </View>
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
          </SettingsGroup>
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
      <SettingsGroup label="Overview" styles={styles}>
        <View style={[styles.preferenceRow, styles.rowDivider]}>
          <View style={styles.rowTextWrap}>
            <Text style={styles.rowLabel}>Provider status</Text>
            <Text style={styles.rowDetail}>
              {configured
                ? `${providerCount} saved key${providerCount === 1 ? "" : "s"}`
                : "No provider configured"}
            </Text>
          </View>
          <View style={[styles.statusDot, configured ? styles.statusDotActive : null]} />
        </View>
        <View style={styles.preferenceRow}>
          <View style={styles.rowTextWrap}>
            <Text style={styles.rowLabel}>Default model</Text>
            <Text numberOfLines={1} style={styles.rowDetail}>
              {defaultModelId || "Not selected"}
            </Text>
          </View>
        </View>
      </SettingsGroup>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Add provider</Text>
        <View style={styles.formCard}>
          <Text style={styles.fieldLabel}>Provider type</Text>
          <View style={styles.kindRow}>
            {(
              [
                ["openai-compatible", "Compatible"],
                ["openai-chat-completions", "OpenAI"],
                ["anthropic", "Anthropic"],
                ["google-genai", "Google"],
              ] as const
            ).map(([value, label]) => {
              const selected = apiKind === value;
              return (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  key={value}
                  onPress={() => setApiKind(value)}
                  style={[styles.kindChip, selected ? styles.kindChipSelected : null]}
                >
                  <Text
                    style={[styles.kindChipText, selected ? styles.kindChipTextSelected : null]}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {apiKind === "openai-compatible" || apiKind === "openai-chat-completions" ? (
            <>
              <Text style={styles.fieldLabel}>Base URL</Text>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={setBaseUrl}
                placeholder="https://api.openai.com/v1"
                placeholderTextColor={tokens["--text-secondary"]}
                style={styles.input}
                value={baseUrl}
              />
            </>
          ) : null}
          <Text style={styles.fieldLabel}>API key</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setApiKey}
            placeholder="Paste a provider key"
            placeholderTextColor={tokens["--text-secondary"]}
            secureTextEntry
            style={styles.input}
            value={apiKey}
          />
          <Pressable
            disabled={loading}
            onPress={() => void saveKey()}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed ? styles.buttonPressed : null,
              loading ? styles.buttonDisabled : null,
            ]}
            testID="settings-save-provider-key"
          >
            <Text style={styles.primaryButtonText}>Save provider</Text>
          </Pressable>
        </View>
        {status ? <Text style={styles.status}>{status}</Text> : null}
      </View>
    </ScrollView>
  );
}

function createStyles(tokens: ThemeTokens) {
  return StyleSheet.create({
    backdrop: {
      backgroundColor: tokens["--bg-main"],
      flex: 1,
    },
    sheet: {
      backgroundColor: tokens["--bg-main"],
      flex: 1,
    },
    header: {
      alignItems: "center",
      borderBottomColor: tokens["--border-subtle"],
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      justifyContent: "space-between",
      minHeight: 56,
      paddingHorizontal: 8,
    },
    headerButton: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    title: {
      color: tokens["--text-primary"],
      flex: 1,
      fontFamily: "sans-serif-medium",
      fontSize: 18,
      textAlign: "left",
    },
    content: {
      gap: 22,
      padding: 16,
      paddingBottom: 40,
    },
    section: {
      gap: 8,
    },
    sectionLabel: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif-medium",
      fontSize: 12,
      letterSpacing: 0.2,
      paddingHorizontal: 4,
    },
    groupCard: {
      backgroundColor: tokens["--bg-card"],
      borderColor: tokens["--border-subtle"],
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: "hidden",
    },
    navigationRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      minHeight: 68,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    rowDivider: {
      borderBottomColor: tokens["--border-subtle"],
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    iconWrap: {
      alignItems: "center",
      backgroundColor: tokens["--accent-bg"],
      borderRadius: 10,
      height: 36,
      justifyContent: "center",
      width: 36,
    },
    rowTextWrap: {
      flex: 1,
      gap: 2,
    },
    rowLabel: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif-medium",
      fontSize: 14,
    },
    rowDetail: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif",
      fontSize: 12,
      lineHeight: 17,
    },
    chevron: {
      color: tokens["--text-disabled"],
    },
    badge: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif-medium",
      fontSize: 11,
    },
    activeBadge: {
      alignItems: "center",
      backgroundColor: tokens["--accent-bg"],
      borderRadius: 999,
      flexDirection: "row",
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 5,
    },
    listRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      justifyContent: "space-between",
      minHeight: 62,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    listRowSelected: {
      backgroundColor: tokens["--accent-bg"],
    },
    preferenceRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 16,
      justifyContent: "space-between",
      minHeight: 60,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    formCard: {
      backgroundColor: tokens["--bg-card"],
      borderColor: tokens["--border-subtle"],
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      gap: 10,
      padding: 12,
    },
    fieldLabel: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif-medium",
      fontSize: 12,
      marginTop: 2,
    },
    input: {
      backgroundColor: tokens["--bg-main"],
      borderColor: tokens["--border-subtle"],
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      color: tokens["--text-primary"],
      fontFamily: "sans-serif",
      fontSize: 14,
      minHeight: 46,
      paddingHorizontal: 12,
      paddingVertical: 10,
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
    buttonPressed: {
      opacity: 0.78,
    },
    buttonDisabled: {
      opacity: 0.5,
    },
    secondaryButton: {
      alignItems: "center",
      backgroundColor: tokens["--bg-card"],
      borderColor: tokens["--border-subtle"],
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      justifyContent: "center",
      minHeight: 44,
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
      lineHeight: 18,
      paddingHorizontal: 4,
    },
    emptyCard: {
      backgroundColor: tokens["--bg-card"],
      borderColor: tokens["--border-subtle"],
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      gap: 4,
      padding: 18,
    },
    emptyTitle: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif-medium",
      fontSize: 15,
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
      backgroundColor: tokens["--bg-main"],
      borderColor: tokens["--border-subtle"],
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    kindChipSelected: {
      backgroundColor: tokens["--text-primary"],
      borderColor: tokens["--text-primary"],
    },
    kindChipText: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif",
      fontSize: 12,
    },
    kindChipTextSelected: {
      color: tokens["--bg-main"],
      fontFamily: "sans-serif-medium",
    },
    segmentedControl: {
      backgroundColor: tokens["--bg-card"],
      borderColor: tokens["--border-subtle"],
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 3,
      padding: 3,
    },
    segment: {
      alignItems: "center",
      borderRadius: 9,
      flex: 1,
      minHeight: 38,
      justifyContent: "center",
      paddingHorizontal: 10,
    },
    segmentSelected: {
      backgroundColor: tokens["--text-primary"],
    },
    segmentText: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif",
      fontSize: 13,
    },
    segmentTextSelected: {
      color: tokens["--bg-main"],
      fontFamily: "sans-serif-medium",
    },
    sectionHint: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif",
      fontSize: 12,
      lineHeight: 17,
      paddingHorizontal: 4,
    },
    statusDot: {
      backgroundColor: tokens["--text-disabled"],
      borderRadius: 5,
      height: 10,
      width: 10,
    },
    statusDotActive: {
      backgroundColor: tokens["--accent"],
    },
  });
}
