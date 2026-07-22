import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ColorValue,
} from "react-native";
import {
  ArrowUp,
  Boxes,
  Bug,
  ChevronDown,
  Flame,
  ListChecks,
  MessageCircleQuestion,
  Mic,
  Plus,
  Square,
  Workflow,
  X,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConfigOption,
  AgentConversationRecord,
  AgentModeOption,
  ImageAttachment,
  ImageAttachmentState,
  ModelInfo,
  SlashMenuItem,
  SlashMenuSection,
} from "@cesium/core";
import {
  applyComposerDirectives,
  filterSlashMenuSectionsForDisplay,
  getActiveSlashQuery,
  getSlashMenuSections,
} from "@cesium/core";
import {
  DESIGN_2_MODE_RECIPES,
  DESIGN_2_RECIPES,
  resolveDesign2ComposerLayout,
  resolveDesign2ModeTone,
  type Design2ModeTone,
  type Design2ThemeTokens as ThemeTokens,
} from "@cesium/design";
import { pickNativeImageAttachments } from "./native-media";

type IconComponent = ComponentType<{
  color?: ColorValue;
  size?: number;
  strokeWidth?: number;
}>;

const MODE_ICONS: Record<Design2ModeTone, IconComponent> = {
  agent: Workflow,
  plan: ListChecks,
  debug: Bug,
  ask: MessageCircleQuestion,
  goal: Flame,
  workflow: Workflow,
  orchestration: Boxes,
};

function modeToken(tokens: ThemeTokens, token: string): string {
  return tokens[token as keyof ThemeTokens] ?? tokens["--text-primary"];
}

export type NativeComposerSubmitConfig = {
  backendId?: AgentBackendId;
  mode?: string;
  model?: ModelInfo | null;
  setConfigOptions?: Array<{ configId: string; value: string }>;
};

export type NativeComposerSubmitPayload = {
  text: string;
  attachments: ImageAttachment[];
  /** Config resolved from slash directives in this submit (overrides parent draft state). */
  config?: NativeComposerSubmitConfig;
};

export type NativeComposerProps = {
  backend: AgentBackendInfo | null;
  backends: AgentBackendInfo[];
  busy: boolean;
  conversation: AgentConversationRecord | null;
  mode: string;
  modeOptions: AgentModeOption[];
  model: ModelInfo | null;
  models: ModelInfo[];
  onBackendChange: (backendId: AgentBackendId) => void;
  onCancel?: () => void;
  onModeChange: (modeId: string) => void;
  onModelChange: (model: ModelInfo) => void;
  onSessionConfigOptionChange?: (configId: string, value: string) => void;
  onSubmit: (payload: NativeComposerSubmitPayload) => Promise<boolean>;
  sessionConfigOptions?: AgentConfigOption[];
  tokens: ThemeTokens;
};

