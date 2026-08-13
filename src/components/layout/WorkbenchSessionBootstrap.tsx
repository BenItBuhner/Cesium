"use client";

import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { adoptDeviceKey } from "@/lib/cloud/cloud-env";
import { useShellView } from "@/components/layout/ShellViewContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useWorkbenchAccess } from "@/lib/workbench-access";

/**
 * First landing without a live engine opens Settings → Account instead of a
 * gated server-picker wall. `?view=settings` (Get started, device link) also
 * lands here even when a guest engine is already live.
 */
export function WorkbenchSessionBootstrap() {
  const { agentsLive } = useWorkbenchAccess();
  const { shellView, openSettingsView } = useShellView();
  const { sessionReady, updateWorkspaceSession } = useWorkspace();
  const searchParams = useSearchParams();
  const forcedRef = useRef(false);

  useEffect(() => {
    const link = searchParams?.get("link");
    if (link && adoptDeviceKey(link)) {
      window.location.replace("/agent?view=settings");
    }
  }, [searchParams]);

  useEffect(() => {
    if (!sessionReady || forcedRef.current) {
      return;
    }
    const wantsSettings =
      searchParams?.get("view") === "settings" || !agentsLive;
    if (!wantsSettings) {
      return;
    }
    forcedRef.current = true;
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: {
        ...current.settingsView,
        activeNav:
          current.settingsView.activeNav === "general" ||
          searchParams?.get("view") === "settings"
            ? "account"
            : current.settingsView.activeNav,
      },
    }));
    if (shellView !== "settings") {
      openSettingsView();
    }
  }, [
    agentsLive,
    openSettingsView,
    searchParams,
    sessionReady,
    shellView,
    updateWorkspaceSession,
  ]);

  return null;
}
