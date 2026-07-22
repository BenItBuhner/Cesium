"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { VerticalFadedScroll } from "@/components/chat/VerticalFadedScroll";
import { DefaultServerSettingsBanner } from "@/components/preferences/DefaultServerSettingsBanner";
import { ServerConnectionsManager } from "@/components/preferences/ServerConnectionsManager";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import {
  serverHealthColorClass,
  serverHealthIndicator,
} from "@/lib/server-health-display";
import {
  PageIntro,
  SettingsRow,
  SettingsSection,
} from "@/components/editor/settings-ui";

function SettingsServerPicker({
  label,
  title,
  selectedServerId,
  servers,
  serverStatusById,
  onSelect,
  disabled = false,
}: {
  label: string;
  title?: string;
  selectedServerId: string | null;
  servers: Array<{ id: string; label: string; baseUrl: string }>;
  serverStatusById: Record<string, { health: string } | undefined>;
  onSelect: (serverId: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0, width: 280 });
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const selectedServer =
    servers.find((server) => server.id === selectedServerId) ?? servers[0] ?? null;
  const selectedHealth = selectedServer
    ? (serverStatusById[selectedServer.id]?.health ?? "unknown")
    : "unknown";

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) {
      return;
    }
    const update = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.max(240, Math.min(320, window.innerWidth - 16));
      setPopoverPos({
        top: rect.bottom + 6,
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
        width,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        (popoverRef.current?.contains(target) || buttonRef.current?.contains(target))
      ) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        title={title}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled || servers.length === 0}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex min-w-0 max-w-[240px] items-center gap-[6px] rounded-[var(--radius-pill)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[6px] text-left font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          className={`shrink-0 text-[10px] ${serverHealthColorClass(selectedHealth)}`}
          aria-hidden
        >
          {serverHealthIndicator(selectedHealth)}
        </span>
        <span className="min-w-0 flex-1 truncate">{selectedServer?.label ?? "Select server"}</span>
        <ChevronDown className="size-[13px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.5} />
      </button>
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              role="menu"
              aria-label={label}
              className="fixed z-[10050] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] shadow-lg"
              style={{
                top: popoverPos.top,
                left: popoverPos.left,
                width: popoverPos.width,
              }}
              data-ide-input-sink
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="border-b border-[var(--border-card)] px-[10px] py-[7px]">
                <p className="font-sans text-[11px] font-medium text-[var(--text-secondary)]">
                  {label}
                </p>
              </div>
              <VerticalFadedScroll
                measureKey={servers.length}
                edgeColorVar="var(--bg-panel)"
                scrollClassName="hide-scrollbar-y max-h-[min(320px,45vh)] min-h-0 overflow-y-auto overscroll-contain p-[4px]"
              >
                {servers.map((server) => {
                  const selected = server.id === selectedServerId;
                  const health = serverStatusById[server.id]?.health ?? "unknown";
                  return (
                    <button
                      key={server.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      onClick={() => {
                        onSelect(server.id);
                        setOpen(false);
                      }}
                      className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[7px] text-left transition-colors hover:bg-[var(--accent-bg)]"
                    >
                      <span
                        className={`shrink-0 text-[10px] ${serverHealthColorClass(health)}`}
                        aria-hidden
                      >
                        {serverHealthIndicator(health)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-sans text-[12.5px] text-[var(--text-primary)]">
                          {server.label}
                        </span>
                        <span className="mt-[2px] block truncate font-mono text-[10.5px] text-[var(--text-secondary)]">
                          {server.baseUrl}
                        </span>
                      </span>
                      {selected ? (
                        <Check className="size-[13px] shrink-0 text-[var(--text-primary)]" strokeWidth={2} />
                      ) : null}
                    </button>
                  );
                })}
              </VerticalFadedScroll>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

export function ServerConnectionsSettingsPanel() {
  const {
    activeServer,
    settingsServer,
    servers,
    onlineServers,
    serverStatusById,
    requiresDefaultServer,
    setActiveServer,
    setDefaultServer,
  } = useServerConnections();

  return (
    <>
      <PageIntro title="Servers" />
      <DefaultServerSettingsBanner className="mx-[16px] mb-[12px] mt-[4px]" />
      <SettingsSection title="Default settings server">
        <SettingsRow
          searchId="home-server"
          title="Home server for shared preferences"
          description={
            settingsServer
              ? `${settingsServer.baseUrl} · ${serverStatusById[settingsServer.id]?.health ?? "checking"}`
              : requiresDefaultServer
                ? "Pick which server stores theme, keyboard shortcuts, and model toggles."
                : "Unavailable"
          }
          trailing={
            <SettingsServerPicker
              label="Default settings server"
              title="Theme, shortcuts, and models are stored on this server for all chats"
              selectedServerId={settingsServer?.id ?? null}
              servers={servers}
              serverStatusById={serverStatusById}
              onSelect={setDefaultServer}
              disabled={servers.length === 0}
            />
          }
        />
        <SettingsRow
          searchId="active-chat"
          title="Active chat server"
          description={`${activeServer.baseUrl} · ${serverStatusById[activeServer.id]?.health ?? "checking"}`}
          trailing={
            <SettingsServerPicker
              label="Active chat server"
              title="New chats and workspace actions use this server until you switch workspaces"
              selectedServerId={activeServer.id}
              servers={servers}
              serverStatusById={serverStatusById}
              onSelect={setActiveServer}
              disabled={servers.length === 0}
            />
          }
        />
        <SettingsRow
          searchId="connected-runtimes"
          title="Connected runtimes"
          description={
            onlineServers.length > 0
              ? onlineServers.map((server) => server.label).join(", ")
              : "No reachable saved servers yet."
          }
          trailing={
            <span className="rounded-[999px] border border-[var(--border-subtle)] px-[8px] py-[4px] font-sans text-[11px] text-[var(--text-secondary)]">
              {onlineServers.length}
            </span>
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Saved servers" bordered={false}>
        <ServerConnectionsManager
          onActivate={(serverId) => {
            setActiveServer(serverId);
          }}
          onSetDefault={(serverId) => {
            setDefaultServer(serverId);
          }}
        />
      </SettingsSection>
    </>
  );
}
