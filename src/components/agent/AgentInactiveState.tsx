"use client";

import { ArrowRight, Cloud, Server } from "lucide-react";
import { useShellView } from "@/components/layout/ShellViewContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useWorkbenchAccess } from "@/lib/workbench-access";
import { AGENT_CENTER_CONTENT_CLASS } from "./agent-shell-layout";

export function AgentInactiveState() {
  const access = useWorkbenchAccess();
  const { openSettingsView } = useShellView();
  const { updateWorkspaceSession } = useWorkspace();

  const openNav = (activeNav: "account" | "servers") => {
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: { ...current.settingsView, activeNav },
    }));
    openSettingsView();
  };

  const needsAccount = access.accountKind === "signed-out";
  const title = access.engineKind === "auth_required"
    ? "This engine needs a sign-in"
    : access.engineKind === "offline"
      ? "Engine is offline"
      : "Connect an engine to start";
  const body = access.engineKind === "auth_required"
    ? `${access.engineLabel} is reachable but requires a password. Open Servers to authenticate, or sign in to your Cesium account to restore saved engines.`
    : access.engineKind === "offline"
      ? "The agents panel stays idle until a Cesium engine is reachable. Add a local or remote server in Settings — no account required for guest use."
      : needsAccount
        ? "Sign in to sync personalization across devices, or continue as a guest by connecting a local engine."
        : "Point Cesium at the engine that runs where your code lives. Appearance and shortcuts already live on this client.";

  return (
    <div className={`flex h-full min-h-0 items-center justify-center ${AGENT_CENTER_CONTENT_CLASS}`}>
      <div className="w-full max-w-[440px] px-[24px] py-[32px] text-center">
        <div className="mx-auto mb-[16px] flex size-[40px] items-center justify-center rounded-[12px] border border-[var(--border-card)] bg-[var(--bg-panel)] text-[var(--text-primary)]">
          <Server className="size-[18px]" strokeWidth={1.7} aria-hidden />
        </div>
        <h2 className="font-sans text-[18px] font-semibold tracking-tight text-[var(--text-primary)]">
          {title}
        </h2>
        <p className="mt-[10px] font-sans text-[13px] leading-relaxed text-[var(--text-secondary)]">
          {body}
        </p>
        <div className="mt-[20px] flex flex-wrap items-center justify-center gap-[8px]">
          {needsAccount ? (
            <button
              type="button"
              onClick={() => openNav("account")}
              className="inline-flex h-[36px] items-center gap-[8px] rounded-[var(--radius-tab)] bg-[var(--accent)] px-[14px] font-sans text-[13px] font-medium text-[var(--bg-main)] hover:bg-[var(--accent-dark)]"
            >
              <Cloud className="size-[14px]" strokeWidth={1.7} />
              Sign in
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => openNav("servers")}
            className="inline-flex h-[36px] items-center gap-[8px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[14px] font-sans text-[13px] text-[var(--text-primary)] hover:bg-[var(--accent-bg)]"
          >
            Manage servers
            <ArrowRight className="size-[14px]" strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}
