export type ShortcutPlatform = "apple" | "other";

export type ShortcutCommandSection =
  | "Workbench"
  | "Chat"
  | "File"
  | "Editor"
  | "Edit"
  | "Search"
  | "Terminal"
  | "Window"
  | "Developer";

export type ShortcutCommandDefinition = {
  id: string;
  label: string;
  section: ShortcutCommandSection;
  defaultBindings: string[];
  allowInEditableContexts?: boolean;
};

export type KeyboardShortcutBindingsMap = Record<string, string[]>;

export type VoiceInputMode = "hold" | "toggle";

export type KeyboardShortcutsSettingsState = {
  bindings: KeyboardShortcutBindingsMap;
  voiceInputMode: VoiceInputMode;
};

export type ParsedShortcutStep = {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
};

const MODIFIER_ALIASES = new Map<string, "Mod" | "Shift" | "Alt">([
  ["mod", "Mod"],
  ["cmd", "Mod"],
  ["command", "Mod"],
  ["meta", "Mod"],
  ["ctrl", "Mod"],
  ["control", "Mod"],
  ["shift", "Shift"],
  ["alt", "Alt"],
  ["option", "Alt"],
  ["opt", "Alt"],
]);

const KEY_ALIASES = new Map<string, string>([
  [",", "Comma"],
  ["comma", "Comma"],
  ["`", "Backquote"],
  ["backquote", "Backquote"],
  ["backtick", "Backquote"],
  ["\\", "Backslash"],
  ["backslash", "Backslash"],
  ["=", "Equal"],
  ["equal", "Equal"],
  ["-", "Minus"],
  ["minus", "Minus"],
  ["esc", "Escape"],
  ["escape", "Escape"],
  ["enter", "Enter"],
  ["return", "Enter"],
  ["space", "Space"],
  ["spacebar", "Space"],
]);

const DISPLAY_KEY_LABELS: Record<string, string> = {
  Backquote: "`",
  Backslash: "\\",
  Comma: ",",
  Equal: "=",
  Escape: "Esc",
  Minus: "-",
  Space: "Space",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Tab: "Tab",
};

