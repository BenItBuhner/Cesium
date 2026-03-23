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
import { fileTree, resolveExplorerOpenRequest } from "@/lib/mock-data";
import { buildQuickOpenIndex, type QuickOpenEntry } from "@/lib/quick-open-files";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";
import { QuickOpen } from "./QuickOpen";
import { useEditorBridgeRef } from "./EditorBridgeContext";
import { useWorkbench } from "./WorkbenchContext";
import { useTheme } from "@/components/theme/ThemeProvider";
import { IDECommandProvider } from "./IDECommandContext";

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
  const [palette, setPalette] = useState<PaletteMode>("closed");
  const [toast, setToast] = useState<string | null>(null);

  const quickEntries = useMemo(() => buildQuickOpenIndex(fileTree), []);

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
        id: "markdown.showPreview",
        label: "Markdown: Open Preview",
        keybinding: "Ctrl+Shift+V",
        run: () =>
          runWithBridge((b) =>
            b.dispatch({ type: "TOGGLE_MARKDOWN_PREVIEW" })
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
        run: () => flash(setToast, "Save (demo — no disk write)."),
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
        run: () => flash(setToast, "Settings UI (not wired in this demo)."),
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
          runWithBridge((b) => {
            const s = b.getState();
            const inLeft = s.leftTabs.some((t) => t.id === "bash");
            const inRight = s.rightTabs.some((t) => t.id === "bash");
            if (inLeft) {
              b.dispatch({ type: "SELECT_TAB", group: "left", id: "bash" });
              return;
            }
            if (inRight) {
              b.dispatch({ type: "SELECT_TAB", group: "right", id: "bash" });
              return;
            }
            flash(setToast, "Terminal tab not found in this session.");
          }),
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
    [router, runWithBridge, setThemePreference, workbench]
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
        flash(setToast, "Save (demo — no disk write).");
        return;
      }
      if (e.code === "Comma" && !e.shiftKey) {
        e.preventDefault();
        flash(setToast, "Settings UI (not wired in this demo).");
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
          b.dispatch({ type: "TOGGLE_MARKDOWN_PREVIEW" })
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
        runWithBridge((b) => {
          const s = b.getState();
          if (s.leftTabs.some((t) => t.id === "bash")) {
            b.dispatch({ type: "SELECT_TAB", group: "left", id: "bash" });
          } else if (s.rightTabs.some((t) => t.id === "bash")) {
            b.dispatch({ type: "SELECT_TAB", group: "right", id: "bash" });
          } else {
            flash(setToast, "Terminal tab not found in this session.");
          }
        });
        return;
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [runWithBridge, workbench]);

  const onQuickPick = useCallback(
    (entry: QuickOpenEntry) => {
      openExplorerFile(resolveExplorerOpenRequest(entry.path, entry.node));
    },
    [openExplorerFile]
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
