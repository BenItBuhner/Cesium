"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import { buildQuickOpenIndex, type QuickOpenEntry } from "@/lib/quick-open-files";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";
import { QuickOpen } from "./QuickOpen";
import { VSCodeQuickInputShell } from "./VSCodeQuickInputShell";
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
import {
  detectShortcutPlatform,
  getShortcutDisplayForCommand,
  tryDispatchKeyboardShortcut,
  type ShortcutChordState,
} from "@/lib/keyboard-shortcuts";

type PaletteMode = "closed" | "command" | "quickopen";

function flash(setter: (s: string | null) => void, msg: string) {
  setter(msg);
  window.setTimeout(() => setter(null), 2200);
}

export function IDEKeyboardLayer({ children }: { children: ReactNode }) {
  const router = useRouter();
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
  const shortcutBindings = settings.keyboardShortcuts.bindings;
  const shortcutPlatform = useMemo(() => detectShortcutPlatform(), []);
  const chordRef = useRef<ShortcutChordState | null>(null);

  const {
    activeWorkspaceId,
    defaultWorkspaceId,
    fileTree,
    workspaceInfo,
    workspaces,
    refreshTree,
    openFolder,
    openWorkspaceById,
    createWorkspace,
    setDefaultWorkspace,
    updateWorkspaceSession,
  } = useWorkspace();
  const [palette, setPalette] = useState<PaletteMode>("closed");
  const [folderPromptOpen, setFolderPromptOpen] = useState(false);
  const [folderPromptValue, setFolderPromptValue] = useState("");
  const [createWorkspaceNameOpen, setCreateWorkspaceNameOpen] = useState(false);
  const [createWorkspaceNameValue, setCreateWorkspaceNameValue] = useState("");
  const [createWorkspaceParentOpen, setCreateWorkspaceParentOpen] = useState(false);
  const [createWorkspaceParentValue, setCreateWorkspaceParentValue] = useState(
    "/home/bennett/projects"
  );
  const [pendingWorkspaceName, setPendingWorkspaceName] = useState("");
  const [browserPromptOpen, setBrowserPromptOpen] = useState(false);
  const [browserPromptValue, setBrowserPromptValue] = useState(
    "http://localhost:3000/"
  );
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
    setCreateWorkspaceNameValue("");
    setCreateWorkspaceNameOpen(true);
  }, []);

  const submitCreateWorkspaceName = useCallback(() => {
    const name = createWorkspaceNameValue.trim();
    if (!name) return;
    setPendingWorkspaceName(name);
    setCreateWorkspaceNameOpen(false);
    setCreateWorkspaceParentValue("/home/bennett/projects");
    setCreateWorkspaceParentOpen(true);
  }, [createWorkspaceNameValue]);

  const submitCreateWorkspaceParent = useCallback(async () => {
    const parentPath = createWorkspaceParentValue.trim();
    const name = pendingWorkspaceName.trim();
    if (!parentPath || !name) return;

    try {
      await createWorkspace({
        name,
        parentPath,
        directoryName: name,
      });
      setCreateWorkspaceParentOpen(false);
      setPendingWorkspaceName("");
      flash(setToast, `Created workspace ${name}`);
    } catch (error) {
      flash(
        setToast,
        error instanceof Error ? error.message : "Failed to create workspace."
      );
    }
  }, [createWorkspace, createWorkspaceParentValue, pendingWorkspaceName]);

  const openBrowserUrlPrompt = useCallback(() => {
    setPalette("closed");
    setBrowserPromptValue("http://localhost:3000/");
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
        case "workbench.action.focusChatAgentMode":
          updateWorkspaceSession((current) => ({
            ...current,
            chat: { ...current.chat, mode: "agent" },
          }));
          break;
        case "workbench.action.openGlobalSettings":
          runWithBridge((b) => b.dispatch({ type: "OPEN_SETTINGS_TAB" }));
          break;
        case "workbench.action.openKeyboardShortcuts":
          updateWorkspaceSession((current) => ({
            ...current,
            settingsView: { ...current.settingsView, activeNav: "keyboardShortcuts" },
          }));
          runWithBridge((b) => b.dispatch({ type: "OPEN_SETTINGS_TAB" }));
          break;
        case "workbench.action.openFile":
        case "workbench.action.gotoFile":
          setPalette("quickopen");
          break;
        case "workbench.action.openFolder":
          promptForFolder();
          break;
        case "workbench.action.newUntitledFile":
          flash(setToast, "New file (demo).");
          break;
        case "workbench.action.newWindow":
          flash(setToast, "New window (demo — open another browser tab).");
          break;
        case "workbench.action.newAgent":
          router.push("/agent");
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
          flash(setToast, "Save All (demo).");
          break;
        case "workbench.action.splitEditor":
          runWithBridge((b) => b.dispatch({ type: "TOGGLE_SPLIT" }));
          break;
        case "workbench.action.openPreview":
          runWithBridge((b) => b.dispatch({ type: "TOGGLE_FILE_PREVIEW" }));
          break;
        case "workbench.action.openChanges":
          flash(setToast, "Open Changes (demo — no SCM diff yet).");
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
        case "editor.action.undo":
          flash(setToast, "Undo (demo).");
          break;
        case "editor.action.redo":
          flash(setToast, "Redo (demo).");
          break;
        case "editor.action.clipboardCut":
          flash(setToast, "Cut (demo).");
          break;
        case "editor.action.clipboardCopy":
          flash(setToast, "Copy (demo).");
          break;
        case "editor.action.clipboardPaste":
          flash(setToast, "Paste (demo).");
          break;
        case "editor.action.selectAll":
          flash(setToast, "Select All (demo).");
          break;
        case "workbench.action.reloadWindow":
          flash(setToast, "Reload Window — use the browser refresh.");
          break;
        case "workbench.action.zoomIn":
        case "workbench.action.zoomOut":
        case "workbench.action.zoomReset":
          flash(setToast, "Zoom (demo).");
          break;
        default:
          break;
      }
    },
    [
      bridgeRef,
      promptForFolder,
      router,
      runWithBridge,
      setPalette,
      setToast,
      updateWorkspaceSession,
      workbench,
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
      }),
    [runShortcutCommand, shortcutBindings, shortcutPlatform]
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
        id: "workbench.action.splitEditor",
        label: "View: Split Editor",
        keybinding: kb("workbench.action.splitEditor"),
        run: () => runShortcutCommand("workbench.action.splitEditor"),
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
        id: "workbench.action.newUntitledFile",
        label: "File: New Untitled Text File",
        keybinding: kb("workbench.action.newUntitledFile"),
        run: () => runShortcutCommand("workbench.action.newUntitledFile"),
      },
      {
        id: "workbench.action.newAgent",
        label: "File: New Agent",
        keybinding: kb("workbench.action.newAgent"),
        run: () => runShortcutCommand("workbench.action.newAgent"),
      },
      {
        id: "workbench.action.newWindow",
        label: "File: New Window",
        keybinding: kb("workbench.action.newWindow"),
        run: () => runShortcutCommand("workbench.action.newWindow"),
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
        id: "workbench.action.exit",
        label: "File: Exit",
        run: () => flash(setToast, "Exit (demo — this tab stays open)."),
      },
      {
        id: "workbench.action.openChanges",
        label: "View: Open Changes",
        keybinding: kb("workbench.action.openChanges"),
        run: () => runShortcutCommand("workbench.action.openChanges"),
      },
      {
        id: "editor.action.undo",
        label: "Edit: Undo",
        keybinding: kb("editor.action.undo"),
        run: () => runShortcutCommand("editor.action.undo"),
      },
      {
        id: "editor.action.redo",
        label: "Edit: Redo",
        keybinding: kb("editor.action.redo"),
        run: () => runShortcutCommand("editor.action.redo"),
      },
      {
        id: "editor.action.clipboardCut",
        label: "Edit: Cut",
        keybinding: kb("editor.action.clipboardCut"),
        run: () => runShortcutCommand("editor.action.clipboardCut"),
      },
      {
        id: "editor.action.clipboardCopy",
        label: "Edit: Copy",
        keybinding: kb("editor.action.clipboardCopy"),
        run: () => runShortcutCommand("editor.action.clipboardCopy"),
      },
      {
        id: "editor.action.clipboardPaste",
        label: "Edit: Paste",
        keybinding: kb("editor.action.clipboardPaste"),
        run: () => runShortcutCommand("editor.action.clipboardPaste"),
      },
      {
        id: "editor.action.selectAll",
        label: "Edit: Select All",
        keybinding: kb("editor.action.selectAll"),
        run: () => runShortcutCommand("editor.action.selectAll"),
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
        label: "Workspace: Create New Workspace…",
        run: () => {
          promptForCreateWorkspace();
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
        id: "editor.action.revealDefinition",
        label: "Go to Definition",
        keybinding: "F12",
        run: () => flash(setToast, "Go to Definition (demo)."),
      },
      {
        id: "editor.action.goToReferences",
        label: "Go to References",
        keybinding: "Shift+F12",
        run: () => flash(setToast, "Find all references (demo)."),
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
      {
        id: "workbench.action.reloadWindow",
        label: "Developer: Reload Window",
        keybinding: kb("workbench.action.reloadWindow"),
        run: () => runShortcutCommand("workbench.action.reloadWindow"),
      },
      {
        id: "workbench.action.zoomIn",
        label: "View: Zoom In",
        keybinding: kb("workbench.action.zoomIn"),
        run: () => runShortcutCommand("workbench.action.zoomIn"),
      },
      {
        id: "workbench.action.zoomOut",
        label: "View: Zoom Out",
        keybinding: kb("workbench.action.zoomOut"),
        run: () => runShortcutCommand("workbench.action.zoomOut"),
      },
      {
        id: "workbench.action.zoomReset",
        label: "View: Reset Zoom",
        keybinding: kb("workbench.action.zoomReset"),
        run: () => runShortcutCommand("workbench.action.zoomReset"),
      },
      {
        id: "workbench.action.showCommands",
        label: "Help: Welcome",
        run: () => flash(setToast, "Welcome page (demo)."),
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
    ],
    [
      activeWorkspaceId,
      bridgeRef,
      defaultWorkspaceId,
      kb,
      openWorkspaceById,
      openBrowserUrlPrompt,
      promptForCreateWorkspace,
      refreshTree,
      runShortcutCommand,
      runWithBridge,
      setDefaultWorkspace,
      setThemePreference,
      workspaces,
    ]
  );

  const runCommand = useCallback(
    (id: string) => {
      const c = commands.find((x) => x.id === id);
      c?.run();
    },
    [commands]
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target;
      const insidePalette =
        t instanceof Element && Boolean(t.closest("[data-ide-palette]"));
      const insideInputSink =
        t instanceof Element && Boolean(t.closest("[data-ide-input-sink]"));

      if (insidePalette) {
        if (hardwareInputEnabled) {
          const routed = routeKeyDown(e);
          if (routed.handled) return;
        }
        return;
      }

      if (
        bridgeRef.current &&
        isFocusedBrowserSurface(bridgeRef.current, t)
      ) {
        if (hardwareInputEnabled) {
          const routed = routeKeyDown(e);
          if (routed.handled) return;
        }
        return;
      }

      if (hardwareInputEnabled) {
        const routed = routeKeyDown(e);
        if (routed.handled) return;
        if (insideInputSink) return;
        if (!routed.allowWorkbenchShortcuts) return;
      } else if (insideInputSink) {
        return;
      }

      if (handleWorkbenchKeyDown(e)) {
        return;
      }
    };

    const onPaste = (e: ClipboardEvent) => {
      if (
        bridgeRef.current &&
        isFocusedBrowserSurface(bridgeRef.current, e.target)
      ) {
        return;
      }
      void handlePaste(e);
    };

    const onCopy = (e: ClipboardEvent) => {
      if (
        bridgeRef.current &&
        isFocusedBrowserSurface(bridgeRef.current, e.target)
      ) {
        return;
      }
      void handleCopy(e);
    };

    const onCut = (e: ClipboardEvent) => {
      if (
        bridgeRef.current &&
        isFocusedBrowserSurface(bridgeRef.current, e.target)
      ) {
        return;
      }
      void handleCut(e);
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("paste", onPaste, true);
    document.addEventListener("copy", onCopy, true);
    document.addEventListener("cut", onCut, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("paste", onPaste, true);
      document.removeEventListener("copy", onCopy, true);
      document.removeEventListener("cut", onCut, true);
    };
  }, [
    bridgeRef,
    handleWorkbenchKeyDown,
    hardwareInputEnabled,
    routeKeyDown,
    handlePaste,
    handleCopy,
    handleCut,
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
      <VSCodeQuickInputShell
        open={createWorkspaceNameOpen}
        screenReaderTitle="Create workspace"
        inputLabel="Workspace name"
        placeholder="Workspace name"
        value={createWorkspaceNameValue}
        onChange={setCreateWorkspaceNameValue}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setCreateWorkspaceNameOpen(false);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            submitCreateWorkspaceName();
          }
        }}
        onHardwareKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setCreateWorkspaceNameOpen(false);
            return true;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            submitCreateWorkspaceName();
            return true;
          }
          return false;
        }}
      >
        <div className="border-t border-[var(--palette-divider)] px-[10px] py-[8px] font-sans text-[12px] text-[var(--palette-footer-text)]">
          Choose the new workspace folder name. The next step picks the parent directory.
        </div>
      </VSCodeQuickInputShell>
      <VSCodeQuickInputShell
        open={createWorkspaceParentOpen}
        screenReaderTitle="Create workspace parent"
        inputLabel="Parent directory"
        placeholder="/home/bennett/projects"
        value={createWorkspaceParentValue}
        onChange={setCreateWorkspaceParentValue}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setCreateWorkspaceParentOpen(false);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            void submitCreateWorkspaceParent();
          }
        }}
        onHardwareKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setCreateWorkspaceParentOpen(false);
            return true;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            void submitCreateWorkspaceParent();
            return true;
          }
          return false;
        }}
      >
        <div className="border-t border-[var(--palette-divider)] px-[10px] py-[8px] font-sans text-[12px] text-[var(--palette-footer-text)]">
          Create <span className="font-semibold text-[var(--palette-input-text)]">{pendingWorkspaceName || "workspace"}</span> inside this directory.
        </div>
      </VSCodeQuickInputShell>
      <VSCodeQuickInputShell
        open={browserPromptOpen}
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
          Loads through the OpenCursor server proxy. Public HTTPS is allowed by default; set BROWSER_PROXY_ALLOW_PUBLIC=0 on the API server to restrict to private/local hosts only.
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
