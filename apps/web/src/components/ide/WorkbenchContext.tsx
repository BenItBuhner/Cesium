"use client";

import { createContext, useContext, type ReactNode } from "react";

export type WorkbenchControls = {
  toggleSidebar: () => void;
  toggleChat: () => void;
  revealExplorer: () => void;
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
