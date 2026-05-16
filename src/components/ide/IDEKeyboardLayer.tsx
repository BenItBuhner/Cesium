"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import { buildQuickOpenIndex, type QuickOpenEntry } from "@/lib/quick-open-files";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";
import { QuickOpen } from "./QuickOpen";
import { VSCodeQuickInputShell } from "./VSCodeQuickInputShell";
import { WorkspaceStudioModal } from "./WorkspaceStudioModal";
import { WorkspaceWindowsModal } from "./WorkspaceWindowsModal";
import { useEditorBridgeRef } from "./EditorBridgeContext";
import { useWorkbench } from "./WorkbenchContext";
import { useHardwareInput } from "@/components/input/HardwareInputProvider";
import { useTheme } from "@/components/theme/ThemeProvider";
import { IDECommandProvider } from "./IDECommandContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import type { EditorTab } from "@/lib/types";
import { isFocusedBrowserSurface } from "@/lib/browser-keyboard-passthrough";
import { normalizeBrowserTargetUrl } from "@/lib/browser-proxy-url";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { WORKSPACE_ROUTE } from "@/lib/workbench-view";
import { buildWorkspaceWindowUrl } from "@/lib/workspace-windows";
import {
  SHORTCUT_COMMAND_DEFINITIONS,
  detectShortcutPlatform,
  getShortcutBindingsForCommand,
  getShortcutDisplayForCommand,
  isEditableShortcutTarget,
  tryDispatchKeyboardShortcut,
  matchesShortcutStep,
  parseShortcutBinding,
  type ShortcutChordState,
  type VoiceInputMode,
} from "@/lib/keyboard-shortcuts";
import { useShellView } from "@/components/layout/ShellViewContext";
import { useAgentShellStateMaybe } from "@/components/agent/AgentShellStateContext";
import {
  dispatchChatComposerShortcut,
  dispatchWorkspacePickerShortcut,
} from "@/lib/chat-ui-shortcut-events";

type PaletteMode = "closed" | "command" | "quickopen";

/**
 * While focus is inside `[data-ide-input-sink]` (chat composer, dropdowns, etc.),
 * only shortcuts listed here are evaluated — all others are suppressed so keys like
 * Mod+S don't fire save. These must include every `chat.action.*` we dispatch from
 * the keyboard layer, or they never match when the user is typing in the composer.
 */
const INPUT_SINK_ALLOWED_SHORTCUT_IDS = [
  "workbench.action.focusChatPlanMode",
  "workbench.action.focusChatAgentMode",
  "chat.action.openWorkspacePicker",
  "chat.action.openBackendDropdown",
  "chat.action.openModeDropdown",
  "chat.action.openModelDropdown",
  "chat.action.toggleVoiceInput",
  "chat.action.toggleComposerExpand",
  "chat.action.attachImage",
  "chat.action.agentRailPreviousConversation",
  "chat.action.agentRailNextConversation",
] as const;

function flash(setter: (s: string | null) => void, msg: string) {
  setter(msg);
  window.setTimeout(() => setter(null), 2200);
}

function isHardwareInputTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest("[data-hardware-input-surface]"))
  );
}

function shouldUseNativeEditableHandling(target: EventTarget | null): boolean {
  return isEditableShortcutTarget(target) && !isHardwareInputTarget(target);
}

