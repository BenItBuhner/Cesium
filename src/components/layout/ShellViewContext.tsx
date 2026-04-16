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
import type {
  WorkbenchShellNonSettingsView,
  WorkbenchShellView,
} from "@/lib/workspace-session";
import {
  WORKBENCH_VIEW_SEARCH_PARAM,
  workbenchViewFromSearchParam,
} from "@/lib/workbench-view";

export { WORKBENCH_VIEW_SEARCH_PARAM };

type ShellViewContextValue = {
  shellView: WorkbenchShellView;
  setShellView: (next: WorkbenchShellView) => void;
  openSettingsView: () => void;
  closeSettingsView: () => void;
};

const ShellViewContext = createContext<ShellViewContextValue | null>(null);

function applyShellViewToUrl(url: URL, next: WorkbenchShellView) {
  if (next === "editor") {
    url.searchParams.set(WORKBENCH_VIEW_SEARCH_PARAM, "editor");
  } else if (next === "settings") {
    url.searchParams.set(WORKBENCH_VIEW_SEARCH_PARAM, "settings");
  } else {
    url.searchParams.delete(WORKBENCH_VIEW_SEARCH_PARAM);
  }
}

export function ShellViewProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { workspaceSession, updateWorkspaceSession, sessionReady } = useWorkspace();

  const explicitView = searchParams.get(WORKBENCH_VIEW_SEARCH_PARAM);

  const shellView: WorkbenchShellView = useMemo(() => {
    if (!sessionReady) {
      const fromUrl = workbenchViewFromSearchParam(explicitView);
      if (fromUrl !== "default") {
        return fromUrl;
      }
      return "agent";
    }
    return workspaceSession.layout.shellView;
  }, [explicitView, sessionReady, workspaceSession.layout.shellView]);

  const setShellView = useCallback(
    (next: WorkbenchShellView) => {
      const url = new URL(window.location.href);
      applyShellViewToUrl(url, next);
      updateWorkspaceSession((c) => {
        const cur = c.layout.shellView;
        let layout = { ...c.layout, shellView: next };
        if (next === "settings" && cur !== "settings") {
          const prior: WorkbenchShellNonSettingsView = cur === "editor" ? "editor" : "agent";
          layout = { ...layout, priorShellView: prior };
        }
        return { ...c, layout };
      });
      router.replace(`${url.pathname}${url.search}${url.hash}`);
    },
    [router, updateWorkspaceSession]
  );

  const openSettingsView = useCallback(() => {
    setShellView("settings");
  }, [setShellView]);

  const closeSettingsView = useCallback(() => {
    const prior: WorkbenchShellNonSettingsView =
      workspaceSession.layout.priorShellView ?? "agent";
    const url = new URL(window.location.href);
    applyShellViewToUrl(url, prior);
    updateWorkspaceSession((c) => ({
      ...c,
      layout: { ...c.layout, shellView: prior },
    }));
    router.replace(`${url.pathname}${url.search}${url.hash}`);
  }, [router, updateWorkspaceSession, workspaceSession.layout.priorShellView]);

  useEffect(() => {
    if (!sessionReady) {
      return;
    }
    const wantsParam: WorkbenchShellView | null =
      workspaceSession.layout.shellView === "editor"
        ? "editor"
        : workspaceSession.layout.shellView === "settings"
          ? "settings"
          : null;

    const url = new URL(window.location.href);
    const curParam = url.searchParams.get(WORKBENCH_VIEW_SEARCH_PARAM);

    if (wantsParam === null) {
      if (curParam != null) {
        url.searchParams.delete(WORKBENCH_VIEW_SEARCH_PARAM);
        const nextUrl = `${url.pathname}${url.search}${url.hash}`;
        const cur = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        if (nextUrl !== cur) {
          router.replace(nextUrl);
        }
      }
      return;
    }

    if (curParam !== wantsParam) {
      url.searchParams.set(WORKBENCH_VIEW_SEARCH_PARAM, wantsParam);
      const nextUrl = `${url.pathname}${url.search}${url.hash}`;
      const cur = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (nextUrl !== cur) {
        router.replace(nextUrl);
      }
    }
  }, [sessionReady, workspaceSession.layout.shellView, router]);

  const value = useMemo<ShellViewContextValue>(
    () => ({
      shellView,
      setShellView,
      openSettingsView,
      closeSettingsView,
    }),
    [shellView, setShellView, openSettingsView, closeSettingsView]
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
