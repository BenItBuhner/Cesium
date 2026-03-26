"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import { buildQuickOpenIndex, type QuickOpenEntry } from "@/lib/quick-open-files";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";
import { QuickOpen } from "./QuickOpen";
import { useEditorBridgeRef } from "./EditorBridgeContext";
import { useWorkbench } from "./WorkbenchContext";
import { useTheme } from "@/components/theme/ThemeProvider";
import { IDECommandProvider } from "./IDECommandContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import type { EditorTab } from "@/lib/types";

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
  const { setPreference: setThemePreference } = useTheme();
  const { fileTree, workspaceInfo, refreshTree, openFolder } = useWorkspace();
  const [palette, setPalette] = useState<PaletteMode>("closed");
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

  const promptForFolder = useCallback(async () => {
    const root = window.prompt(
      "Open folder",
      workspaceInfo?.root ?? ""
    );
    if (!root) return;
    try {
      await openFolder(root);
      flash(setToast, `Opened ${root}`);
    } catch (error) {
      flash(
        setToast,
        error instanceof Error ? error.message : "Failed to open workspace."
      );
    }
  }, [openFolder, workspaceInfo?.root]);

  const runWithBridge = useCallback(
    (fn: (d: NonNullable<typeof bridgeRef.current>) => void) => {
      const b = bridgeRef.current;
      if (b) fn(b);
      else flash(setToast, "Editor is not ready yet.");
    },
    [bridgeRef]
  );

  const commands: PaletteCommand[] = useMemo(
    () => [
      {
        id: "palette.quickOpen",
        label: "Go to File…",
        keybinding: "Ctrl+P",
        run: () => setPalette("quickopen"),
      },
      {
        id: "palette.showCommands",
        label: "Show All Commands",
        keybinding: "Ctrl+Shift+P",
        run: () => setPalette("command"),
      },
      {
        id: "workbench.action.toggleSidebarVisibility",
        label: "View: Toggle Primary Side Bar Visibility",
        keybinding: "Ctrl+B",
        run: () => workbench.toggleSidebar(),
      },
      {
        id: "workbench.view.explorer",
        label: "View: Show Explorer",
        keybinding: "Ctrl+Shift+E",
        run: () => workbench.revealExplorer(),
      },
      {
        id: "workbench.action.togglePanel",
        label: "View: Toggle Panel",
        keybinding: "Ctrl+J",
        run: () => workbench.toggleChat(),
      },
      {
        id: "workbench.action.toggleAgentPanel",
        label: "View: Toggle Agent / Chat Side Panel",
        keybinding: "Ctrl+Shift+B · Ctrl+Alt+B",
        run: () => workbench.toggleChat(),
      },
      {
        id: "workbench.action.splitEditor",
        label: "View: Split Editor",
        keybinding: "Ctrl+\\",
        run: () =>
          runWithBridge((b) => b.dispatch({ type: "TOGGLE_SPLIT" })),
      },
      {
        id: "workbench.action.openPreview",
        label: "Open Preview",
        keybinding: "Ctrl+Shift+V",
        run: () =>
          runWithBridge((b) =>
            b.dispatch({ type: "TOGGLE_FILE_PREVIEW" })
          ),
      },
      {
        id: "workbench.action.closeActiveEditor",
        label: "View: Close Editor",
        keybinding: "Ctrl+W",
        run: () =>
          runWithBridge((b) => {
            const s = b.getState();
            const g = s.focusedGroup;
            const id =
              g === "left" ? s.leftActiveId : s.rightActiveId;
            if (id) b.dispatch({ type: "CLOSE_TAB", group: g, id });
          }),
      },
      {
        id: "workbench.action.closeAllEditors",
        label: "View: Close All Editors",
        run: () =>
          runWithBridge((b) => {
            const s = b.getState();
            b.dispatch({ type: "CLOSE_ALL_GROUP", group: "left" });
            if (s.split) b.dispatch({ type: "CLOSE_ALL_GROUP", group: "right" });
          }),
      },
      {
        id: "workbench.action.files.save",
        label: "File: Save",
        keybinding: "Ctrl+S",
        run: () =>
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
          })(),
      },
      {
        id: "workbench.action.files.saveAll",
        label: "File: Save All",
        keybinding: "Ctrl+K S",
        run: () => flash(setToast, "Save All (demo)."),
      },
      {
        id: "workbench.action.openGlobalSettings",
        label: "Preferences: Open User Settings",
        keybinding: "Ctrl+,",
        run: () =>
          runWithBridge((b) => b.dispatch({ type: "OPEN_SETTINGS_TAB" })),
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
        run: () => flash(setToast, "Keyboard shortcuts editor (demo)."),
      },
      {
        id: "workbench.action.quickOpen",
        label: "File: Quick Open",
        keybinding: "Ctrl+P",
        run: () => setPalette("quickopen"),
      },
      {
        id: "workbench.action.gotoFile",
        label: "View: Open File",
        keybinding: "Ctrl+G",
        run: () => setPalette("quickopen"),
      },
      {
        id: "workbench.action.newUntitledFile",
        label: "File: New Untitled Text File",
        keybinding: "Ctrl+N",
        run: () => flash(setToast, "New file (demo)."),
      },
      {
        id: "workbench.action.newAgent",
        label: "File: New Agent",
        run: () => router.push("/agent"),
      },
      {
        id: "workbench.action.newWindow",
        label: "File: New Window",
        keybinding: "Ctrl+Shift+N",
        run: () =>
          flash(setToast, "New window (demo — open another browser tab)."),
      },
      {
        id: "workbench.action.newBrowser",
        label: "File: New Browser",
        run: () => flash(setToast, "New browser (demo — not wired)."),
      },
      {
        id: "workbench.action.exit",
        label: "File: Exit",
        run: () => flash(setToast, "Exit (demo — this tab stays open)."),
      },
      {
        id: "workbench.action.openChanges",
        label: "View: Open Changes",
        keybinding: "Ctrl+E",
        run: () => flash(setToast, "Open Changes (demo — no SCM diff yet)."),
      },
      {
        id: "editor.action.undo",
        label: "Edit: Undo",
        keybinding: "Ctrl+Z",
        run: () => flash(setToast, "Undo (demo)."),
      },
      {
        id: "editor.action.redo",
        label: "Edit: Redo",
        keybinding: "Ctrl+Y",
        run: () => flash(setToast, "Redo (demo)."),
      },
      {
        id: "editor.action.clipboardCut",
        label: "Edit: Cut",
        keybinding: "Ctrl+X",
        run: () => flash(setToast, "Cut (demo)."),
      },
      {
        id: "editor.action.clipboardCopy",
        label: "Edit: Copy",
        keybinding: "Ctrl+C",
        run: () => flash(setToast, "Copy (demo)."),
      },
      {
        id: "editor.action.clipboardPaste",
        label: "Edit: Paste",
        keybinding: "Ctrl+V",
        run: () => flash(setToast, "Paste (demo)."),
      },
      {
        id: "editor.action.selectAll",
        label: "Edit: Select All",
        keybinding: "Ctrl+A",
        run: () => flash(setToast, "Select All (demo)."),
      },
      {
        id: "workbench.action.openFile",
        label: "File: Open File…",
        keybinding: "Ctrl+O",
        run: () => setPalette("quickopen"),
      },
      {
        id: "workbench.action.openFolder",
        label: "File: Open Folder…",
        keybinding: "Ctrl+Shift+O",
        run: () => {
          void promptForFolder();
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
        keybinding: "Ctrl+Shift+F",
        run: () => {
          workbench.revealExplorer();
          flash(setToast, "Find in Files — use the sidebar Search view.");
        },
      },
      {
        id: "workbench.action.terminal.toggleTerminal",
        label: "View: Toggle Terminal",
        keybinding: "Ctrl+`",
        run: () =>
          void (async () => {
            const bridge = bridgeRef.current;
            if (!bridge) {
              flash(setToast, "Editor is not ready yet.");
              return;
            }
            const s = bridge.getState();
            const leftTerminal = s.leftTabs.find((t) => t.terminalId);
            const rightTerminal = s.rightTabs.find((t) => t.terminalId);
            if (leftTerminal) {
              bridge.dispatch({ type: "SELECT_TAB", group: "left", id: leftTerminal.id });
              return;
            }
            if (rightTerminal) {
              bridge.dispatch({ type: "SELECT_TAB", group: "right", id: rightTerminal.id });
              return;
            }
            await bridge.openTerminalTab();
          })(),
      },
      {
        id: "workbench.action.reloadWindow",
        label: "Developer: Reload Window",
        keybinding: "Ctrl+R",
        run: () => flash(setToast, "Reload Window — use the browser refresh."),
      },
      {
        id: "workbench.action.zoomIn",
        label: "View: Zoom In",
        keybinding: "Ctrl+=",
        run: () => flash(setToast, "Zoom (demo)."),
      },
      {
        id: "workbench.action.zoomOut",
        label: "View: Zoom Out",
        keybinding: "Ctrl+-",
        run: () => flash(setToast, "Zoom (demo)."),
      },
      {
        id: "workbench.action.zoomReset",
        label: "View: Reset Zoom",
        keybinding: "Ctrl+0",
        run: () => flash(setToast, "Reset zoom (demo)."),
      },
      {
        id: "workbench.action.showCommands",
        label: "Help: Welcome",
        run: () => flash(setToast, "Welcome page (demo)."),
      },
    ],
    [bridgeRef, promptForFolder, refreshTree, router, runWithBridge, setThemePreference, workbench]
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
      if (t instanceof Element) {
        if (t.closest("[data-ide-palette]")) return;
        if (t.closest("[data-ide-input-sink]")) return;
      }

      if (e.key === "F1") {
        e.preventDefault();
        setPalette("command");
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      const key = e.key.toLowerCase();

      if (key === "p" && !e.shiftKey) {
        e.preventDefault();
        setPalette("quickopen");
        return;
      }
      if (key === "p" && e.shiftKey) {
        e.preventDefault();
        setPalette("command");
        return;
      }
      if (key === "b" && e.shiftKey) {
        e.preventDefault();
        workbench.toggleChat();
        return;
      }
      if (key === "b" && e.altKey) {
        e.preventDefault();
        workbench.toggleChat();
        return;
      }
      if (key === "b" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        workbench.toggleSidebar();
        return;
      }
      if (key === "e" && e.shiftKey) {
        e.preventDefault();
        workbench.revealExplorer();
        return;
      }
      if (key === "j" && !e.shiftKey) {
        e.preventDefault();
        workbench.toggleChat();
        return;
      }
      if (key === "w" && !e.shiftKey) {
        e.preventDefault();
        runWithBridge((b) => {
          const s = b.getState();
          const g = s.focusedGroup;
          const id = g === "left" ? s.leftActiveId : s.rightActiveId;
          if (id) b.dispatch({ type: "CLOSE_TAB", group: g, id });
        });
        return;
      }
      if (key === "s" && !e.shiftKey) {
        e.preventDefault();
        const bridge = bridgeRef.current;
        if (!bridge) {
          flash(setToast, "Editor is not ready yet.");
          return;
        }
        void bridge.saveActiveTab().then((saved) => {
          if (!saved) {
            flash(setToast, "Active editor cannot be saved.");
          }
        });
        return;
      }
      if (e.code === "Comma" && !e.shiftKey) {
        e.preventDefault();
        runWithBridge((b) => b.dispatch({ type: "OPEN_SETTINGS_TAB" }));
        return;
      }
      if (key === "n" && !e.shiftKey) {
        e.preventDefault();
        flash(setToast, "New file (demo).");
        return;
      }
      if (key === "o" && !e.shiftKey) {
        e.preventDefault();
        setPalette("quickopen");
        return;
      }
      if (key === "g" && !e.shiftKey) {
        e.preventDefault();
        setPalette("quickopen");
        return;
      }
      if (key === "e" && !e.shiftKey) {
        e.preventDefault();
        flash(setToast, "Open Changes (demo — no SCM diff yet).");
        return;
      }
      if (key === "v" && e.shiftKey) {
        e.preventDefault();
        runWithBridge((b) =>
          b.dispatch({ type: "TOGGLE_FILE_PREVIEW" })
        );
        return;
      }
      if (e.code === "Backslash" && !e.shiftKey) {
        e.preventDefault();
        runWithBridge((b) => b.dispatch({ type: "TOGGLE_SPLIT" }));
        return;
      }
      if (key === "f" && e.shiftKey) {
        e.preventDefault();
        workbench.revealExplorer();
        flash(setToast, "Find in Files — open Search in the sidebar.");
        return;
      }
      if (e.code === "Backquote" && !e.shiftKey) {
        e.preventDefault();
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
          void bridge.openTerminalTab();
        }
        return;
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [bridgeRef, runWithBridge, workbench]);

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
