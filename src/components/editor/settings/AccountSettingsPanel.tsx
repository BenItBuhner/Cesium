"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SignInButton, SignOutButton, UserButton } from "@clerk/nextjs";
import { Check, ChevronDown, CircleUserRound, Link2 } from "lucide-react";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import {
  getCloudMode,
  isCloudLocallyDisabled,
  setCloudLocallyDisabled,
} from "@/lib/cloud/cloud-env";
import {
  PageIntro,
  SettingsBlock,
  SettingsCallout,
  SettingsRow,
  SettingsSection,
  rowButtonClass,
  tagClass,
  useSettingsShellChrome,
} from "@/components/editor/settings-ui";
import { useOptionalAuth } from "@/components/auth/AuthProvider";
import { useCloudContext } from "@/contexts/CloudContext";
import { useAccountIdentity } from "@/hooks/useAccountIdentity";
import { ServerPickerPopover } from "@/components/preferences/ServerPickerPopover";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useWorkspaceDirectory } from "@/contexts/WorkspaceDirectoryContext";
import {
  getLastWorkspaceForServer,
  rememberLastWorkspaceForServer,
} from "@/lib/per-server-workspace-memory";
import {
  getServerDisplayLabel,
  getServerRailAppearance,
  isLocalDeviceServer,
} from "@/lib/server-rail-appearance";
import { WorkspaceFolderIcon } from "@/lib/workspace-rail-appearance";

function formatSessionTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

function AccountIdentityCard() {
  const identity = useAccountIdentity();
  const cloud = useCloudContext();
  return (
    <SettingsBlock searchId="account-identity">
      <div className="flex items-center gap-[14px]">
        {identity.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={identity.imageUrl}
            alt=""
            className="size-[44px] shrink-0 rounded-full object-cover"
          />
        ) : (
          <span className="flex size-[44px] shrink-0 items-center justify-center rounded-full bg-[var(--accent-bg)] text-[var(--text-secondary)]">
            <CircleUserRound className="size-[24px]" strokeWidth={1.5} aria-hidden />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-[8px] font-sans text-[15px] font-semibold text-[var(--text-primary)]">
            <span className="truncate">{identity.title}</span>
            {identity.kind === "clerk" || identity.kind === "clerk-signed-out" ? null : (
              <span className={tagClass}>{identity.modeLabel}</span>
            )}
          </p>
          <p className="mt-[2px] flex items-center gap-[6px] font-sans text-[12px] text-[var(--text-secondary)]">
            <span
              className={`size-[6px] shrink-0 rounded-full ${
                identity.signedIn ? "bg-[#22c55e]" : "bg-[var(--text-disabled)]"
              }`}
              aria-hidden
            />
            <span className="truncate">{identity.subtitle}</span>
          </p>
        </div>
        {cloud.mode === "clerk" ? (
          identity.kind === "clerk-signed-out" ? (
            <SignInButton mode="modal">
              <button
                type="button"
                className="inline-flex shrink-0 items-center rounded-[var(--radius-tab)] bg-[var(--accent)] px-[14px] py-[6px] font-sans text-[12px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)]"
              >
                Sign in
              </button>
            </SignInButton>
          ) : (
            <span className="shrink-0">
              <UserButton />
            </span>
          )
        ) : null}
      </div>
    </SettingsBlock>
  );
}

/**
 * Runtime cloud switch: shown whenever the build is cloud-capable (env vars
 * or committed defaults). Cloud is on by default; turning it off keeps this
 * device fully local-first without rebuilding — on every platform (web,
 * Electron, Android, iOS). CloudProviders listens for the change and
 * remounts the provider tree live.
 */
function CloudSyncToggleRow({
  localOnly,
  onChange,
}: {
  localOnly: boolean;
  onChange: (localOnly: boolean) => void;
}) {
  return (
    <SettingsRow
      title="Cloud sync"
      description={
        localOnly
          ? "Off — this device runs local-only. Nothing leaves this device or your engine servers."
          : "On — servers, personalization, and snapshots can sync through Cesium Cloud."
      }
      trailing={
        <ToggleSwitch
          checked={!localOnly}
          variant="green"
          onChange={(on) => {
            setCloudLocallyDisabled(!on);
            onChange(!on);
          }}
        />
      }
      searchId="account-cloud-sync-toggle"
    />
  );
}

function CloudAccountSection() {
  const cloud = useCloudContext();
  const [copied, setCopied] = useState(false);
  const configuredMode = getCloudMode();
  const [localOnly, setLocalOnly] = useState(false);
  useEffect(() => {
    setLocalOnly(isCloudLocallyDisabled());
  }, []);

  if (configuredMode === "disabled") {
    return (
      <SettingsSection>
        <SettingsRow
          title="Local mode"
          description="This build stays on this device and your engine servers — no account is required."
          trailing={<span className={tagClass}>Local-only</span>}
          searchId="account-cloud-mode"
        />
      </SettingsSection>
    );
  }

  if (cloud.mode === "disabled") {
    // Cloud-capable build, but this device opted out at runtime (or the
    // provider tree is about to remount after a toggle).
    return (
      <SettingsSection>
        <CloudSyncToggleRow localOnly={localOnly} onChange={setLocalOnly} />
        <SettingsRow
          title="Local-only mode"
          description="Cloud is turned off on this device. Flip the switch to reconnect — your account and data are untouched."
          trailing={<span className={tagClass}>Local-only</span>}
          searchId="account-cloud-mode"
        />
      </SettingsSection>
    );
  }

  if (cloud.mode === "device") {
    const deviceKey = cloud.userKey?.startsWith("device:")
      ? cloud.userKey.slice(7)
      : null;
    const copyLinkUrl = async () => {
      if (!deviceKey) {
        return;
      }
      const url = `${window.location.origin}/setup?link=${encodeURIComponent(deviceKey)}`;
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // Clipboard unavailable (permissions/insecure context) — ignore.
      }
    };
    return (
      <SettingsSection>
        <CloudSyncToggleRow localOnly={localOnly} onChange={setLocalOnly} />
        {deviceKey ? (
          <SettingsRow
            title="Link another device"
            description="Copy a link that signs another device into this cloud context."
            trailing={
              <button type="button" className={rowButtonClass} onClick={() => void copyLinkUrl()}>
                {copied ? (
                  <Check className="size-[13px]" strokeWidth={2} aria-hidden />
                ) : (
                  <Link2 className="size-[13px]" strokeWidth={1.75} aria-hidden />
                )}
                {copied ? "Copied" : "Copy link"}
              </button>
            }
          />
        ) : null}
      </SettingsSection>
    );
  }

  // clerk mode
  return (
    <SettingsSection>
      {cloud.status === "signed-out" ? (
        <SettingsRow
          title="Not signed in"
          description="Sign in to use your account on this device."
          trailing={
            <SignInButton mode="modal">
              <button type="button" className={rowButtonClass}>
                Sign in
              </button>
            </SignInButton>
          }
          searchId="account-cloud-mode"
        />
      ) : (
        <SettingsRow
          title="Sign out"
          description="Sign out of this device."
          trailing={
            <SignOutButton>
              <button type="button" className={rowButtonClass}>
                Sign out
              </button>
            </SignOutButton>
          }
          searchId="account-cloud-mode"
        />
      )}
    </SettingsSection>
  );
}