export function NativeComposer({
  backend,
  backends,
  busy,
  conversation,
  mode,
  modeOptions,
  model,
  models,
  onBackendChange,
  onCancel,
  onModeChange,
  onModelChange,
  onSessionConfigOptionChange,
  onSubmit,
  sessionConfigOptions,
  tokens,
}: NativeComposerProps) {
  const styles = useMemo(() => createComposerStyles(tokens), [tokens]);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ImageAttachmentState[]>([]);
  const [measuredMultiline, setMeasuredMultiline] = useState(false);
  const [multilineLatch, setMultilineLatch] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [picker, setPicker] = useState<"model" | "mode" | "slash" | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [pendingSetConfigOptions, setPendingSetConfigOptions] = useState<
    Array<{ configId: string; value: string }>
  >([]);

  const layout = resolveDesign2ComposerLayout({
    measuredMultiline,
    latchedMultiline: multilineLatch,
    hasAttachments: attachments.length > 0,
    value: text,
  });
  const tone = resolveDesign2ModeTone(mode);
  const modeRecipe = DESIGN_2_MODE_RECIPES[tone];
  const ModeIcon = MODE_ICONS[tone];
  const canSubmit =
    (text.trim().length > 0 || attachments.some((image) => image.data.length > 0)) &&
    !submitting;

  useEffect(() => {
    if (!text && attachments.length === 0) {
      setMeasuredMultiline(false);
      setMultilineLatch(false);
      return;
    }
    if (measuredMultiline) {
      setMultilineLatch(true);
    }
  }, [attachments.length, measuredMultiline, text]);

  useEffect(() => {
    const query = getActiveSlashQuery(text);
    setSlashQuery(query);
    if (query != null) {
      setPicker("slash");
    } else if (picker === "slash") {
      setPicker(null);
    }
  }, [picker, text]);

  const slashSections = useMemo(() => {
    const sections = getSlashMenuSections({
      activeBackend: backend,
      backends,
      modeOptions,
      models,
      sessionConfigOptions,
      gitSlashCommands: true,
    });
    return filterSlashMenuSectionsForDisplay(sections, slashQuery ?? "").sections;
  }, [backend, backends, modeOptions, models, sessionConfigOptions, slashQuery]);

  const applySlashItem = useCallback(
    (item: SlashMenuItem) => {
      const action = item.action;
      if (action.kind === "mode") {
        onModeChange(action.modeId);
      } else if (action.kind === "model") {
        onModelChange(action.model);
      } else if (action.kind === "backend") {
        onBackendChange(action.backendId);
      } else if (action.kind === "config") {
        // Queue for the next submit so a fast select-and-send cannot race an
        // async PATCH on an existing conversation.
        setPendingSetConfigOptions((current) => {
          const without = current.filter((entry) => entry.configId !== action.configId);
          return [...without, { configId: action.configId, value: action.value }];
        });
      } else if (action.kind === "insert") {
        setText(action.insert);
        setPicker(null);
        return;
      }
      // Consume the leading slash token after applying a selection.
      setText((current) => {
        const lineStart = current.lastIndexOf("\n") + 1;
        const before = current.slice(0, lineStart);
        const afterLine = current.slice(lineStart);
        const rest = afterLine.replace(/^\/\S*(?:\s+\S*)?/, "").trimStart();
        return `${before}${rest}`;
      });
      setPicker(null);
    },
    [onBackendChange, onModeChange, onModelChange]
  );

  const submit = useCallback(async () => {
    if (busy) {
      onCancel?.();
      return;
    }
    if (!canSubmit || submitting) {
      return;
    }
    const imagesToSubmit: ImageAttachment[] = attachments
      .filter((image) => image.data.length > 0)
      .map(({ mimeType, data, name }) => ({ mimeType, data, name }));

    let nextMode = mode;
    let nextModel = model;
    let nextBackendId = backend?.id ?? null;
    let explicitModel = false;
    let explicitMode = false;
    const setConfigOptions: Array<{ configId: string; value: string }> = [
      ...pendingSetConfigOptions,
    ];
    // Resolve directives into the submit payload only. Do not call the normal
    // config-change handlers here — on an existing conversation those fire
    // async PATCHes (and backend switches reset mode/model) that race the
    // prompt's configOverride.
    const directed = applyComposerDirectives(text.trim(), {
      modeOptions,
      models,
      backends,
      sessionConfigOptions,
      onModeChange: (modeId) => {
        nextMode = modeId;
        explicitMode = true;
      },
      onModelChange: (selected) => {
        nextModel = selected;
        explicitModel = true;
      },
      onBackendChange: (backendId) => {
        nextBackendId = backendId;
        const nextBackend = backends.find((candidate) => candidate.id === backendId);
        if (nextBackend) {
          if (!explicitModel) {
            nextModel = null;
          }
          if (!explicitMode) {
            nextMode = nextBackend.defaultMode;
          }
        }
      },
      onSessionConfigOptionChange: (configId, value) => {
        const without = setConfigOptions.filter((entry) => entry.configId !== configId);
        setConfigOptions.length = 0;
        setConfigOptions.push(...without, { configId, value });
      },
    });

    if (!directed && imagesToSubmit.length === 0) {
      setText("");
      return;
    }

    setSubmitting(true);
    try {
      const ok = await onSubmit({
        text: directed,
        attachments: imagesToSubmit,
        config: {
          backendId: nextBackendId ?? undefined,
          mode: nextMode,
          model: nextModel,
          setConfigOptions: setConfigOptions.length > 0 ? setConfigOptions : undefined,
        },
      });
      if (ok) {
        // Sync draft landing state only after a successful new-chat create.
        if (!conversation) {
          if (nextBackendId && nextBackendId !== backend?.id) {
            onBackendChange(nextBackendId);
          }
          if (explicitMode) {
            onModeChange(nextMode);
          }
          if (explicitModel && nextModel) {
            onModelChange(nextModel);
          }
        }
        setText("");
        setAttachments([]);
        setAttachError(null);
        setPendingSetConfigOptions([]);
        setPicker(null);
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    attachments,
    backend?.id,
    backends,
    busy,
    canSubmit,
    conversation,
    mode,
    modeOptions,
    model,
    models,
    onBackendChange,
    onCancel,
    onModeChange,
    onModelChange,
    onSubmit,
    pendingSetConfigOptions,
    sessionConfigOptions,
    submitting,
    text,
  ]);

  const attachImages = useCallback(async () => {
    setAttachError(null);
    try {
      const picked = await pickNativeImageAttachments({
        allowMultiple: true,
        existingCount: attachments.length,
      });
      if (picked.length === 0) {
        return;
      }
      setAttachments((current) => [...current, ...picked].slice(0, 10));
    } catch (error) {
      setAttachError(
        error instanceof Error ? error.message : "Could not attach the selected images."
      );
    }
  }, [attachments.length]);

  const removeAttachment = useCallback((localId: string) => {
    setAttachments((current) => current.filter((image) => image.localId !== localId));
  }, []);

  const modelLabel = model?.name || conversation?.config.modelName || backend?.defaultModelName || "Select model";

  const plusButton = (
    <Pressable
      accessibilityLabel="Attach media"
      hitSlop={6}
      onPress={() => void attachImages()}
      style={styles.composerPlusButton}
      testID="native-chat-attach"
    >
      <Plus
        color={tokens["--agent-plus-button-icon"]}
        size={DESIGN_2_RECIPES.composer.plusIconSize}
        strokeWidth={2}
      />
    </Pressable>
  );

  const modeChip = (
    <Pressable
      accessibilityLabel={`Mode ${modeRecipe.label}`}
      onPress={() => setPicker("mode")}
      style={[
        styles.composerModeChip,
        {
          backgroundColor: modeRecipe.hiddenWhenDefault
            ? tokens["--bg-card"]
            : modeToken(tokens, modeRecipe.backgroundToken),
        },
      ]}
      testID="native-chat-mode"
    >
      <ModeIcon
        color={
          modeRecipe.hiddenWhenDefault
            ? tokens["--text-secondary"]
            : modeToken(tokens, modeRecipe.textToken)
        }
        size={13}
        strokeWidth={1.5}
      />
      {!modeRecipe.hiddenWhenDefault ? (
        <Text
          style={[
            styles.composerModeChipText,
            { color: modeToken(tokens, modeRecipe.textToken) },
          ]}
        >
          {modeRecipe.label}
        </Text>
      ) : null}
      <ChevronDown
        color={
          modeRecipe.hiddenWhenDefault
            ? tokens["--text-secondary"]
            : modeToken(tokens, modeRecipe.textToken)
        }
        size={9}
        strokeWidth={2}
      />
    </Pressable>
  );

  const modelPill = (
    <Pressable
      accessibilityLabel="Select model"
      onPress={() => setPicker("model")}
      style={styles.modelButton}
      testID="native-chat-model"
    >
      <Text numberOfLines={1} style={styles.modelText}>
        {modelLabel}
      </Text>
      <ChevronDown color={tokens["--text-secondary"]} size={10} strokeWidth={1.5} />
    </Pressable>
  );

  const primaryControl = (
    <Pressable
      accessibilityLabel={busy ? "Stop" : canSubmit ? "Send" : "Voice input"}
      disabled={!busy && !canSubmit}
      onPress={() => void submit()}
      style={[
        styles.sendButton,
        { backgroundColor: modeToken(tokens, modeRecipe.sendToken) },
        !busy && !canSubmit ? styles.sendButtonDisabled : null,
      ]}
      testID="native-chat-send"
    >
      {busy ? (
        <Square color={tokens["--bg-main"]} fill="currentColor" size={9} strokeWidth={2.2} />
      ) : submitting ? (
        <ActivityIndicator color={tokens["--bg-main"]} size="small" />
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
      blurOnSubmit={false}
      multiline
      onChangeText={setText}
      onContentSizeChange={(event) => {
        setMeasuredMultiline(
          event.nativeEvent.contentSize.height > DESIGN_2_RECIPES.composer.multilineThreshold
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

  const attachmentStrip =
    attachments.length > 0 ? (
      <ScrollView
        horizontal
        contentContainerStyle={styles.attachmentStrip}
        showsHorizontalScrollIndicator={false}
      >
        {attachments.map((image) => (
          <View key={image.localId} style={styles.attachmentChip}>
            <Image
              source={{ uri: `data:${image.mimeType};base64,${image.data}` }}
              style={styles.attachmentThumb}
            />
            <Pressable
              accessibilityLabel="Remove attachment"
              hitSlop={8}
              onPress={() => removeAttachment(image.localId)}
              style={styles.attachmentRemove}
            >
              <X color={tokens["--bg-main"]} size={10} strokeWidth={2} />
            </Pressable>
          </View>
        ))}
      </ScrollView>
    ) : null;

  return (
    <View style={styles.composerWrap} testID="native-chat-composer">
      {attachError ? <Text style={styles.errorText}>{attachError}</Text> : null}
      {attachmentStrip}
      <View style={[styles.composer, { borderRadius: layout.radius }]}>
        {layout.multiline ? (
          <>
            {editor}
            <View style={styles.composerActions}>
              <View style={styles.composerLeadingControls}>
                {plusButton}
                {modeChip}
              </View>
              <View style={styles.toolbarSpacer} />
              {modelPill}
              {primaryControl}
            </View>
          </>
        ) : (
          <View style={styles.composerSingleRow}>
            <View style={styles.composerLeadingControls}>
              {plusButton}
              {modeChip}
            </View>
            {editor}
            {modelPill}
            {primaryControl}
          </View>
        )}
      </View>

      <SelectionSheet
        open={picker === "model"}
        onClose={() => setPicker(null)}
        title="Models"
        tokens={tokens}
        styles={styles}
        emptyLabel="No models available for this harness."
        items={models.map((entry) => ({
          id: entry.id,
          label: entry.name,
          selected: (model?.modelValue ?? model?.id) === (entry.modelValue ?? entry.id),
          onPress: () => {
            onModelChange(entry);
            setPicker(null);
          },
        }))}
      />
      <SelectionSheet
        open={picker === "mode"}
        onClose={() => setPicker(null)}
        title="Modes"
        tokens={tokens}
        styles={styles}
        emptyLabel="No modes available."
        items={modeOptions.map((entry) => ({
          id: entry.id,
          label: entry.label,
          selected: entry.id === mode,
          onPress: () => {
            onModeChange(entry.id);
            setPicker(null);
          },
        }))}
      />
      <SlashSheet
        open={picker === "slash"}
        onClose={() => setPicker(null)}
        onSelect={applySlashItem}
        sections={slashSections}
        styles={styles}
        tokens={tokens}
        query={slashQuery ?? ""}
      />
    </View>
  );
}

function SelectionSheet({
  emptyLabel,
  items,
  onClose,
  open,
  styles,
  title,
  tokens,
}: {
  emptyLabel: string;
  items: Array<{ id: string; label: string; selected?: boolean; onPress: () => void }>;
  onClose: () => void;
  open: boolean;
  styles: ReturnType<typeof createComposerStyles>;
  title: string;
  tokens: ThemeTokens;
}) {
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={open}>
      <View style={styles.sheetBackdrop}>
        <View style={styles.sheet} testID={`native-${title.toLowerCase()}-sheet`}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <Pressable accessibilityLabel={`Close ${title}`} hitSlop={8} onPress={onClose}>
              <X color={tokens["--text-secondary"]} size={18} strokeWidth={1.5} />
            </Pressable>
          </View>
          {items.length === 0 ? (
            <Text style={styles.sheetEmpty}>{emptyLabel}</Text>
          ) : (
            <FlatList
              data={items}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => (
                <Pressable
                  onPress={item.onPress}
                  style={[styles.sheetRow, item.selected ? styles.sheetRowSelected : null]}
                >
                  <Text style={styles.sheetRowText}>{item.label}</Text>
                </Pressable>
              )}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

function SlashSheet({
  onClose,
  onSelect,
  open,
  query,
  sections,
  styles,
  tokens,
}: {
  onClose: () => void;
  onSelect: (item: SlashMenuItem) => void;
  open: boolean;
  query: string;
  sections: SlashMenuSection[];
  styles: ReturnType<typeof createComposerStyles>;
  tokens: ThemeTokens;
}) {
  const rows = useMemo(
    () =>
      sections.flatMap((section) => [
        { kind: "header" as const, id: `header:${section.id}`, label: section.label ?? section.id },
        ...section.items.map((item) => ({ kind: "item" as const, item })),
      ]),
    [sections]
  );

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={open}>
      <Pressable onPress={onClose} style={styles.slashBackdrop}>
        <Pressable onPress={() => undefined} style={styles.slashSheet} testID="native-slash-menu">
          <Text style={styles.sheetTitle}>/{query || "commands"}</Text>
          {rows.length === 0 ? (
            <Text style={styles.sheetEmpty}>No matching slash commands.</Text>
          ) : (
            <FlatList
              data={rows}
              keyExtractor={(row) => (row.kind === "header" ? row.id : row.item.id)}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item: row }) =>
                row.kind === "header" ? (
                  <Text style={styles.slashSectionLabel}>{row.label}</Text>
                ) : (
                  <Pressable
                    disabled={row.item.disabled}
                    onPress={() => onSelect(row.item)}
                    style={[styles.sheetRow, row.item.disabled ? styles.sheetRowDisabled : null]}
                  >
                    <Text style={styles.sheetRowText}>{row.item.label}</Text>
                  </Pressable>
                )
              }
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function createComposerStyles(tokens: ThemeTokens) {
  return StyleSheet.create({
    composerWrap: {
      gap: 8,
      paddingHorizontal: 12,
      paddingBottom: 8,
      paddingTop: 4,
    },
    composer: {
      backgroundColor: tokens["--bg-card"],
      borderColor: tokens["--border-subtle"],
      borderWidth: StyleSheet.hairlineWidth,
      overflow: "hidden",
      paddingHorizontal: 8,
      paddingVertical: 8,
    },
    composerSingleRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
    },
    composerActions: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
      marginTop: 8,
    },
    composerLeadingControls: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
    },
    composerPlusButton: {
      alignItems: "center",
      borderRadius: 999,
      height: DESIGN_2_RECIPES.composer.plusSize,
      justifyContent: "center",
      width: DESIGN_2_RECIPES.composer.plusSize,
    },
    composerModeChip: {
      alignItems: "center",
      borderRadius: 999,
      flexDirection: "row",
      gap: 4,
      height: 26,
      paddingHorizontal: 8,
    },
    composerModeChipText: {
      fontFamily: "sans-serif-medium",
      fontSize: 12,
    },
    composerInput: {
      color: tokens["--text-primary"],
      flex: 1,
      fontFamily: "sans-serif",
      fontSize: 15,
      paddingHorizontal: 4,
      paddingVertical: 4,
    },
    composerInputSingle: {
      maxHeight: 36,
    },
    composerInputMultiline: {
      maxHeight: 140,
      minHeight: 72,
      textAlignVertical: "top",
      width: "100%",
    },
    modelButton: {
      alignItems: "center",
      flexDirection: "row",
      gap: 4,
      maxWidth: 140,
      minHeight: DESIGN_2_RECIPES.composer.sendSize,
      paddingHorizontal: 6,
    },
    modelText: {
      color: tokens["--text-secondary"],
      flexShrink: 1,
      fontFamily: "sans-serif",
      fontSize: 12,
    },
    sendButton: {
      alignItems: "center",
      borderRadius: 999,
      height: DESIGN_2_RECIPES.composer.sendSize,
      justifyContent: "center",
      width: DESIGN_2_RECIPES.composer.sendSize,
    },
    sendButtonDisabled: {
      opacity: 0.55,
    },
    toolbarSpacer: {
      flex: 1,
    },
    attachmentStrip: {
      gap: 8,
      paddingHorizontal: 4,
    },
    attachmentChip: {
      borderRadius: 10,
      overflow: "hidden",
    },
    attachmentThumb: {
      borderRadius: 10,
      height: 56,
      width: 56,
    },
    attachmentRemove: {
      alignItems: "center",
      backgroundColor: tokens["--text-primary"],
      borderRadius: 999,
      height: 18,
      justifyContent: "center",
      position: "absolute",
      right: 4,
      top: 4,
      width: 18,
    },
    errorText: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif",
      fontSize: 12,
      paddingHorizontal: 4,
    },
    sheetBackdrop: {
      backgroundColor: "rgba(0,0,0,0.45)",
      flex: 1,
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: tokens["--bg-main"],
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      maxHeight: "70%",
      paddingBottom: 24,
      paddingHorizontal: 16,
      paddingTop: 14,
    },
    sheetHeader: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      marginBottom: 10,
    },
    sheetTitle: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif-medium",
      fontSize: 16,
    },
    sheetEmpty: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif",
      fontSize: 13,
      paddingVertical: 18,
    },
    sheetRow: {
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 14,
    },
    sheetRowSelected: {
      backgroundColor: tokens["--bg-card"],
    },
    sheetRowDisabled: {
      opacity: 0.45,
    },
    sheetRowText: {
      color: tokens["--text-primary"],
      fontFamily: "sans-serif",
      fontSize: 15,
    },
    slashBackdrop: {
      backgroundColor: "rgba(0,0,0,0.35)",
      flex: 1,
      justifyContent: "flex-end",
      padding: 12,
    },
    slashSheet: {
      backgroundColor: tokens["--bg-main"],
      borderRadius: 14,
      maxHeight: "55%",
      padding: 12,
    },
    slashSectionLabel: {
      color: tokens["--text-secondary"],
      fontFamily: "sans-serif-medium",
      fontSize: 11,
      letterSpacing: 0.4,
      paddingHorizontal: 12,
      paddingTop: 10,
      textTransform: "uppercase",
    },
  });
}
