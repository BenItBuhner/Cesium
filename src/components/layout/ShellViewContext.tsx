"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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

  /**
   * `useSearchParams()` can lag `router.replace()` by a render or two. During that window
   * `?view=editor` would still win and a sync effect could stomp session back to editor.
   * While this is set, prefer persisted `agent` over a stale editor query param.
   */
  const preferAgentOverStaleEditorUrlRef = useRef(false);

  const explicitView = searchParams.get(WORKBENCH_VIEW_SEARCH_PARAM);

  const shellView: WorkbenchShellView = useMemo(() => {
    if (!sessionReady) {
      return "agent";
    }
    if (
      preferAgentOverStaleEditorUrlRef.current &&
      workspaceSession.layout.shellView === "agent"
    ) {
      return "agent";
    }
    if (explicitView === "editor") {
      return "editor";
    }
    if (explicitView == null && workspaceSession.layout.shellView === "editor") {
      return "editor";
    }
    return "agent";
  }, [explicitView, sessionReady, workspaceSession.layout.shellView]);

  useEffect(() => {
    if (explicitView !== "editor") {
      preferAgentOverStaleEditorUrlRef.current = false;
    }
  }, [explicitView]);

  const setShellView = useCallback(
    (next: WorkbenchShellView) => {
      if (next === "agent") {
        preferAgentOverStaleEditorUrlRef.current = true;
      } else {
        preferAgentOverStaleEditorUrlRef.current = false;
      }
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
    if (explicitView != null) {
      return;
    }
    if (workspaceSession.layout.shellView !== "editor") {
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set(WORKBENCH_VIEW_SEARCH_PARAM, "editor");
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    const cur = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl !== cur) {
      router.replace(nextUrl);
    }
  }, [sessionReady, explicitView, workspaceSession.layout.shellView, router]);

  useEffect(() => {
    if (!sessionReady) {
      return;
    }
    if (explicitView === "editor") {
      updateWorkspaceSession((c) => {
        if (c.layout.shellView === "agent") {
          return c;
        }
        return c.layout.shellView === "editor"
          ? c
          : { ...c, layout: { ...c.layout, shellView: "editor" } };
      });
      return;
    }
    if (explicitView == null && workspaceSession.layout.shellView === "editor") {
      return;
    }
    updateWorkspaceSession((c) =>
      c.layout.shellView === "agent"
        ? c
        : { ...c, layout: { ...c.layout, shellView: "agent" } }
    );
  }, [sessionReady, explicitView, workspaceSession.layout.shellView, updateWorkspaceSession]);

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
