"use client";

import { createContext, useContext, type ReactNode } from "react";

export type WorkbenchControls = {
  toggleSidebar: () => void;
  toggleChat: () => void;
  revealExplorer: () => void;
  /** Primary file sidebar / explorer column is expanded and visible in the layout. */
  primarySidebarVisible: boolean;
  /** Editor's leading edge is exposed beneath native window controls. */
  editorLeadingWindowControlsVisible: boolean;
  /** Editor toolbar actions are exposed beneath native window controls. */
  editorTrailingWindowControlsVisible: boolean;
  /** Chat/right pane toolbar actions are exposed beneath native window controls. */
  chatTrailingWindowControlsVisible: boolean;
};

const WorkbenchContext = createContext<WorkbenchControls | null>(null);

export function WorkbenchProvider({
  value,
  children,
}: {
  value: WorkbenchControls;
  children: ReactNode;
}) {
  return (
    <WorkbenchContext.Provider value={value}>
      {children}
    </WorkbenchContext.Provider>
  );
}

export function useWorkbench(): WorkbenchControls {
  const ctx = useContext(WorkbenchContext);
  if (!ctx) {
    throw new Error("useWorkbench must be used within WorkbenchProvider");
  }
  return ctx;
}
