"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import type { WorkbenchShellView } from "@/lib/workspace-session";
import { WORKBENCH_VIEW_SEARCH_PARAM } from "@/lib/workbench-view";

export { WORKBENCH_VIEW_SEARCH_PARAM };

type ShellViewContextValue = {
  shellView: WorkbenchShellView;
  setShellView: (next: WorkbenchShellView) => void;
};

const ShellViewContext = createContext<ShellViewContextValue | null>(null);

export function ShellViewProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { workspaceSession, updateWorkspaceSession, sessionReady } = useWorkspace();

  const explicitView = searchParams.get(WORKBENCH_VIEW_SEARCH_PARAM);

  const shellView: WorkbenchShellView = useMemo(() => {
    if (!sessionReady) {
      return explicitView === "editor" ? "editor" : "agent";
    }
    return workspaceSession.layout.shellView === "editor" ? "editor" : "agent";
  }, [explicitView, sessionReady, workspaceSession.layout.shellView]);

  const setShellView = useCallback(
    (next: WorkbenchShellView) => {
      const url = new URL(window.location.href);
      if (next === "editor") {
        url.searchParams.set(WORKBENCH_VIEW_SEARCH_PARAM, "editor");
      } else {
        url.searchParams.delete(WORKBENCH_VIEW_SEARCH_PARAM);
      }
      updateWorkspaceSession((c) => ({
        ...c,
        layout: { ...c.layout, shellView: next },
      }));
      router.replace(`${url.pathname}${url.search}${url.hash}`);
    },
    [router, updateWorkspaceSession]
  );

  useEffect(() => {
    if (!sessionReady) {
      return;
    }
    const wantsEditor = workspaceSession.layout.shellView === "editor";
    const hasEditorParam = explicitView === "editor";
    if (wantsEditor === hasEditorParam) {
      return;
    }
    const url = new URL(window.location.href);
    if (wantsEditor) {
      url.searchParams.set(WORKBENCH_VIEW_SEARCH_PARAM, "editor");
    } else {
      url.searchParams.delete(WORKBENCH_VIEW_SEARCH_PARAM);
    }
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    const cur = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl !== cur) {
      router.replace(nextUrl);
    }
  }, [sessionReady, explicitView, workspaceSession.layout.shellView, router]);

  const value = useMemo<ShellViewContextValue>(
    () => ({
      shellView,
      setShellView,
    }),
    [shellView, setShellView]
  );

  return (
    <ShellViewContext.Provider value={value}>{children}</ShellViewContext.Provider>
  );
}

export function useShellView(): ShellViewContextValue {
  const ctx = useContext(ShellViewContext);
  if (!ctx) {
    throw new Error("useShellView must be used within ShellViewProvider");
  }
  return ctx;
}
