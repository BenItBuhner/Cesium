"use client";

import { useMemo } from "react";
import { SettingsEditorView } from "@/components/editor/SettingsEditorView";
import { EditorBridgeProvider } from "@/components/ide/EditorBridgeContext";
import { IDEKeyboardLayer } from "@/components/ide/IDEKeyboardLayer";
import { WorkbenchProvider } from "@/components/ide/WorkbenchContext";
import { HardwareInputProvider } from "@/components/input/HardwareInputProvider";
import { useShellView } from "@/components/layout/ShellViewContext";

export function SettingsShellView() {
  const { closeSettingsView } = useShellView();
  const workbench = useMemo(
    () => ({
      toggleSidebar: () => {},
      toggleChat: () => {},
      revealExplorer: () => {},
      primarySidebarVisible: false,
    }),
    []
  );

  return (
    <EditorBridgeProvider>
      <WorkbenchProvider value={workbench}>
        <HardwareInputProvider>
          <IDEKeyboardLayer>
            <div className="h-screen w-screen overflow-hidden bg-[var(--bg-main)]">
              <SettingsEditorView onCloseShell={closeSettingsView} />
            </div>
          </IDEKeyboardLayer>
        </HardwareInputProvider>
      </WorkbenchProvider>
    </EditorBridgeProvider>
  );
}
