"use client";

import { Suspense, type ReactNode } from "react";
import { AgentLayout } from "@/components/layout/AgentLayout";
import { IDELayout } from "@/components/layout/IDELayout";
import { ShellViewProvider, useShellView } from "@/components/layout/ShellViewContext";

function WorkbenchShell() {
  const { shellView } = useShellView();
  return shellView === "agent" ? <AgentLayout /> : <IDELayout />;
}

function LoadingFallback() {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg-main)] font-sans text-[13px] text-[var(--text-secondary)]">
      Loading workspace...
    </div>
  );
}

export function WorkbenchApp({
  suspenseFallback,
}: {
  /** Optional; defaults to the same copy as WorkspaceProvider shell. */
  suspenseFallback?: ReactNode;
}) {
  return (
    <Suspense fallback={suspenseFallback ?? <LoadingFallback />}>
      <ShellViewProvider>
        <WorkbenchShell />
      </ShellViewProvider>
    </Suspense>
  );
}