export const SHORTCUT_COMMAND_DEFINITIONS: ShortcutCommandDefinition[] = [
  {
    id: "palette.quickOpen",
    label: "Go to File…",
    section: "Workbench",
    defaultBindings: ["Mod+P"],
    allowInEditableContexts: true,
  },
  {
    id: "palette.showCommands",
    label: "Show All Commands",
    section: "Workbench",
    defaultBindings: ["F1", "Mod+Shift+P"],
    allowInEditableContexts: true,
  },
  {
    id: "workbench.action.toggleSidebarVisibility",
    label: "View: Toggle Primary Side Bar Visibility",
    section: "Workbench",
    defaultBindings: ["Mod+B"],
  },
  {
    id: "workbench.view.explorer",
    label: "View: Show Explorer",
    section: "Workbench",
    defaultBindings: ["Mod+Shift+E"],
  },
  {
    id: "workbench.action.togglePanel",
    label: "View: Toggle Panel",
    section: "Workbench",
    defaultBindings: ["Mod+J"],
  },
  {
    id: "workbench.action.toggleAgentPanel",
    label: "View: Toggle Agent / Chat Side Panel",
    section: "Workbench",
    defaultBindings: ["Mod+Shift+B", "Mod+Alt+B"],
  },
  {
    id: "workbench.action.focusChatPlanMode",
    label: "Chat: Use Plan mode",
    section: "Workbench",
    defaultBindings: ["Mod+I"],
    allowInEditableContexts: true,
  },
  {
    id: "workbench.action.focusChatAgentMode",
    label: "Chat: Use Agent mode",
    section: "Workbench",
    defaultBindings: [],
    allowInEditableContexts: true,
  },
  {
    id: "workbench.action.openGlobalSettings",
    label: "Preferences: Open User Settings",
    section: "Workbench",
    defaultBindings: ["Mod+Comma"],
    allowInEditableContexts: true,
  },
  {
    id: "workbench.action.openKeyboardShortcuts",
    label: "Preferences: Open Keyboard Shortcuts",
    section: "Workbench",
    defaultBindings: [],
    allowInEditableContexts: true,
  },
  {
    id: "chat.action.openWorkspacePicker",
    label: "Chat: Open workspace picker",
    section: "Chat",
    defaultBindings: [],
    allowInEditableContexts: true,
  },
  {
    id: "chat.action.openBackendDropdown",
    label: "Chat: Open ACP / backend picker",
    section: "Chat",
    defaultBindings: [],
    allowInEditableContexts: true,
  },
  {
    id: "chat.action.openModeDropdown",
    label: "Chat: Open mode picker",
    section: "Chat",
    defaultBindings: [],
    allowInEditableContexts: true,
  },
  {
    id: "chat.action.openModelDropdown",
    label: "Chat: Open model picker",
    section: "Chat",
    defaultBindings: [],
    allowInEditableContexts: true,
  },
  {
    id: "chat.action.toggleVoiceInput",
    label: "Chat: Voice Transcription",
    section: "Chat",
    defaultBindings: ["Mod+T"],
    allowInEditableContexts: true,
  },
  {
    id: "chat.action.toggleComposerExpand",
    label: "Chat: Toggle expand composer",
    section: "Chat",
    defaultBindings: [],
    allowInEditableContexts: true,
  },
  {
    id: "chat.action.attachImage",
    label: "Chat: Attach Image",
    section: "Chat",
    defaultBindings: ["Mod+U"],
    allowInEditableContexts: true,
  },
  {
    id: "chat.action.agentRailPreviousConversation",
    label: "Agent: Previous conversation in rail",
    section: "Chat",
    defaultBindings: ["Alt+ArrowUp", "Mod+Shift+Tab"],
    allowInEditableContexts: true,
  },
  {
    id: "chat.action.agentRailNextConversation",
    label: "Agent: Next conversation in rail",
    section: "Chat",
    defaultBindings: ["Alt+ArrowDown", "Mod+Tab"],
    allowInEditableContexts: true,
  },
  {
    id: "workbench.action.openFile",
    label: "File: Open File…",
    section: "File",
    defaultBindings: ["Mod+O"],
    allowInEditableContexts: true,
  },
  {
    id: "workbench.action.openFolder",
    label: "File: Open Folder…",
    section: "File",
    defaultBindings: ["Mod+Shift+O"],
    allowInEditableContexts: true,
  },
  {
    id: "workbench.action.newWindow",
    label: "File: New Window",
    section: "Window",
    defaultBindings: ["Mod+Shift+N"],
  },
  {
    id: "workbench.action.window.manage",
    label: "Window: Workspace Windows...",
    section: "Window",
    defaultBindings: [],
  },
  {
    id: "workbench.action.newAgent",
    label: "File: New Agent",
    section: "File",
    defaultBindings: [],
  },
  {
    id: "workbench.action.closeActiveEditor",
    label: "View: Close Editor",
    section: "Editor",
    defaultBindings: ["Mod+W"],
  },
  {
    id: "workbench.action.files.save",
    label: "File: Save",
    section: "File",
    defaultBindings: ["Mod+S"],
    allowInEditableContexts: true,
  },
  {
    id: "workbench.action.files.saveAll",
    label: "File: Save All",
    section: "File",
    defaultBindings: ["Mod+K Mod+S"],
    allowInEditableContexts: true,
  },
  {
    id: "workbench.action.splitEditor",
    label: "View: Split Editor",
    section: "Editor",
    defaultBindings: ["Mod+Backslash"],
  },
  {
    id: "workbench.action.splitEditorDown",
    label: "View: Split Editor Down",
    section: "Editor",
    defaultBindings: [],
  },
  {
    id: "workbench.action.joinEditorGroup",
    label: "View: Join Editor Group",
    section: "Editor",
    defaultBindings: [],
  },
  {
    id: "workbench.action.openPreview",
    label: "Open Preview",
    section: "Editor",
    defaultBindings: ["Mod+Shift+V"],
  },
  {
    id: "workbench.action.gotoFile",
    label: "View: Open File",
    section: "Workbench",
    defaultBindings: ["Mod+G"],
  },
  {
    id: "workbench.action.findInFiles",
    label: "Search: Find in Files",
    section: "Search",
    defaultBindings: ["Mod+Shift+F"],
  },
  {
    id: "workbench.action.terminal.toggleTerminal",
    label: "View: Toggle Terminal",
    section: "Terminal",
    defaultBindings: ["Mod+Backquote"],
  },
];

export const DEFAULT_KEYBOARD_SHORTCUT_BINDINGS: KeyboardShortcutBindingsMap =
  Object.fromEntries(
    SHORTCUT_COMMAND_DEFINITIONS.map((definition) => [
      definition.id,
      [...definition.defaultBindings],
    ])
  );