function ServerSessionSection() {
  const auth = useOptionalAuth();

  if (!auth || !auth.enabled) {
    return (
      <SettingsSection title="Server session">
        <SettingsRow
          title="Open access"
          description="The active server does not require sign-in. Set OPENCURSOR_AUTH_USERNAME and OPENCURSOR_AUTH_PASSWORD on the server to protect it with a password session."
          trailing={<span className={tagClass}>No sign-in</span>}
          searchId="account-server-session"
        />
      </SettingsSection>
    );
  }

  if (!auth.authenticated || !auth.session) {
    return (
      <SettingsSection title="Server session">
        <SettingsRow
          title="Signed out"
          description="This server requires sign-in. Reload to open the sign-in screen."
          trailing={<span className={tagClass}>Signed out</span>}
          searchId="account-server-session"
        />
      </SettingsSection>
    );
  }

  const session = auth.session;
  return (
    <SettingsSection title="Server session">
      <SettingsRow
        title={`Signed in as ${session.username}`}
        description="Password session on the active server."
        trailing={
          <button
            type="button"
            className={rowButtonClass}
            onClick={() => void auth.logout()}
          >
            Sign out
          </button>
        }
        searchId="account-server-session"
      />
      <SettingsBlock>
        <dl className="grid grid-cols-1 gap-x-[24px] gap-y-[10px] sm:grid-cols-3">
          <div>
            <dt className="font-sans text-[11px] font-medium uppercase tracking-wide text-[var(--text-disabled)]">
              Session started
            </dt>
            <dd className="mt-[2px] font-sans text-[12px] text-[var(--text-primary)]">
              {formatSessionTimestamp(session.createdAt)}
            </dd>
          </div>
          <div>
            <dt className="font-sans text-[11px] font-medium uppercase tracking-wide text-[var(--text-disabled)]">
              Last active
            </dt>
            <dd className="mt-[2px] font-sans text-[12px] text-[var(--text-primary)]">
              {formatSessionTimestamp(session.lastSeenAt)}
            </dd>
          </div>
          <div>
            <dt className="font-sans text-[11px] font-medium uppercase tracking-wide text-[var(--text-disabled)]">
              Expires
            </dt>
            <dd className="mt-[2px] font-sans text-[12px] text-[var(--text-primary)]">
              {formatSessionTimestamp(session.expiresAt)}
              {session.remember ? " (remembered)" : ""}
            </dd>
          </div>
        </dl>
      </SettingsBlock>
    </SettingsSection>
  );
}

