"use client";

import { Suspense, useSyncExternalStore, type ReactNode } from "react";
import { DocsPageView } from "@/components/docs/DocsPageView";
import { AgentConversationsProvider } from "@/components/chat/AgentConversationsContext";
import { OpenInEditorProvider } from "@/components/editor/OpenInEditorContext";
import { AgentLayout } from "@/components/layout/AgentLayout";
import { IDELayout } from "@/components/layout/IDELayout";
import { MobileBridgeSync } from "@/components/mobile/MobileBridgeSync";
import { SettingsShellView } from "@/components/layout/SettingsShellView";
import { ShellViewProvider, useShellView } from "@/components/layout/ShellViewContext";
import { isDocsRoute } from "@/lib/open-documentation";

function subscribeToDocsRoute(onStoreChange: () => void) {
  const sync = () => onStoreChange();
  window.addEventListener("popstate", sync);
  window.addEventListener("cesium:desktop-navigation", sync);
  return () => {
    window.removeEventListener("popstate", sync);
    window.removeEventListener("cesium:desktop-navigation", sync);
  };
}

function readDocsRouteActive() {
  return isDocsRoute();
}

function useDocsRouteActive() {
  return useSyncExternalStore(subscribeToDocsRoute, readDocsRouteActive, () => false);
}

function WorkbenchShell() {
  const { shellView } = useShellView();
  if (shellView === "settings") {
    return <SettingsShellView />;
  }
  return shellView === "agent" ? <AgentLayout /> : <IDELayout />;
}

function WorkbenchWithConversationProviders() {
  return (
    <OpenInEditorProvider>
      <AgentConversationsProvider>
        <MobileBridgeSync />
        <WorkbenchShell />
      </AgentConversationsProvider>
    </OpenInEditorProvider>
  );
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
  const docsRouteActive = useDocsRouteActive();
  if (docsRouteActive) {
    return <DocsPageView />;
  }

  return (
    <Suspense fallback={suspenseFallback ?? <LoadingFallback />}>
      <ShellViewProvider>
        <WorkbenchWithConversationProviders />
      </ShellViewProvider>
    </Suspense>
  );
}
