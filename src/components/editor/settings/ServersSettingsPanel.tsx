"use client";

import { PublicAccessSettings } from "@/components/preferences/PublicAccessSettings";
import { ServerConnectionsManager } from "@/components/preferences/ServerConnectionsManager";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import {
  PageIntro,
  SettingsCallout,
  SettingsRow,
  SettingsSection,
} from "@/components/editor/settings-ui";
import { useWorkbenchAccess } from "@/lib/workbench-access";

export function ServerConnectionsSettingsPanel() {
  const {
    activeServer,
    servers,
    onlineServers,
    serverStatusById,
    setActiveServer,
  } = useServerConnections();
  const access = useWorkbenchAccess();

  return (
    <>
      <PageIntro title="Servers" />
      {access.engineKind === "auth_required" ? (
        <SettingsCallout tone="warning" className="mb-[16px]">
          {access.engineLabel} is reachable but needs an engine password before
          chats can run. Sign in on the server below — this is separate from
          your Cesium account.
        </SettingsCallout>
      ) : null}
      {access.engineKind === "offline" ? (
        <SettingsCallout className="mb-[16px]">
          The active engine is unreachable. Add a local or remote Cesium engine
          to use the workbench as a guest — no account required.
        </SettingsCallout>
      ) : null}
      <SettingsSection title="Active engine">
        <SettingsRow
          searchId="active-chat"
          title="Active chat server"
          description={`${activeServer.baseUrl} · ${serverStatusById[activeServer.id]?.health ?? "checking"}`}
          trailing={
            <span className="rounded-[999px] border border-[var(--border-subtle)] px-[8px] py-[4px] font-sans text-[11px] text-[var(--text-secondary)]">
              {activeServer.label}
            </span>
          }
        />
        <SettingsRow
          searchId="connected-runtimes"
          title="Reachable engines"
          description={
            onlineServers.length > 0
              ? onlineServers.map((server) => server.label).join(", ")
              : "No reachable saved servers yet."
          }
          trailing={
            <span className="rounded-[999px] border border-[var(--border-subtle)] px-[8px] py-[4px] font-sans text-[11px] text-[var(--text-secondary)]">
              {onlineServers.length}/{servers.length}
            </span>
          }
          border={false}
        />
      </SettingsSection>
      <PublicAccessSettings serverBaseUrl={activeServer.baseUrl} />
      <SettingsSection title="Saved servers" bordered={false}>
        <ServerConnectionsManager
          onActivate={(serverId) => {
            setActiveServer(serverId);
          }}
        />
      </SettingsSection>
    </>
  );
}
