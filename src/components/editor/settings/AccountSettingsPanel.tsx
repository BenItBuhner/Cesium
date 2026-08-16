"use client";

import { SignInButton, SignOutButton } from "@clerk/nextjs";
import { ArrowRight, Check, Cloud, CloudOff, Server, UserRound } from "lucide-react";
import { AccountAvatar } from "@/components/account/AccountAvatar";
import { DeviceModeChip } from "@/components/setup/CloudAccountChip";
import {
  PageIntro,
  SettingsCallout,
  SettingsRow,
  SettingsSection,
} from "@/components/editor/settings-ui";
import { useCloudContext } from "@/contexts/CloudContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useWorkbenchAccess } from "@/lib/workbench-access";
import {
  readOnboardingState,
  writeOnboardingState,
} from "@/lib/onboarding/state";
import { useMemo, useState } from "react";

export function AccountSettingsPanel() {
  const cloud = useCloudContext();
  const access = useWorkbenchAccess();
  const { updateWorkspaceSession } = useWorkspace();
  const [onboarding, setOnboarding] = useState(() => readOnboardingState());

  const openServers = () => {
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: { ...current.settingsView, activeNav: "servers" },
    }));
  };

  const dismissWelcome = () => {
    const next = {
      ...onboarding,
      completedAt: onboarding.completedAt ?? Date.now(),
    };
    writeOnboardingState(next);
    setOnboarding(next);
  };

  const statusLine = useMemo(() => {
    if (access.accountKind === "signed-in") {
      return access.cloudSyncReady
        ? "Signed in. Personalization syncs with your account."
        : "Signed in. Syncing your client preferences…";
    }
    if (access.accountKind === "device") {
      return "This browser is linked as a device identity. Preferences stay on the client and sync when the cloud is reachable.";
    }
    if (access.accountKind === "local-only") {
      return "Cloud accounts are off in this build. Use a local or remote engine as a guest — appearance and shortcuts stay on this client.";
    }
    return "Sign in to keep personalization with your account, or continue as a guest with any engine.";
  }, [access.accountKind, access.cloudSyncReady]);

  const headline =
    access.accountKind === "signed-out" ? "Welcome to Cesium" : access.displayName;
  const showOnboarding = !onboarding.completedAt;

  return (
    <>
      <PageIntro title="Account" />

      <div className="mb-[20px] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)]">
        <div className="flex flex-col gap-[16px] px-[20px] py-[20px] sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-[14px]">
            <AccountAvatar
              name={access.displayName}
              imageUrl={access.imageUrl}
              size={44}
            />
            <div className="min-w-0">
              <p className="truncate font-sans text-[16px] font-semibold text-[var(--text-primary)]">
                {headline}
              </p>
              <p className="mt-[4px] font-sans text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                {access.email ?? statusLine}
              </p>
            </div>
          </div>
          {access.accountKind === "signed-in" && cloud.mode === "clerk" ? (
            <SignOutButton>
              <button
                type="button"
                className="inline-flex h-[32px] items-center rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[12px] font-sans text-[12px] text-[var(--text-primary)] hover:bg-[var(--accent-bg)]"
              >
                Sign out
              </button>
            </SignOutButton>
          ) : null}
          {cloud.mode === "clerk" && access.accountKind === "signed-out" ? (
            <SignInButton mode="modal">
              <button
                type="button"
                className="inline-flex h-[36px] items-center gap-[8px] rounded-[var(--radius-tab)] bg-[var(--accent)] px-[14px] font-sans text-[13px] font-medium text-[var(--bg-main)] hover:bg-[var(--accent-dark)]"
              >
                <Cloud className="size-[14px]" strokeWidth={1.7} />
                Sign in
              </button>
            </SignInButton>
          ) : null}
        </div>
        <div className="border-t border-[var(--border-subtle)] px-[20px] py-[12px] font-sans text-[12px] text-[var(--text-secondary)]">
          {statusLine}
        </div>
      </div>

      {cloud.mode === "clerk" && access.accountKind === "signed-out" ? (
        <SettingsSection title="Your account">
          <div className="px-[16px] py-[16px]">
            <p className="max-w-[52ch] font-sans text-[13px] leading-relaxed text-[var(--text-secondary)]">
              Theme, shortcuts, rail layout, and saved engines travel with this
              account. The workbench itself is usable as a guest as soon as an
              engine is connected — nothing here is a wall.
            </p>
            <div className="mt-[14px] flex flex-wrap items-center gap-[8px]">
              <SignInButton mode="modal">
                <button
                  type="button"
                  className="inline-flex h-[36px] items-center gap-[8px] rounded-[var(--radius-tab)] bg-[var(--accent)] px-[14px] font-sans text-[13px] font-medium text-[var(--bg-main)] hover:bg-[var(--accent-dark)]"
                >
                  <Cloud className="size-[14px]" strokeWidth={1.7} />
                  Sign in to sync
                </button>
              </SignInButton>
              <button
                type="button"
                onClick={openServers}
                className="inline-flex h-[36px] items-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[12px] font-sans text-[13px] text-[var(--text-primary)] hover:bg-[var(--accent-bg)]"
              >
                Continue as guest
                <ArrowRight className="size-[13px]" strokeWidth={2} />
              </button>
            </div>
          </div>
        </SettingsSection>
      ) : null}

      {cloud.mode === "disabled" ? (
        <SettingsSection title="Local-only">
          <SettingsRow
            searchId="account-local"
            title="No cloud account on this build"
            description="Everything stays on this device. Connect an engine under Servers to start chatting."
            trailing={
              <span className="inline-flex items-center gap-[6px] font-mono text-[11px] text-[var(--text-disabled)]">
                <CloudOff className="size-[13px]" strokeWidth={1.7} />
                Local
              </span>
            }
            border={false}
          />
        </SettingsSection>
      ) : null}

      {cloud.mode === "device" ? (
        <SettingsSection title="Device sync">
          <div className="flex items-center justify-between gap-[12px] px-[16px] py-[12px]">
            <p className="font-sans text-[12.5px] text-[var(--text-secondary)]">
              Keyless identity for this browser. Link another device with the copied URL.
            </p>
            <DeviceModeChip status={cloud.status} userKey={cloud.userKey} />
          </div>
        </SettingsSection>
      ) : null}

      <SettingsSection title="Engine">
        <SettingsRow
          searchId="account-engine"
          title={access.agentsLive ? access.engineLabel : "No live engine"}
          description={
            access.engineKind === "auth_required"
              ? `${access.engineBaseUrl} · this engine needs a password before chats can run.`
              : access.engineKind === "offline"
                ? `${access.engineBaseUrl} · unreachable. Add or fix a server to use the workbench as a guest.`
                : access.agentsLive
                  ? `${access.engineBaseUrl} · ${access.isGuest ? "guest session" : "connected"}`
                  : "Connect a local or remote Cesium engine to run agents."
          }
          trailing={
            <button
              type="button"
              onClick={openServers}
              className="inline-flex h-[32px] items-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[12px] font-sans text-[12px] text-[var(--text-primary)] hover:bg-[var(--accent-bg)]"
            >
              <Server className="size-[13px]" strokeWidth={1.6} />
              Manage servers
            </button>
          }
          border={false}
        />
      </SettingsSection>

      {showOnboarding ? (
        <OnboardingChecklist
          signedIn={access.accountKind === "signed-in"}
          agentsLive={access.agentsLive}
          localOnly={access.accountKind === "local-only"}
          onOpenServers={openServers}
          onDismiss={dismissWelcome}
        />
      ) : null}

      {access.accountKind === "signed-out" && cloud.mode === "clerk" ? (
        <SettingsCallout>
          Prefer local-only? Skip the account and connect an engine under Servers.
          You can sign in later — client preferences already live on this machine.
        </SettingsCallout>
      ) : null}
    </>
  );
}