export function IDEKeyboardLayer({ children }: { children: ReactNode }) {
  const { setShellView, openSettingsView } = useShellView();
  const bridgeRef = useEditorBridgeRef();
  const { openExplorerFile } = useOpenInEditor();
  const workbench = useWorkbench();
  const {
    enabled: hardwareInputEnabled,
    routeKeyDown,
    handlePaste,
    handleCopy,
    handleCut,
  } = useHardwareInput();
  const { setPreference: setThemePreference } = useTheme();
  const { settings } = useGlobalSettings();
  const { activeServer, servers, setActiveServer } = useServerConnections();
  const shortcutBindings = settings.keyboardShortcuts.bindings;
  const shortcutPlatform = useMemo(() => detectShortcutPlatform(), []);
  const chordRef = useRef<ShortcutChordState | null>(null);
  const voiceHoldActiveRef = useRef(false);
  const voiceInputModeRef = useRef<VoiceInputMode>(settings.keyboardShortcuts.voiceInputMode);
  voiceInputModeRef.current = settings.keyboardShortcuts.voiceInputMode;

  const {
    activeWorkspaceId,
    activeWindowId,
    defaultWorkspaceId,
    fileTree,
    isDedicatedWindow,
    workspaceInfo,
    workspaceWindows,
    workspaces,
    refreshTree,
    openFolder,
    openWorkspaceById,
    refreshWorkspaceWindows,
    createWorkspaceWindow,
    setDefaultWorkspace,
    updateWorkspaceSession,
    updateWorkspaceWindow,
    flushWorkspaceSessionNow,
  } = useWorkspace();
  const agentShell = useAgentShellStateMaybe();
  const [palette, setPalette] = useState<PaletteMode>("closed");
  const [folderPromptOpen, setFolderPromptOpen] = useState(false);
  const [folderPromptValue, setFolderPromptValue] = useState("");
  const [workspaceStudioOpen, setWorkspaceStudioOpen] = useState(false);
  const [workspaceStudioMode, setWorkspaceStudioMode] = useState<
    "clone" | "browse" | "newfolder" | "remove"
  >("clone");
  const [browserPromptOpen, setBrowserPromptOpen] = useState(false);
  const [browserPromptValue, setBrowserPromptValue] = useState(
    "http://localhost:3000/"
  );
  const [workspaceWindowsModalOpen, setWorkspaceWindowsModalOpen] = useState(false);
  const [workspaceWindowsModalInitialSelectionId, setWorkspaceWindowsModalInitialSelectionId] =
    useState<string | null>(null);
  const [renameWindowOpen, setRenameWindowOpen] = useState(false);
  const [renameWindowValue, setRenameWindowValue] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  const quickEntries = useMemo(
    () => (fileTree ? buildQuickOpenIndex(fileTree) : []),
    [fileTree]
  );

  const inferEditorIcon = useCallback((entry: QuickOpenEntry): EditorTab["icon"] => {
    const lower = entry.name.toLowerCase();
    const language = entry.node.language?.toLowerCase();
    if (language === "css" || lower.endsWith(".css")) return "css";
    if (language === "json" || lower.endsWith(".json")) return "json";
    if (language === "markdown" || lower.endsWith(".md")) return "markdown";
    if (
      language === "typescript" ||
      language === "javascript" ||
      lower.endsWith(".ts") ||
      lower.endsWith(".tsx") ||
      lower.endsWith(".js") ||
      lower.endsWith(".jsx")
    ) {
      return "typescript";
    }
    return "default";
  }, []);

  const promptForFolder = useCallback(() => {
    setPalette("closed");
    setFolderPromptValue(workspaceInfo?.root ?? "");
    setFolderPromptOpen(true);
  }, [workspaceInfo?.root]);

  const submitFolderPrompt = useCallback(async () => {
    const root = folderPromptValue.trim();
    if (!root) return;
    try {
      await openFolder(root);
      setFolderPromptOpen(false);
      flash(setToast, `Opened ${root}`);
    } catch (error) {
      flash(
        setToast,
        error instanceof Error ? error.message : "Failed to open workspace."
      );
    }
  }, [folderPromptValue, openFolder]);

  const promptForCreateWorkspace = useCallback(() => {
    setPalette("closed");
    setWorkspaceStudioMode("clone");
    setWorkspaceStudioOpen(true);
  }, []);

  const promptToRemoveWorkspace = useCallback(() => {
    setPalette("closed");
    setWorkspaceStudioMode("remove");
    setWorkspaceStudioOpen(true);
  }, []);

  const openBrowserUrlPrompt = useCallback(() => {
    setPalette("closed");
    // On public deployments default to the current site origin, not localhost.
    const nextDefault =
      typeof window !== "undefined" &&
      window.location?.origin &&
      /^https?:\/\//i.test(window.location.origin)
        ? `${window.location.origin}/`
        : "http://localhost:3000/";
    setBrowserPromptValue(nextDefault);
    setBrowserPromptOpen(true);
  }, []);

  const runWithBridge = useCallback(
    (fn: (d: NonNullable<typeof bridgeRef.current>) => void) => {
      const b = bridgeRef.current;
      if (b) fn(b);
      else flash(setToast, "Editor is not ready yet.");
    },
    [bridgeRef]
  );

  const submitBrowserPrompt = useCallback(() => {
    const raw = browserPromptValue.trim();
    if (!raw) return;
    try {
      normalizeBrowserTargetUrl(raw);
    } catch {
      flash(setToast, "Invalid URL.");
      return;
    }
    runWithBridge((b) => {
      b.openBrowserTab(raw);
      setBrowserPromptOpen(false);
      flash(setToast, "Browser tab opened.");
    });
  }, [browserPromptValue, runWithBridge]);

  const openWorkspaceWindow = useCallback(
    (windowId: string) => {
      if (!activeWorkspaceId) {
        flash(setToast, "No active workspace.");
        return;
      }
      const nextWindow = window.open(
        buildWorkspaceWindowUrl(window.location.origin, activeWorkspaceId, windowId),
        "_blank",
        "noopener,noreferrer"
      );
      if (!nextWindow) {
        flash(setToast, "Popup blocked while opening the workspace window.");
      }
    },
    [activeWorkspaceId]
  );

  const createAndOpenWorkspaceWindow = useCallback(
    async (options?: { title?: string }) => {
      if (!activeWorkspaceId) {
        flash(setToast, "No active workspace.");
        return;
      }
      await flushWorkspaceSessionNow();
      const windowRecord = await createWorkspaceWindow({
        title: options?.title,
      });
      openWorkspaceWindow(windowRecord.id);
    },
    [activeWorkspaceId, createWorkspaceWindow, flushWorkspaceSessionNow, openWorkspaceWindow]
  );

  const openWorkspaceWindowsModal = useCallback(
    (options?: { initialSelectionId?: string | null }) => {
      setWorkspaceWindowsModalInitialSelectionId(options?.initialSelectionId ?? null);
      setWorkspaceWindowsModalOpen(true);
    },
    []
  );

  const promptRenameCurrentWindow = useCallback(() => {
    if (!isDedicatedWindow || !activeWindowId) {
      flash(setToast, "Open a dedicated workspace window first.");
      return;
    }
    const currentWindow =
      workspaceWindows.find((windowRecord) => windowRecord.id === activeWindowId) ?? null;
    setRenameWindowValue(currentWindow?.label ?? "");
    setRenameWindowOpen(true);
  }, [activeWindowId, isDedicatedWindow, workspaceWindows]);

  useEffect(() => {
    if (!workspaceWindowsModalOpen) {
      return;
    }
    void refreshWorkspaceWindows().catch(() => {
      // Ignore background refresh failures while opening the workspace windows modal.
    });
  }, [refreshWorkspaceWindows, workspaceWindowsModalOpen]);

  const submitRenameCurrentWindow = useCallback(async () => {
    if (!activeWindowId) {
      return;
    }
    const title = renameWindowValue.trim();
    if (!title) {
      return;
    }
    await updateWorkspaceWindow(activeWindowId, { title });
    setRenameWindowOpen(false);
    flash(setToast, `Renamed window to ${title}`);
  }, [activeWindowId, renameWindowValue, updateWorkspaceWindow]);

  const kb = useCallback(
    (commandId: string) => {
      const s = getShortcutDisplayForCommand(
        shortcutBindings,
        commandId,
        shortcutPlatform
      );
      return s || undefined;
    },
    [shortcutBindings, shortcutPlatform]
  );

  const runShortcutCommand = useCallback(
    (id: string) => {
      switch (id) {
        case "palette.quickOpen":
          setPalette("quickopen");
          break;
        case "palette.showCommands":
          setPalette("command");
          break;
        case "workbench.action.toggleSidebarVisibility":
          workbench.toggleSidebar();
          break;
        case "workbench.view.explorer":
          workbench.revealExplorer();
          break;
        case "workbench.action.togglePanel":
          workbench.toggleChat();
          break;
        case "workbench.action.toggleAgentPanel":
          workbench.toggleChat();
          break;
        case "workbench.action.focusChatPlanMode":
          updateWorkspaceSession((current) => ({
            ...current,
            chat: { ...current.chat, mode: "plan" },
          }));
          break;
        case "workbench.action.focusChatAgentMode":
          updateWorkspaceSession((current) => ({
            ...current,
            chat: { ...current.chat, mode: "agent" },
          }));
          break;
        case "recentChats.open":
          window.dispatchEvent(new CustomEvent("opencursor:openRecentChats"));
          break;
        case "workbench.action.openGlobalSettings":
          openSettingsView();
          break;
        case "workbench.action.openKeyboardShortcuts":
          updateWorkspaceSession((current) => ({
            ...current,
            settingsView: { ...current.settingsView, activeNav: "keyboardShortcuts" },
          }));
          openSettingsView();
          break;
        case "workbench.action.openServers":
          updateWorkspaceSession((current) => ({
            ...current,
            settingsView: { ...current.settingsView, activeNav: "servers" },
          }));
          openSettingsView();
          break;
        case "workbench.action.openFile":
        case "workbench.action.gotoFile":
          setPalette("quickopen");
          break;
        case "workbench.action.openFolder":
          promptForFolder();
          break;
        case "workbench.action.newWindow":
          openWorkspaceWindowsModal({ initialSelectionId: "action:create-window" });
          break;
        case "workbench.action.window.manage":
          openWorkspaceWindowsModal();
          break;
        case "workbench.action.window.rename":
          openWorkspaceWindowsModal({
            initialSelectionId: "action:rename-current-window",
          });
          break;
        case "workbench.action.window.refreshList":
          openWorkspaceWindowsModal();
          break;
        case "workbench.action.newAgent":
          setShellView("agent");
          break;
        case "workbench.action.closeActiveEditor":
          runWithBridge((b) => {
            const s = b.getState();
            const g = s.focusedGroup;
            const tabId = g === "left" ? s.leftActiveId : s.rightActiveId;
            if (tabId) b.requestCloseTab(g, tabId);
          });
          break;
        case "workbench.action.files.save":
          void (async () => {
            const bridge = bridgeRef.current;
            if (!bridge) {
              flash(setToast, "Editor is not ready yet.");
              return;
            }
            const saved = await bridge.saveActiveTab();
            if (!saved) {
              flash(setToast, "Active editor cannot be saved.");
            }
          })();
          break;
        case "workbench.action.files.saveAll":
          void (async () => {
            const bridge = bridgeRef.current;
            if (!bridge) {
              flash(setToast, "Editor is not ready yet.");
              return;
            }
            const result = await bridge.saveAllTabs();
            if (result.attemptedCount === 0) {
              flash(setToast, "No dirty editors to save.");
              return;
            }
            if (result.savedCount === result.attemptedCount) {
              flash(
                setToast,
                result.savedCount === 1
                  ? "Saved 1 editor."
                  : `Saved ${result.savedCount} editors.`
              );
              return;
            }
            flash(
              setToast,
              `Saved ${result.savedCount} of ${result.attemptedCount} editors.`
            );
          })();
          break;
        case "workbench.action.splitEditor":
          runWithBridge((b) =>
            b.dispatch({ type: "ENABLE_SPLIT", orientation: "horizontal" })
          );
          break;
        case "workbench.action.splitEditorRight":
          runWithBridge((b) =>
            b.dispatch({ type: "ENABLE_SPLIT", orientation: "horizontal" })
          );
          break;
        case "workbench.action.splitEditorDown":
          runWithBridge((b) =>
            b.dispatch({ type: "ENABLE_SPLIT", orientation: "vertical" })
          );
          break;
        case "workbench.action.openPreview":
          runWithBridge((b) => b.dispatch({ type: "TOGGLE_FILE_PREVIEW" }));
          break;
        case "workbench.action.findInFiles":
          workbench.revealExplorer();
          flash(setToast, "Find in Files — use the sidebar Search view.");
          break;
        case "workbench.action.terminal.toggleTerminal":
          void (async () => {
            const bridge = bridgeRef.current;
            if (!bridge) {
              flash(setToast, "Editor is not ready yet.");
              return;
            }
            const snapshot = bridge.getState();
            const leftTerminal = snapshot.leftTabs.find((tab) => tab.terminalId);
            const rightTerminal = snapshot.rightTabs.find((tab) => tab.terminalId);
            if (leftTerminal) {
              bridge.dispatch({ type: "SELECT_TAB", group: "left", id: leftTerminal.id });
            } else if (rightTerminal) {
              bridge.dispatch({ type: "SELECT_TAB", group: "right", id: rightTerminal.id });
            } else {
              await bridge.openTerminalTab();
            }
          })();
          break;
        case "chat.action.openModelDropdown":
          dispatchChatComposerShortcut("openModelDropdown");
          break;
        case "chat.action.openModeDropdown":
          dispatchChatComposerShortcut("openModeDropdown");
          break;
        case "chat.action.openBackendDropdown":
          dispatchChatComposerShortcut("openBackendDropdown");
          break;
      case "chat.action.toggleVoiceInput": {
        const mode = voiceInputModeRef.current;
        if (mode === "hold") {
          if (!voiceHoldActiveRef.current) {
            voiceHoldActiveRef.current = true;
            dispatchChatComposerShortcut("startVoiceInput");
          }
        } else {
          dispatchChatComposerShortcut("toggleVoiceInput");
        }
        break;
      }
        case "chat.action.toggleComposerExpand":
          dispatchChatComposerShortcut("toggleComposerExpand");
          break;
        case "chat.action.attachImage":
          dispatchChatComposerShortcut("attachImage");
          break;
        case "chat.action.openWorkspacePicker":
          dispatchWorkspacePickerShortcut();
          break;
        case "chat.action.agentRailPreviousConversation":
          agentShell?.cycleAgentConversation(-1);
          break;
        case "chat.action.agentRailNextConversation":
          agentShell?.cycleAgentConversation(1);
          break;
        default:
          break;
      }
    },
    [
      bridgeRef,
      openSettingsView,
      openWorkspaceWindowsModal,
      promptForFolder,
      runWithBridge,
      setPalette,
      setShellView,
      setToast,
      updateWorkspaceSession,
      workbench,
      agentShell,
    ]
  );

  const handleWorkbenchKeyDown = useCallback(
    (e: KeyboardEvent) =>
      tryDispatchKeyboardShortcut({
        event: e,
        platform: shortcutPlatform,
        bindings: shortcutBindings,
        chordRef,
        onCommand: runShortcutCommand,
        editableTarget: isEditableShortcutTarget(e.target),
      }),
    [runShortcutCommand, shortcutBindings, shortcutPlatform]
  );

  const inputSinkWorkbenchBindings = useMemo(() => {
    const next = Object.fromEntries(
      SHORTCUT_COMMAND_DEFINITIONS.map((definition) => [definition.id, [] as string[]])
    ) as Record<string, string[]>;
    for (const id of INPUT_SINK_ALLOWED_SHORTCUT_IDS) {
      next[id] = getShortcutBindingsForCommand(shortcutBindings, id);
    }
    return next;
  }, [shortcutBindings]);

  const handleInputSinkWorkbenchKeyDown = useCallback(
    (e: KeyboardEvent) =>
      tryDispatchKeyboardShortcut({
        event: e,
        platform: shortcutPlatform,
        bindings: inputSinkWorkbenchBindings,
        chordRef,
        onCommand: runShortcutCommand,
        editableTarget: isEditableShortcutTarget(e.target),
      }),
    [inputSinkWorkbenchBindings, runShortcutCommand, shortcutPlatform]
  );

  const commands: PaletteCommand[] = useMemo(
    () => [
      {
        id: "palette.quickOpen",
        label: "Go to File…",
        keybinding: kb("palette.quickOpen"),
        run: () => runShortcutCommand("palette.quickOpen"),
      },
      {
        id: "palette.showCommands",
        label: "Show All Commands",
        keybinding: kb("palette.showCommands"),
        run: () => runShortcutCommand("palette.showCommands"),
      },
      {
        id: "workbench.action.toggleSidebarVisibility",
        label: "View: Toggle Primary Side Bar Visibility",
        keybinding: kb("workbench.action.toggleSidebarVisibility"),
        run: () => runShortcutCommand("workbench.action.toggleSidebarVisibility"),
      },
      {
        id: "workbench.view.explorer",
        label: "View: Show Explorer",
        keybinding: kb("workbench.view.explorer"),
        run: () => runShortcutCommand("workbench.view.explorer"),
      },
      {
        id: "workbench.action.togglePanel",
        label: "View: Toggle Panel",
        keybinding: kb("workbench.action.togglePanel"),
        run: () => runShortcutCommand("workbench.action.togglePanel"),
      },
      {
        id: "workbench.action.toggleAgentPanel",
        label: "View: Toggle Agent / Chat Side Panel",
        keybinding: kb("workbench.action.toggleAgentPanel"),
        run: () => runShortcutCommand("workbench.action.toggleAgentPanel"),
      },
      {
        id: "workbench.action.focusChatPlanMode",
        label: "Chat: Use Plan mode",
        keybinding: kb("workbench.action.focusChatPlanMode"),
        run: () => runShortcutCommand("workbench.action.focusChatPlanMode"),
      },
      {
        id: "workbench.action.focusChatAgentMode",
        label: "Chat: Use Agent mode",
        keybinding: kb("workbench.action.focusChatAgentMode"),
        run: () => runShortcutCommand("workbench.action.focusChatAgentMode"),
      },
      {
        id: "chat.action.openWorkspacePicker",
        label: "Chat: Open workspace picker",
        keybinding: kb("chat.action.openWorkspacePicker"),
        run: () => runShortcutCommand("chat.action.openWorkspacePicker"),
      },
      {
        id: "chat.action.openBackendDropdown",
        label: "Chat: Open ACP / backend picker",
        keybinding: kb("chat.action.openBackendDropdown"),
        run: () => runShortcutCommand("chat.action.openBackendDropdown"),
      },
      {
        id: "chat.action.openModeDropdown",
        label: "Chat: Open mode picker",
        keybinding: kb("chat.action.openModeDropdown"),
        run: () => runShortcutCommand("chat.action.openModeDropdown"),
      },
      {
        id: "chat.action.openModelDropdown",
        label: "Chat: Open model picker",
        keybinding: kb("chat.action.openModelDropdown"),
        run: () => runShortcutCommand("chat.action.openModelDropdown"),
      },
      {
        id: "chat.action.toggleVoiceInput",
        label: "Chat: Toggle voice input",
        keybinding: kb("chat.action.toggleVoiceInput"),
        run: () => runShortcutCommand("chat.action.toggleVoiceInput"),
      },
      {
        id: "chat.action.toggleComposerExpand",
        label: "Chat: Toggle expand composer",
        keybinding: kb("chat.action.toggleComposerExpand"),
        run: () => runShortcutCommand("chat.action.toggleComposerExpand"),
      },
      {
        id: "chat.action.attachImage",
        label: "Chat: Attach image",
        keybinding: kb("chat.action.attachImage"),
        run: () => runShortcutCommand("chat.action.attachImage"),
      },
      {
        id: "chat.action.agentRailPreviousConversation",
        label: "Agent: Previous conversation in rail",
        keybinding: kb("chat.action.agentRailPreviousConversation"),
        run: () => runShortcutCommand("chat.action.agentRailPreviousConversation"),
      },
      {
        id: "chat.action.agentRailNextConversation",
        label: "Agent: Next conversation in rail",
        keybinding: kb("chat.action.agentRailNextConversation"),
        run: () => runShortcutCommand("chat.action.agentRailNextConversation"),
      },
      {
        id: "recentChats.open",
        label: "Chat: Open Recent Chats",
        keybinding: kb("recentChats.open"),
        run: () => runShortcutCommand("recentChats.open"),
      },
      {
        id: "workbench.action.splitEditor",
        label: "View: Split Editor",
        keybinding: kb("workbench.action.splitEditor"),
        run: () => runShortcutCommand("workbench.action.splitEditor"),
      },
      {
        id: "workbench.action.splitEditorRight",
        label: "View: Split Editor Right",
        keybinding: kb("workbench.action.splitEditorRight"),
        run: () => runShortcutCommand("workbench.action.splitEditorRight"),
      },
      {
        id: "workbench.action.splitEditorDown",
        label: "View: Split Editor Down",
        keybinding: kb("workbench.action.splitEditorDown"),
        run: () => runShortcutCommand("workbench.action.splitEditorDown"),
      },
      {
        id: "workbench.action.openPreview",
        label: "Open Preview",
        keybinding: kb("workbench.action.openPreview"),
        run: () => runShortcutCommand("workbench.action.openPreview"),
      },
      {
        id: "workbench.action.closeActiveEditor",
        label: "View: Close Editor",
        keybinding: kb("workbench.action.closeActiveEditor"),
        run: () => runShortcutCommand("workbench.action.closeActiveEditor"),
      },
      {
        id: "workbench.action.closeAllEditors",
        label: "View: Close All Editors",
        run: () =>
          runWithBridge((b) => {
            const s = b.getState();
            b.requestCloseAllInGroup("left");
            if (s.split) b.requestCloseAllInGroup("right");
          }),
      },
      {
        id: "workbench.action.files.save",
        label: "File: Save",
        keybinding: kb("workbench.action.files.save"),
        run: () => runShortcutCommand("workbench.action.files.save"),
      },
      {
        id: "workbench.action.files.saveAll",
        label: "File: Save All",
        keybinding: kb("workbench.action.files.saveAll"),
        run: () => runShortcutCommand("workbench.action.files.saveAll"),
      },
      {
        id: "workbench.action.openGlobalSettings",
        label: "Preferences: Open User Settings",
        keybinding: kb("workbench.action.openGlobalSettings"),
        run: () => runShortcutCommand("workbench.action.openGlobalSettings"),
      },
      {
        id: "workbench.action.openServers",
        label: "Preferences: Open Servers",
        run: () => runShortcutCommand("workbench.action.openServers"),
      },
      {
        id: "workbench.colorTheme.light",
        label: "Preferences: Color Theme — Light",
        run: () => {
          setThemePreference("light");
          flash(setToast, "Color theme: Light");
        },
      },
      {
        id: "workbench.colorTheme.dark",
        label: "Preferences: Color Theme — Dark",
        run: () => {
          setThemePreference("dark");
          flash(setToast, "Color theme: Dark");
        },
      },
      {
        id: "workbench.colorTheme.system",
        label: "Preferences: Color Theme — Use System Setting",
        run: () => {
          setThemePreference("system");
          flash(setToast, "Color theme: Use system setting");
        },
      },
      {
        id: "workbench.action.openKeyboardShortcuts",
        label: "Preferences: Open Keyboard Shortcuts",
        keybinding: kb("workbench.action.openKeyboardShortcuts"),
        run: () => runShortcutCommand("workbench.action.openKeyboardShortcuts"),
      },
      {
        id: "workbench.action.quickOpen",
        label: "File: Quick Open",
        keybinding: kb("palette.quickOpen"),
        run: () => runShortcutCommand("palette.quickOpen"),
      },
      {
        id: "workbench.action.gotoFile",
        label: "View: Open File",
        keybinding: kb("workbench.action.gotoFile"),
        run: () => runShortcutCommand("workbench.action.gotoFile"),
      },
      {
        id: "workbench.action.newAgent",
        label: "File: New Agent",
        keybinding: kb("workbench.action.newAgent"),
        run: () => runShortcutCommand("workbench.action.newAgent"),
      },
      {
        id: "workbench.action.switchToAgent",
        label: "View: Switch to Agent Mode",
        run: () => {
          setShellView("agent");
        },
      },
      {
        id: "workbench.action.switchToEditor",
        label: "View: Switch to Editor Mode",
        run: () => {
          setShellView("editor");
        },
      },
      {
        id: "workbench.action.newWindow",
        label: "File: New Window...",
        keybinding: kb("workbench.action.newWindow"),
        run: () => runShortcutCommand("workbench.action.newWindow"),
      },
      {
        id: "workbench.action.window.manage",
        label: "Window: Workspace Windows...",
        run: () => runShortcutCommand("workbench.action.window.manage"),
      },
      {
        id: "workbench.action.newBrowser",
        label: "File: New Browser",
        run: () => openBrowserUrlPrompt(),
      },
      {
        id: "browser.openUrl",
        label: "Browser: Open URL…",
        run: () => openBrowserUrlPrompt(),
      },
      {
        id: "workbench.action.openFile",
        label: "File: Open File…",
        keybinding: kb("workbench.action.openFile"),
        run: () => runShortcutCommand("workbench.action.openFile"),
      },
      {
        id: "workbench.action.openFolder",
        label: "File: Open Folder…",
        keybinding: kb("workbench.action.openFolder"),
        run: () => runShortcutCommand("workbench.action.openFolder"),
      },
      {
        id: "workbench.action.createWorkspace",
        label: "Workspace: Create, Clone, Browse…",
        run: () => {
          promptForCreateWorkspace();
        },
      },
      {
        id: "workbench.action.removeWorkspace",
        label: "Workspace: Remove Workspace from List…",
        run: () => {
          promptToRemoveWorkspace();
        },
      },
      {
        id: "workbench.action.setDefaultWorkspace",
        label: "Workspace: Set Current Workspace as Default",
        run: () => {
          if (!activeWorkspaceId) {
            flash(setToast, "No active workspace.");
            return;
          }
          void setDefaultWorkspace(activeWorkspaceId).then(() => {
            flash(setToast, "Default workspace updated.");
          });
        },
      },
      {
        id: "workbench.action.refreshTree",
        label: "Explorer: Refresh File Tree",
        run: () => {
          void refreshTree().then(() => {
            flash(setToast, "Explorer refreshed.");
          });
        },
      },
      {
        id: "workbench.action.terminal.new",
        label: "Terminal: Create New Terminal",
        run: () =>
          void (async () => {
            const bridge = bridgeRef.current;
            if (!bridge) {
              flash(setToast, "Editor is not ready yet.");
              return;
            }
            await bridge.openTerminalTab();
          })(),
      },
      {
        id: "workbench.action.findInFiles",
        label: "Search: Find in Files",
        keybinding: kb("workbench.action.findInFiles"),
        run: () => runShortcutCommand("workbench.action.findInFiles"),
      },
      {
        id: "workbench.action.terminal.toggleTerminal",
        label: "View: Toggle Terminal",
        keybinding: kb("workbench.action.terminal.toggleTerminal"),
        run: () => runShortcutCommand("workbench.action.terminal.toggleTerminal"),
      },
      ...workspaces.map((workspace) => ({
        id: `workbench.action.workspace.switch.${workspace.id}`,
        label: `Workspace: Switch to ${workspace.name}${workspace.id === defaultWorkspaceId ? " (Default)" : ""}`,
        detail: workspace.root,
        run: () => {
          void openWorkspaceById(workspace.id).then(() => {
            flash(setToast, `Opened ${workspace.name}`);
          });
        },
      })),
      ...servers.map((server) => ({
        id: `workbench.action.server.switch.${server.id}`,
        label: `Server: Switch to ${server.label}${server.id === activeServer.id ? " (Active)" : ""}`,
        detail: server.baseUrl,
        run: () => {
          if (server.id === activeServer.id) {
            flash(setToast, `${server.label} is already active`);
            return;
          }
          setActiveServer(server.id);
          flash(setToast, `Switching to ${server.label}`);
          window.location.assign(WORKSPACE_ROUTE);
        },
      })),
    ],
    [
      activeServer.id,
      activeWorkspaceId,
      bridgeRef,
      defaultWorkspaceId,
      kb,
      openWorkspaceById,
      openBrowserUrlPrompt,
      promptForCreateWorkspace,
      promptToRemoveWorkspace,
      refreshTree,
      runShortcutCommand,
      servers,
      runWithBridge,
      setActiveServer,
      setDefaultWorkspace,
      setShellView,
      setThemePreference,
      workspaces,
    ]
  );

  const runCommand = useCallback(
    (id: string) => {
      const c = commands.find((x) => x.id === id);
      if (c) {
        c.run();
        return;
      }
      runShortcutCommand(id);
    },
    [commands, runShortcutCommand]
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target;
      const insidePalette =
        t instanceof Element && Boolean(t.closest("[data-ide-palette]"));
      const insideInputSink =
        t instanceof Element && Boolean(t.closest("[data-ide-input-sink]"));
      const nativeEditableTarget = shouldUseNativeEditableHandling(t);

      if (insidePalette) {
        if (hardwareInputEnabled && !nativeEditableTarget) {
          const routed = routeKeyDown(e);
          if (routed.handled) return;
        }
        return;
      }

      if (
        bridgeRef.current &&
        isFocusedBrowserSurface(bridgeRef.current, t)
      ) {
        if (hardwareInputEnabled && !nativeEditableTarget) {
          const routed = routeKeyDown(e);
          if (routed.handled) return;
        }
        return;
      }

      if (hardwareInputEnabled) {
        const routed = nativeEditableTarget
          ? { handled: false, allowWorkbenchShortcuts: true }
          : routeKeyDown(e);
        if (routed.handled) return;
        if (insideInputSink) {
          if (handleInputSinkWorkbenchKeyDown(e)) {
            return;
          }
          return;
        }
        if (!routed.allowWorkbenchShortcuts) return;
      } else if (insideInputSink) {
        if (handleInputSinkWorkbenchKeyDown(e)) {
          return;
        }
        return;
      }

      if (handleWorkbenchKeyDown(e)) {
        return;
      }
    };

    const onPaste = (e: ClipboardEvent) => {
      if (shouldUseNativeEditableHandling(e.target)) {
        return;
      }
      if (
        bridgeRef.current &&
        isFocusedBrowserSurface(bridgeRef.current, e.target)
      ) {
        return;
      }
      void handlePaste(e);
    };

    const onCopy = (e: ClipboardEvent) => {
      if (shouldUseNativeEditableHandling(e.target)) {
        return;
      }
      if (
        bridgeRef.current &&
        isFocusedBrowserSurface(bridgeRef.current, e.target)
      ) {
        return;
      }
      void handleCopy(e);
    };

    const onCut = (e: ClipboardEvent) => {
      if (shouldUseNativeEditableHandling(e.target)) {
        return;
      }
      if (
        bridgeRef.current &&
        isFocusedBrowserSurface(bridgeRef.current, e.target)
      ) {
        return;
      }
      void handleCut(e);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!voiceHoldActiveRef.current) return;
      const voiceBindings = getShortcutBindingsForCommand(
        shortcutBindings,
        "chat.action.toggleVoiceInput"
      );
      for (const bindingStr of voiceBindings) {
        const parsed = parseShortcutBinding(bindingStr);
        if (!parsed || parsed.length !== 1) continue;
        const step = parsed[0];
        if (!step) continue;
        if (matchesShortcutStep(e, step, shortcutPlatform)) {
          voiceHoldActiveRef.current = false;
          dispatchChatComposerShortcut("stopVoiceInput");
          return;
        }
      }
      if (e.key === "Meta" || e.key === "Control") {
        voiceHoldActiveRef.current = false;
        dispatchChatComposerShortcut("stopVoiceInput");
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    document.addEventListener("paste", onPaste, true);
    document.addEventListener("copy", onCopy, true);
    document.addEventListener("cut", onCut, true);
  return () => {
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("keyup", onKeyUp, true);
    document.removeEventListener("paste", onPaste, true);
      document.removeEventListener("copy", onCopy, true);
      document.removeEventListener("cut", onCut, true);
    };
}, [
  bridgeRef,
  handleInputSinkWorkbenchKeyDown,
  handleWorkbenchKeyDown,
  hardwareInputEnabled,
  routeKeyDown,
  handlePaste,
  handleCopy,
  handleCut,
  shortcutBindings,
  shortcutPlatform,
]);

  const onQuickPick = useCallback(
    (entry: QuickOpenEntry) => {
      openExplorerFile({
        path: entry.path,
        name: entry.name,
        language: entry.node.language ?? "plaintext",
        icon: inferEditorIcon(entry),
      });
    },
    [inferEditorIcon, openExplorerFile]
  );

  return (
    <IDECommandProvider value={runCommand}>
      {children}
      <CommandPalette
        open={palette === "command"}
        onClose={() => setPalette("closed")}
        commands={commands}
      />
      <QuickOpen
        open={palette === "quickopen"}
        onClose={() => setPalette("closed")}
        entries={quickEntries}
        onPick={onQuickPick}
      />
      <VSCodeQuickInputShell
        open={folderPromptOpen}
        onClose={() => setFolderPromptOpen(false)}
        screenReaderTitle="Open Folder"
        inputLabel="Folder path"
        placeholder="Enter folder path"
        value={folderPromptValue}
        onChange={setFolderPromptValue}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setFolderPromptOpen(false);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            void submitFolderPrompt();
          }
        }}
        onHardwareKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setFolderPromptOpen(false);
            return true;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            void submitFolderPrompt();
            return true;
          }
          return false;
        }}
      >
        <div className="border-t border-[var(--palette-divider)] px-[10px] py-[8px] font-sans text-[12px] text-[var(--palette-footer-text)]">
          Open a local workspace folder without using the browser prompt.
        </div>
      </VSCodeQuickInputShell>
      <WorkspaceStudioModal
        open={workspaceStudioOpen}
        onClose={() => setWorkspaceStudioOpen(false)}
        initialMode={workspaceStudioMode}
      />
      <VSCodeQuickInputShell
        open={browserPromptOpen}
        onClose={() => setBrowserPromptOpen(false)}
        screenReaderTitle="Open URL in Browser tab"
        inputLabel="URL"
        placeholder="http://localhost:3000/"
        value={browserPromptValue}
        onChange={setBrowserPromptValue}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setBrowserPromptOpen(false);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            submitBrowserPrompt();
          }
        }}
        onHardwareKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setBrowserPromptOpen(false);
            return true;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            submitBrowserPrompt();
            return true;
          }
          return false;
        }}
      >
        <div className="border-t border-[var(--palette-divider)] px-[10px] py-[8px] font-sans text-[12px] text-[var(--palette-footer-text)]">
          Loads through the Cesium server proxy. Public HTTPS is allowed by default; set BROWSER_PROXY_ALLOW_PUBLIC=0 on the API server to restrict to private/local hosts only.
        </div>
      </VSCodeQuickInputShell>
      <WorkspaceWindowsModal
        open={workspaceWindowsModalOpen}
        onClose={() => setWorkspaceWindowsModalOpen(false)}
        windows={workspaceWindows.filter((windowRecord) => !windowRecord.closedAt)}
        activeWindowId={activeWindowId}
        currentWindowLabel={
          workspaceWindows.find((windowRecord) => windowRecord.id === activeWindowId)?.label ??
          null
        }
        onCreateWindow={() => void createAndOpenWorkspaceWindow()}
        onOpenWindow={openWorkspaceWindow}
        onRenameCurrentWindow={isDedicatedWindow ? promptRenameCurrentWindow : undefined}
        initialSelectionId={workspaceWindowsModalInitialSelectionId}
      />
      <VSCodeQuickInputShell
        open={renameWindowOpen}
        onClose={() => setRenameWindowOpen(false)}
        screenReaderTitle="Rename workspace window"
        inputLabel="Window name"
        placeholder="Window name"
        value={renameWindowValue}
        onChange={setRenameWindowValue}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setRenameWindowOpen(false);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            void submitRenameCurrentWindow();
          }
        }}
        onHardwareKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setRenameWindowOpen(false);
            return true;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            void submitRenameCurrentWindow();
            return true;
          }
          return false;
        }}
      >
        <div className="border-t border-[var(--palette-divider)] px-[10px] py-[8px] font-sans text-[12px] text-[var(--palette-footer-text)]">
          Give this workspace window a persistent name so it is easy to find and reopen later.
        </div>
      </VSCodeQuickInputShell>
      {toast ? (
        <div
          className="pointer-events-none fixed bottom-[24px] left-1/2 z-[10060] max-w-[90vw] -translate-x-1/2 rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[14px] py-[8px] font-sans text-[12px] text-[var(--text-primary)] shadow-[var(--palette-shadow)]"
          role="status"
        >
          {toast}
        </div>
      ) : null}
    </IDECommandProvider>
  );
}
