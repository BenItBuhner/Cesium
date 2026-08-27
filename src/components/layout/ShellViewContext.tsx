"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import type {
  WorkbenchShellNonSettingsView,
  WorkbenchShellView,
} from "@/lib/workspace-session";
import { safeWindowLocationUrl } from "@/lib/safe-url";
import {
  WORKBENCH_VIEW_SEARCH_PARAM,
  consumeDefaultShellViewOnNextLaunch,
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
  if (next === "settings") {
    url.searchParams.set(WORKBENCH_VIEW_SEARCH_PARAM, "settings");
  } else {
    url.searchParams.delete(WORKBENCH_VIEW_SEARCH_PARAM);
  }
}

export function ShellViewProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { workspaceSession, updateWorkspaceSession, sessionReady } = useWorkspace();

  // Error-boundary recovery: after "Reload Cesium" the app must boot into the
  // default agent (new chat) view even when the URL or the persisted session
  // says `settings` - otherwise a crashing Settings render re-crashes every
  // launch. The marker is consumed (cleared) immediately so it only affects
  // this boot; the persisted session is rewritten once it is ready.
  const [pendingShellViewReset, setPendingShellViewReset] = useState(() =>
    consumeDefaultShellViewOnNextLaunch()
  );

  const explicitView = searchParams.get(WORKBENCH_VIEW_SEARCH_PARAM);

  const shellView: WorkbenchShellView = useMemo(() => {
    if (pendingShellViewReset) {
      return "agent";
    }
    if (!sessionReady) {
      const fromUrl = workbenchViewFromSearchParam(explicitView);
      if (fromUrl !== "default") {
        return fromUrl;
      }
      return "agent";
    }
    // Legacy sessions may still persist `editor`; treat as agent.
    const stored = workspaceSession.layout.shellView;
    return stored === "settings" ? "settings" : "agent";
  }, [explicitView, pendingShellViewReset, sessionReady, workspaceSession.layout.shellView]);

  useEffect(() => {
    if (!pendingShellViewReset || !sessionReady) {
      return;
    }
    updateWorkspaceSession((c) => {
      if (c.layout.shellView !== "settings") {
        return c;
      }
      return {
        ...c,
        layout: { ...c.layout, shellView: "agent", priorShellView: "agent" },
      };
    });
    setPendingShellViewReset(false);
  }, [pendingShellViewReset, sessionReady, updateWorkspaceSession]);

  const setShellView = useCallback(
    (next: WorkbenchShellView) => {
      setPendingShellViewReset(false);
      const url = safeWindowLocationUrl();
      if (!url) {
        return;
      }
      const resolved: WorkbenchShellView = next === "settings" ? "settings" : "agent";
      applyShellViewToUrl(url, resolved);
      updateWorkspaceSession((c) => {
        const cur = c.layout.shellView === "settings" ? "settings" : "agent";
        let layout = { ...c.layout, shellView: resolved };
        if (resolved === "settings" && cur !== "settings") {
          const prior: WorkbenchShellNonSettingsView = "agent";
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
    const prior: WorkbenchShellNonSettingsView = "agent";
    const url = safeWindowLocationUrl();
    if (!url) {
      return;
    }
    applyShellViewToUrl(url, prior);
    updateWorkspaceSession((c) => ({
      ...c,
      layout: { ...c.layout, shellView: prior, priorShellView: prior },
    }));
    router.replace(`${url.pathname}${url.search}${url.hash}`);
  }, [router, updateWorkspaceSession]);

  useEffect(() => {
    if (!sessionReady || pendingShellViewReset) {
      return;
    }
    const wantsParam: WorkbenchShellView | null =
      workspaceSession.layout.shellView === "settings" ? "settings" : null;

    const url = safeWindowLocationUrl();
    if (!url) {
      return;
    }
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
  }, [sessionReady, pendingShellViewReset, workspaceSession.layout.shellView, router]);

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
