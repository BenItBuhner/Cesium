"use client";

import type { ReactNode } from "react";
import { OpenInEditorProvider } from "@/components/editor/OpenInEditorContext";
import { EditorBridgeProvider } from "@/components/ide/EditorBridgeContext";
import {
  WorkbenchProvider,
  type WorkbenchControls,
} from "@/components/ide/WorkbenchContext";
import { IDEKeyboardLayer } from "@/components/ide/IDEKeyboardLayer";
import { WorkbenchContextMenuProvider } from "@/components/ide/WorkbenchContextMenuProvider";
import { HardwareInputProvider } from "@/components/input/HardwareInputProvider";

export function WorkbenchShellProviders({
  workbench,
  children,
}: {
  workbench: WorkbenchControls;
  children: ReactNode;
}) {
  return (
    <OpenInEditorProvider>
      <WorkbenchContextMenuProvider>
        <EditorBridgeProvider>
          <WorkbenchProvider value={workbench}>
            <HardwareInputProvider>
              <IDEKeyboardLayer>{children}</IDEKeyboardLayer>
            </HardwareInputProvider>
          </WorkbenchProvider>
        </EditorBridgeProvider>
      </WorkbenchContextMenuProvider>
    </OpenInEditorProvider>
  );
}