function OnboardingChecklist({
  signedIn,
  agentsLive,
  localOnly,
  onOpenServers,
  onDismiss,
}: {
  signedIn: boolean;
  agentsLive: boolean;
  localOnly: boolean;
  onOpenServers: () => void;
  onDismiss: () => void;
}) {
  const accountDone = signedIn || localOnly;
  const allDone = accountDone && agentsLive;
  return (
    <SettingsSection title="Get started">
      <ChecklistRow
        done={accountDone}
        title={localOnly ? "Local-only mode" : "Sign in"}
        description={
          localOnly
            ? "This build has no cloud account. Guest use is the default."
            : "Optional. Syncs personalization across devices."
        }
        icon={UserRound}
      />
      <ChecklistRow
        done={agentsLive}
        title="Connect an engine"
        description="Required to chat. Local guest use is enough if you skip an account."
        icon={Server}
        action={
          agentsLive ? null : (
            <button
              type="button"
              onClick={onOpenServers}
              className="inline-flex items-center gap-[4px] font-sans text-[12px] text-[var(--accent)]"
            >
              Open servers
              <ArrowRight className="size-[12px]" />
            </button>
          )
        }
      />
      <ChecklistRow
        done={allDone}
        title="Start working"
        description="The agents panel stays idle until an engine is live."
        icon={Cloud}
        border={false}
      />
      {allDone ? (
        <div className="border-t border-[var(--border-subtle)] px-[16px] py-[10px]">
          <button
            type="button"
            onClick={onDismiss}
            className="font-sans text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            Mark setup complete
          </button>
        </div>
      ) : null}
    </SettingsSection>
  );
}

function ChecklistRow({
  done,
  title,
  description,
  icon: Icon,
  action,
  border = true,
}: {
  done: boolean;
  title: string;
  description: string;
  icon: typeof Cloud;
  action?: React.ReactNode;
  border?: boolean;
}) {
  return (
    <div
      className={`flex items-start gap-[12px] px-[16px] py-[12px] ${
        border ? "border-b border-[var(--border-subtle)]" : ""
      }`}
    >
      <span
        className={`mt-[2px] flex size-[22px] items-center justify-center rounded-full border ${
          done
            ? "border-transparent bg-[var(--ask-accent)] text-[var(--bg-main)]"
            : "border-[var(--border-card)] text-[var(--text-disabled)]"
        }`}
      >
        {done ? (
          <Check className="size-[12px]" strokeWidth={2.5} />
        ) : (
          <Icon className="size-[12px]" strokeWidth={1.7} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">{title}</p>
        <p className="mt-[2px] font-sans text-[12px] text-[var(--text-secondary)]">{description}</p>
      </div>
      {action}
    </div>
  );
}
