"use client";

import { Check, CircleUserRound, Cloud, Pencil, Plus, Settings, Trash2 } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { VerticalFadedScroll } from "@/components/chat/VerticalFadedScroll";
import { DeviceConnectPanel } from "@/components/preferences/DeviceConnectPanel";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { useShellView } from "@/components/layout/ShellViewContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import type { ServerRailAppearance } from "@/lib/global-settings";
import {
  getServerDisplayLabel,
  getServerRailAppearance,
  isLocalDeviceServer,
} from "@/lib/server-rail-appearance";
import {
  serverHealthColorClass,
  serverHealthIndicator,
} from "@/lib/server-health-display";
import { WorkspaceFolderIcon } from "@/lib/workspace-rail-appearance";
import type { CloudExecutionDevice } from "@/lib/cloud-execution-devices";

export type ServerPickerPopoverProps = {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  selectedServerId: string;
  servers: Array<{ id: string; label: string; baseUrl: string }>;
  serverStatusById: Record<string, { health: string } | undefined>;
  serverRailAppearances?: Record<string, ServerRailAppearance>;
  onSelect: (serverId: string) => void;
  /** Rail footer opens upward; settings pickers open below the trigger. */
  placement?: "above" | "below";
  /** Device surface adds connect / rename / remove / advanced settings. */
  variant?: "switch" | "device";
  /**
   * Cloud pseudo-devices from cloud-capable backends (e.g. Cursor Cloud).
   * Rendered as a dedicated section; selecting one does not change the
   * active server - new chats execute on the vendor's cloud instead.
   */
  cloudDevices?: CloudExecutionDevice[];
  /** Active cloud pseudo-device id; overrides server selection highlighting. */
  selectedCloudDeviceId?: string | null;
  onSelectCloudDevice?: (cloudDeviceId: string) => void;
};