export function createDefaultKeyboardShortcutsState(): KeyboardShortcutsSettingsState {
  return {
    bindings: { ...DEFAULT_KEYBOARD_SHORTCUT_BINDINGS },
    voiceInputMode: "toggle",
  };
}

export function detectShortcutPlatform(): ShortcutPlatform {
  if (typeof navigator === "undefined") {
    return "other";
  }

  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform =
    nav.userAgentData?.platform ?? nav.platform ?? "";
  const userAgent = nav.userAgent ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform) ||
    /mac|iphone|ipad|ipod/i.test(userAgent)
    ? "apple"
    : "other";
}

function normalizeKeyToken(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const alias = KEY_ALIASES.get(trimmed.toLowerCase());
  if (alias) {
    return alias;
  }

  if (/^f\d{1,2}$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  if (/^[a-z]$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  if (/^\d$/.test(trimmed)) {
    return trimmed;
  }

  if (/^[A-Z][a-zA-Z0-9]+$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

export function normalizeKeyForCapture(key: string): string {
  const fromAlias = KEY_ALIASES.get(key.toLowerCase());
  if (fromAlias) return fromAlias;

  if (key.startsWith("F") && /^F\d{1,2}$/i.test(key)) return key.toUpperCase();
  if (/^[a-z]$/i.test(key)) return key.toUpperCase();
  if (/^\d$/.test(key)) return key;

  if (/^[A-Z][a-zA-Z0-9]+$/.test(key)) return key;

  return key;
}

export function parseShortcutBinding(binding: string): ParsedShortcutStep[] | null {
  const trimmed = binding.trim();
  if (!trimmed) {
    return [];
  }

  const steps = trimmed
    .split(/\s+/)
    .filter(Boolean)
    .map((step) => {
      const tokens = step.split("+").map((token) => token.trim()).filter(Boolean);
      if (tokens.length === 0) {
        return null;
      }

      let mod = false;
      let shift = false;
      let alt = false;
      let key: string | null = null;

      for (const token of tokens) {
        const modifier = MODIFIER_ALIASES.get(token.toLowerCase());
        if (modifier) {
          if (modifier === "Mod") mod = true;
          if (modifier === "Shift") shift = true;
          if (modifier === "Alt") alt = true;
          continue;
        }

        if (key != null) {
          return null;
        }

        key = normalizeKeyToken(token);
      }

      if (!key) {
        return null;
      }

      return { key, mod, shift, alt };
    });

  if (steps.some((step) => step == null)) {
    return null;
  }

  return steps as ParsedShortcutStep[];
}

export function normalizeShortcutBinding(binding: string): string | null {
  const parsed = parseShortcutBinding(binding);
  if (parsed == null) {
    return null;
  }
  if (parsed.length === 0) {
    return "";
  }

  return parsed
    .map((step) => {
      const tokens: string[] = [];
      if (step.mod) tokens.push("Mod");
      if (step.shift) tokens.push("Shift");
      if (step.alt) tokens.push("Alt");
      tokens.push(step.key);
      return tokens.join("+");
    })
    .join(" ");
}

export function normalizeShortcutBindingsList(
  raw: unknown,
  fallback: string[]
): string[] {
  if (!Array.isArray(raw)) {
    return [...fallback];
  }

  const normalized = raw
    .map((value) =>
      typeof value === "string" ? normalizeShortcutBinding(value) : null
    )
    .filter((value): value is string => value != null);

  return [...new Set(normalized)];
}

export function normalizeShortcutBindingsMap(
  raw: unknown
): KeyboardShortcutBindingsMap {
  const planCommandId = "workbench.action.focusChatPlanMode";
  const legacyAgentCommandId = "workbench.action.focusChatAgentMode";
  const result: KeyboardShortcutBindingsMap = {
    ...DEFAULT_KEYBOARD_SHORTCUT_BINDINGS,
  };

  if (!raw || typeof raw !== "object") {
    return result;
  }

  for (const definition of SHORTCUT_COMMAND_DEFINITIONS) {
    const value = (raw as Record<string, unknown>)[definition.id];
    result[definition.id] = normalizeShortcutBindingsList(
      value,
      definition.defaultBindings
    );
  }

  const rawBindings = raw as Record<string, unknown>;
  if (rawBindings[planCommandId] == null) {
    const legacyBindings = normalizeShortcutBindingsList(
      rawBindings[legacyAgentCommandId],
      []
    );
    if (legacyBindings.length === 1 && legacyBindings[0] === "Mod+I") {
      result[legacyAgentCommandId] = [];
    }
  }

  for (const definition of SHORTCUT_COMMAND_DEFINITIONS) {
    if (
      result[definition.id].length === 0 &&
      definition.defaultBindings.length > 0 &&
      (definition.id === "chat.action.attachImage" ||
        definition.id === "chat.action.toggleVoiceInput")
    ) {
      result[definition.id] = [...definition.defaultBindings];
    }
  }

  return result;
}

export function normalizeKeyboardShortcutsState(
  raw: unknown
): KeyboardShortcutsSettingsState {
  const bindings =
    raw && typeof raw === "object" && "bindings" in raw
    ? normalizeShortcutBindingsMap(
      (raw as { bindings?: unknown }).bindings
    )
    : normalizeShortcutBindingsMap(raw);

  const rawMode =
    raw && typeof raw === "object" && "voiceInputMode" in raw
    ? (raw as { voiceInputMode?: unknown }).voiceInputMode
    : undefined;
  const voiceInputMode: VoiceInputMode =
    rawMode === "hold" ? "hold" : "toggle";

  return { bindings, voiceInputMode };
}

export function getShortcutBindingsForCommand(
  bindings: KeyboardShortcutBindingsMap | undefined,
  commandId: string
): string[] {
  if (bindings?.[commandId]) {
    return bindings[commandId];
  }
  return DEFAULT_KEYBOARD_SHORTCUT_BINDINGS[commandId] ?? [];
}

/** Shown in settings and shortcut hints: `Mod` matches Ctrl or ⌘ (Meta) on every OS. */
export function primaryModifierLabel(platform: ShortcutPlatform): string {
  return platform === "apple" ? "⌃ / ⌘" : "Ctrl";
}

function formatStep(step: ParsedShortcutStep, platform: ShortcutPlatform): string {
  const tokens: string[] = [];
  if (step.mod) tokens.push(primaryModifierLabel(platform));
  if (step.shift) tokens.push("Shift");
  if (step.alt) tokens.push(platform === "apple" ? "Option" : "Alt");
  tokens.push(DISPLAY_KEY_LABELS[step.key] ?? step.key);
  return tokens.join("+");
}

export function formatShortcutBinding(
  binding: string,
  platform: ShortcutPlatform
): string {
  const parsed = parseShortcutBinding(binding);
  if (parsed == null || parsed.length === 0) {
    return "";
  }
  return parsed.map((step) => formatStep(step, platform)).join(" ");
}

export function formatShortcutBindings(
  bindings: string[],
  platform: ShortcutPlatform
): string {
  return bindings
    .map((binding) => formatShortcutBinding(binding, platform))
    .filter(Boolean)
    .join(" · ");
}

export function formatShortcutBindingsForInput(
  bindings: string[],
  platform: ShortcutPlatform
): string {
  return bindings
    .map((binding) => formatShortcutBinding(binding, platform))
    .filter(Boolean)
    .join(", ");
}

export function parseShortcutBindingsInput(input: string): string[] | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return [];
  }

  const normalized = trimmed
    .split(/[\n,]+/)
    .map((value) => normalizeShortcutBinding(value))
    .filter((value): value is string => value != null);

  if (normalized.length === 0) {
    return null;
  }

  return [...new Set(normalized)];
}

export function getShortcutCommandDefinition(
  commandId: string
): ShortcutCommandDefinition | null {
  return (
    SHORTCUT_COMMAND_DEFINITIONS.find(
      (definition) => definition.id === commandId
    ) ?? null
  );
}

function eventToKeyToken(event: KeyboardEvent): string | null {
  if (event.key === "Meta" || event.key === "Control" || event.key === "Alt" || event.key === "Shift") {
    return null;
  }

  if (/^Key[A-Z]$/i.test(event.code)) {
    return event.code.slice(3).toUpperCase();
  }

  if (/^Digit\d$/i.test(event.code)) {
    return event.code.slice(5);
  }

  if (
    event.code === "Comma" ||
    event.code === "Backquote" ||
    event.code === "Backslash" ||
    event.code === "Equal" ||
    event.code === "Minus"
  ) {
    return event.code;
  }

  return normalizeKeyToken(event.key);
}

export function matchesShortcutStep(
  event: KeyboardEvent,
  step: ParsedShortcutStep,
  platform: ShortcutPlatform
): boolean {
  void platform;
  const modPressed = event.metaKey || event.ctrlKey;
  if (step.mod !== modPressed) {
    return false;
  }
  if (event.shiftKey !== step.shift) {
    return false;
  }
  if (event.altKey !== step.alt) {
    return false;
  }

  return eventToKeyToken(event) === step.key;
}

const NATIVE_EDITING_SHORTCUT_KEYS = new Set(["a", "c", "v", "x", "y", "z"]);

export function isNativeEditableShortcutEvent(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">
): boolean {
  if (event.altKey || (!event.ctrlKey && !event.metaKey)) {
    return false;
  }
  return NATIVE_EDITING_SHORTCUT_KEYS.has(event.key.toLowerCase());
}

function isTextInputElement(element: Element): boolean {
  if (typeof HTMLInputElement === "undefined" || !(element instanceof HTMLInputElement)) {
    return false;
  }
  const nonTextTypes = new Set([
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ]);
  return !nonTextTypes.has(element.type.toLowerCase());
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return false;
  }
  const editable = target.closest(
    "textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox'], [data-hardware-input-surface], .monaco-editor"
  );
  if (editable) {
    return true;
  }
  if (isTextInputElement(target)) {
    return true;
  }
  if (typeof HTMLElement !== "undefined" && target instanceof HTMLElement) {
    return target.isContentEditable;
  }
  return false;
}

export function getShortcutDisplayForCommand(
  bindings: KeyboardShortcutBindingsMap | undefined,
  commandId: string,
  platform: ShortcutPlatform
): string {
  return formatShortcutBindings(
    getShortcutBindingsForCommand(bindings, commandId),
    platform
  );
}

const CHORD_TIMEOUT_MS = 1200;

export type ShortcutChordState = {
  commandId: string;
  steps: ParsedShortcutStep[];
  nextIndex: number;
  /** Browser timer id from `window.setTimeout` (typed as `number` for DOM / Node overlap). */
  timeoutId: number;
};

function clearShortcutChord(chordRef: {
  current: ShortcutChordState | null;
}): void {
  const pending = chordRef.current;
  if (!pending) return;
  window.clearTimeout(pending.timeoutId);
  chordRef.current = null;
}

/**
 * Dispatches a keydown against customizable bindings (supports chords such as
 * `Mod+K Mod+S`). Returns true if the event was consumed (caller should not run
 * legacy handlers).
 */
export function tryDispatchKeyboardShortcut(options: {
  event: KeyboardEvent;
  platform: ShortcutPlatform;
  bindings: KeyboardShortcutBindingsMap;
  chordRef: { current: ShortcutChordState | null };
  onCommand: (commandId: string) => void;
  editableTarget?: boolean;
  chordTimeoutMs?: number;
}): boolean {
  const chordTimeoutMs = options.chordTimeoutMs ?? CHORD_TIMEOUT_MS;
  const { event, platform, bindings, chordRef, onCommand } = options;
  const editableTarget = options.editableTarget === true;
  const pending = chordRef.current;

  if (pending) {
    const step = pending.steps[pending.nextIndex];
    if (step != null && matchesShortcutStep(event, step, platform)) {
      const pendingDefinition = getShortcutCommandDefinition(pending.commandId);
      if (
        editableTarget &&
        (!pendingDefinition?.allowInEditableContexts ||
          isNativeEditableShortcutEvent(event))
      ) {
        clearShortcutChord(chordRef);
        return false;
      }
      event.preventDefault();
      if (pending.nextIndex >= pending.steps.length - 1) {
        const id = pending.commandId;
        clearShortcutChord(chordRef);
        onCommand(id);
        return true;
      }
      window.clearTimeout(pending.timeoutId);
      pending.nextIndex += 1;
      pending.timeoutId = window.setTimeout(() => {
        chordRef.current = null;
      }, chordTimeoutMs);
      return true;
    }
    clearShortcutChord(chordRef);
  }

  for (const def of SHORTCUT_COMMAND_DEFINITIONS) {
    const list = getShortcutBindingsForCommand(bindings, def.id);
    for (const bindingStr of list) {
      const parsed = parseShortcutBinding(bindingStr);
      if (!parsed || parsed.length === 0) continue;
      const first = parsed[0];
      if (!first || !matchesShortcutStep(event, first, platform)) continue;
      if (
        editableTarget &&
        (!def.allowInEditableContexts || isNativeEditableShortcutEvent(event))
      ) {
        continue;
      }
      event.preventDefault();
      if (parsed.length === 1) {
        onCommand(def.id);
        return true;
      }
      chordRef.current = {
        commandId: def.id,
        steps: parsed,
        nextIndex: 1,
        timeoutId: window.setTimeout(() => {
          chordRef.current = null;
        }, chordTimeoutMs),
      };
      return true;
    }
  }

  return false;
}