function ActiveServerSection() {
  const chrome = useSettingsShellChrome();
  const { activeServer, hasServer, servers, serverStatusById, setActiveServer } =
    useServerConnections();
  const { settings } = useGlobalSettings();
  const { activeWorkspaceId, openWorkspaceById } = useWorkspace();
  const { byServerId: directoryByServerId } = useWorkspaceDirectory();
  const pickerAnchorRef = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const serverRailAppearances = settings.general.serverRailAppearances;
  const activeServerAppearance = useMemo(
    () =>
      hasServer
        ? getServerRailAppearance(
            serverRailAppearances,
            activeServer.id,
            servers.findIndex((server) => server.id === activeServer.id)
          )
        : null,
    [activeServer, hasServer, serverRailAppearances, servers]
  );
  const activeServerDisplayLabel = useMemo(
    () =>
      hasServer && activeServerAppearance
        ? getServerDisplayLabel(activeServer, activeServerAppearance)
        : "No server",
    [activeServer, activeServerAppearance, hasServer]
  );

  const handleActiveServerChange = useCallback(
    (serverId: string) => {
      if (hasServer && serverId === activeServer.id) {
        setPickerOpen(false);
        return;
      }
      if (activeWorkspaceId && hasServer) {
        rememberLastWorkspaceForServer(activeServer.id, activeWorkspaceId);
      }
      setActiveServer(serverId);
      setPickerOpen(false);
      const restoredWorkspaceId = getLastWorkspaceForServer(serverId);
      const directoryWorkspaces = directoryByServerId.get(serverId) ?? [];
      const targetWorkspaceId =
        restoredWorkspaceId &&
        directoryWorkspaces.some((workspace) => workspace.id === restoredWorkspaceId)
          ? restoredWorkspaceId
          : directoryWorkspaces[0]?.id;
      if (targetWorkspaceId) {
        void openWorkspaceById(targetWorkspaceId).catch(() => undefined);
      }
    },
    [
      activeServer.id,
      activeWorkspaceId,
      directoryByServerId,
      hasServer,
      openWorkspaceById,
      setActiveServer,
    ]
  );

  return (
    <SettingsSection
      title="Active server"
      action={
        chrome?.navigate ? (
          <button
            type="button"
            className={rowButtonClass}
            onClick={() => chrome.navigate?.("servers")}
          >
            Manage servers
          </button>
        ) : undefined
      }
    >
      <SettingsRow
        title={activeServerDisplayLabel}
        description={
          !hasServer
            ? "No engine is connected yet. Add one from Servers."
            : isLocalDeviceServer(activeServer)
              ? "This device — the local engine bundled with this client."
              : activeServer.baseUrl
        }
        leading={
          hasServer && activeServerAppearance && !isLocalDeviceServer(activeServer) ? (
            <WorkspaceFolderIcon
              iconName={activeServerAppearance.icon}
              color={activeServerAppearance.color}
              className="size-[16px] shrink-0"
              strokeWidth={1.5}
            />
          ) : (
            <CircleUserRound
              className="size-[16px] shrink-0 text-[var(--text-secondary)]"
              strokeWidth={1.5}
              aria-hidden
            />
          )
        }
        trailing={
          servers.length > 0 ? (
            <button
              ref={pickerAnchorRef}
              type="button"
              className={rowButtonClass}
              onClick={() => setPickerOpen((open) => !open)}
              aria-expanded={pickerOpen}
              aria-haspopup="menu"
            >
              Switch
              <ChevronDown className="size-[13px]" strokeWidth={1.5} aria-hidden />
            </button>
          ) : undefined
        }
        searchId="account-active-server"
      />
      <ServerPickerPopover
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        anchorRef={pickerAnchorRef}
        label="Switch server"
        selectedServerId={hasServer ? activeServer.id : ""}
        servers={servers}
        serverStatusById={serverStatusById}
        serverRailAppearances={serverRailAppearances}
        onSelect={handleActiveServerChange}
        placement="below"
      />
    </SettingsSection>
  );
}

/**
 * Account & session overview: who you are (cloud account, device sync, or
 * local), the engine password session on the active server, and which server
 * this client is connected to. Content adapts to the deployment posture —
 * local-first builds show local mode, production builds show real sign-in.
 */
export function AccountSettingsPanel() {
  return (
    <>
      <PageIntro title="Account" />
      <SettingsSection>
        <AccountIdentityCard />
      </SettingsSection>
      <CloudAccountSection />
      <ServerSessionSection />
      <ActiveServerSection />
      <SettingsCallout className="px-[2px]">
        Account and session state vary by deployment: local-first builds keep
        everything on this device, while production builds add cloud sign-in and
        password-protected servers.
      </SettingsCallout>
    </>
  );
}