export function ServerPickerPopover({
  open,
  onClose,
  anchorRef,
  label,
  selectedServerId,
  servers,
  serverStatusById,
  serverRailAppearances = {},
  onSelect,
  placement = "below",
  variant = "switch",
  cloudDevices = [],
  selectedCloudDeviceId = null,
  onSelectCloudDevice,
}: ServerPickerPopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0, width: 280 });
  const [connectOpen, setConnectOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const { saveServer, removeServer } = useServerConnections();
  const { updateWorkspaceSession } = useWorkspace();
  const { openSettingsView } = useShellView();

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      return;
    }
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewportPad = 8;
      const width = Math.min(320, Math.max(0, window.innerWidth - viewportPad * 2));
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const gap = 6;
      const estimatedHeight = popoverRef.current?.offsetHeight ?? (variant === "device" ? 360 : 280);
      const desiredTop =
        placement === "above"
          ? rect.top - estimatedHeight - gap
          : rect.bottom + gap;
      const maxTop = Math.max(viewportPad, window.innerHeight - estimatedHeight - viewportPad);
      const top = Math.max(viewportPad, Math.min(desiredTop, maxTop));
      setPopoverPos({ top, left, width });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, connectOpen, open, placement, renamingId, servers.length, variant]);

  useEffect(() => {
    if (!open) {
      setConnectOpen(false);
      setRenamingId(null);
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        (popoverRef.current?.contains(target) || anchorRef.current?.contains(target))
      ) {
        return;
      }
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [anchorRef, onClose, open]);

  if (!open) {
    return null;
  }

  const commitRename = (server: { id: string; label: string; baseUrl: string }) => {
    const nextLabel = renameValue.trim();
    if (nextLabel && nextLabel !== server.label) {
      saveServer({ id: server.id, label: nextLabel, baseUrl: server.baseUrl });
    }
    setRenamingId(null);
  };

  const openAdvancedServers = () => {
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: { ...current.settingsView, activeNav: "servers" },
    }));
    openSettingsView();
    onClose();
  };

  return createPortal(
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
      <VerticalFadedScroll
        measureKey={`${servers.length}\0${connectOpen ? 1 : 0}\0${renamingId ?? ""}\0${cloudDevices.length}\0${selectedCloudDeviceId ?? ""}`}
        scrollClassName="hide-scrollbar-y max-h-[min(420px,70dvh)] min-h-0 overflow-y-auto overscroll-contain p-[4px]"
      >
        {servers.map((server, index) => {
          const selected = server.id === selectedServerId && !selectedCloudDeviceId;
          const health = serverStatusById[server.id]?.health ?? "unknown";
          const appearance = getServerRailAppearance(serverRailAppearances, server.id, index);
          const displayLabel = getServerDisplayLabel(server, appearance);
          const isLocalDevice = isLocalDeviceServer(server);
          const renaming = renamingId === server.id;
          return (
            <div key={server.id} className="flex w-full min-w-0 flex-col">
              <div className="flex w-full min-w-0 items-center gap-[4px] rounded-[var(--radius-tab)] hover:bg-[var(--accent-bg)]">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => {
                    onSelect(server.id);
                    onClose();
                  }}
                  className="flex min-w-0 flex-1 items-center gap-[8px] px-[8px] py-[8px] text-left sm:py-[7px]"
                >
                  {isLocalDevice ? (
                    <CircleUserRound
                      className="size-[14px] shrink-0 text-[var(--text-secondary)]"
                      strokeWidth={1.5}
                      aria-hidden
                    />
                  ) : (
                    <WorkspaceFolderIcon
                      iconName={appearance.icon}
                      color={appearance.color}
                      className="size-[14px] shrink-0"
                      strokeWidth={1.8}
                    />
                  )}
                  <span
                    className={`shrink-0 text-[10px] ${serverHealthColorClass(health)}`}
                    aria-hidden
                  >
                    {serverHealthIndicator(health)}
                  </span>
                  <span className="min-w-0 flex-1">
                    {renaming ? (
                      <input
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            commitRename(server);
                          }
                          if (event.key === "Escape") {
                            event.preventDefault();
                            setRenamingId(null);
                          }
                        }}
                        onBlur={() => commitRename(server)}
                        autoFocus
                        className="w-full bg-transparent font-sans text-[12.5px] text-[var(--text-primary)] outline-none"
                        aria-label="Device name"
                      />
                    ) : (
                      <span className="block truncate font-sans text-[12.5px] text-[var(--text-primary)]">
                        {displayLabel}
                      </span>
                    )}
                    <span className="mt-[2px] block truncate font-mono text-[10.5px] text-[var(--text-secondary)]">
                      {server.baseUrl}
                    </span>
                  </span>
                  {selected ? (
                    <Check className="size-[13px] shrink-0 text-[var(--text-primary)]" strokeWidth={2} />
                  ) : null}
                </button>
                {variant === "device" ? (
                  <div className="flex shrink-0 items-center pr-[4px]">
                    <button
                      type="button"
                      aria-label={`Rename ${displayLabel}`}
                      title="Rename"
                      onClick={(event) => {
                        event.stopPropagation();
                        setRenamingId(server.id);
                        setRenameValue(displayLabel);
                      }}
                      className="flex size-[26px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
                    >
                      <Pencil className="size-[12px]" strokeWidth={1.7} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${displayLabel}`}
                      title="Remove"
                      disabled={servers.length <= 1}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (servers.length <= 1) {
                          return;
                        }
                        if (
                          typeof window !== "undefined" &&
                          !window.confirm(`Remove ${displayLabel} from this device list?`)
                        ) {
                          return;
                        }
                        removeServer(server.id);
                      }}
                      className="flex size-[26px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] disabled:opacity-35"
                    >
                      <Trash2 className="size-[12px]" strokeWidth={1.7} />
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
        {cloudDevices.length > 0 && onSelectCloudDevice ? (
          <div className="mt-[4px] border-t border-[var(--border-card)] pt-[4px]">
            <div className="px-[8px] pb-[2px] pt-[4px] font-sans text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              Cloud
            </div>
            {cloudDevices.map((device) => {
              const selected = device.id === selectedCloudDeviceId;
              return (
                <button
                  key={device.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => {
                    onSelectCloudDevice(device.id);
                    onClose();
                  }}
                  className="flex w-full min-w-0 items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[8px] text-left hover:bg-[var(--accent-bg)] sm:py-[7px]"
                >
                  <Cloud
                    className="size-[14px] shrink-0 text-[var(--text-secondary)]"
                    strokeWidth={1.5}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-sans text-[12.5px] text-[var(--text-primary)]">
                      {device.label}
                    </span>
                    <span className="mt-[2px] block truncate font-sans text-[10.5px] text-[var(--text-secondary)]">
                      {device.description}
                    </span>
                  </span>
                  {selected ? (
                    <Check
                      className="size-[13px] shrink-0 text-[var(--text-primary)]"
                      strokeWidth={2}
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </VerticalFadedScroll>
      {variant === "device" ? (
        <div className="border-t border-[var(--border-card)] p-[4px]">
          <button
            type="button"
            onClick={() => setConnectOpen((openConnect) => !openConnect)}
            className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--accent-bg)]"
          >
            <Plus className="size-[13px] shrink-0" strokeWidth={1.5} />
            Connect a device
          </button>
          {connectOpen ? (
            <DeviceConnectPanel
              onConnected={(serverId) => {
                onSelect(serverId);
                setConnectOpen(false);
                onClose();
              }}
            />
          ) : null}
          <button
            type="button"
            onClick={openAdvancedServers}
            className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
          >
            <Settings className="size-[13px] shrink-0" strokeWidth={1.5} />
            Advanced…
          </button>
        </div>
      ) : null}
    </div>,
    document.body
  );
}
