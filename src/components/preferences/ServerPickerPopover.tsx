"use client";

import {
  Check,
  CircleUserRound,
  Cloud,
  Github,
  Globe,
  Loader2,
  Pencil,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
import {
  BROWSER_MACHINE_BASE_URL,
  BROWSER_MACHINE_SERVER_ID,
  BROWSER_MACHINE_SERVER_LABEL,
  getServerConnectionKey,
  isBrowserMachineUrl,
} from "@cesium/client";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
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
import { useCloudContext } from "@/contexts/CloudContext";
import { shouldShowServerUrlInDevicePicker } from "@/lib/account-server-sync";
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
import {
  categorizeCodespaceState,
  codespaceBaseUrlKeys,
  codespaceStateLabel,
  type CodespaceDevice,
  type CodespaceWakePhase,
} from "@/lib/github-codespaces";
import type {
  CodespaceWakeFailure,
  CodespaceWakeStatus,
} from "@/hooks/useGithubCodespaces";

const WAKE_PHASE_LABELS: Record<CodespaceWakePhase, string> = {
  "checking-engine": "Checking…",
  "checking-codespace": "Checking codespace…",
  "starting-codespace": "Starting codespace…",
  "waiting-engine": "Waiting for the engine…",
  "signing-in": "Signing in…",
  ready: "Connected",
};

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
  /**
   * Paired GitHub Codespace devices. These are real engines (their merged
   * local connections are filtered out of the plain list above) rendered in
   * a dedicated section with codespace state and auto-wake on select.
   */
  codespaceDevices?: CodespaceDevice[];
  codespaceWakeStatus?: CodespaceWakeStatus | null;
  codespaceWakeFailure?: CodespaceWakeFailure | null;
  onSelectCodespaceDevice?: (device: CodespaceDevice) => void;
  onRecreateCodespaceDevice?: (device: CodespaceDevice) => void;
  /** Opens the Codespace setup wizard (device variant footer entry). */
  onSetupCodespace?: () => void;
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
  codespaceDevices = [],
  codespaceWakeStatus = null,
  codespaceWakeFailure = null,
  onSelectCodespaceDevice,
  onRecreateCodespaceDevice,
  onSetupCodespace,
}: ServerPickerPopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [popoverPos, setPopoverPos] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxHeight: number;
  }>({
    top: 0,
    left: 0,
    width: 280,
    maxHeight: 420,
  });
  const [connectOpen, setConnectOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const { saveServer, removeServer } = useServerConnections();
  const { updateWorkspaceSession } = useWorkspace();
  const { openSettingsView } = useShellView();
  const cloud = useCloudContext();

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      return;
    }
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewportPad = 10;
      const gap = 8;
      const visual = window.visualViewport;
      const viewTop = visual?.offsetTop ?? 0;
      const viewLeft = visual?.offsetLeft ?? 0;
      const viewWidth = visual?.width ?? window.innerWidth;
      const viewHeight = visual?.height ?? window.innerHeight;
      const viewBottom = viewTop + viewHeight;
      const layoutBottomInset = Math.max(0, window.innerHeight - viewBottom);
      const width = Math.min(320, Math.max(0, viewWidth - viewportPad * 2));
      const left = Math.max(
        viewLeft + viewportPad,
        Math.min(rect.left, viewLeft + viewWidth - width - viewportPad)
      );
      if (placement === "above") {
        const bottom = Math.max(
          viewportPad + layoutBottomInset,
          window.innerHeight - rect.top + gap
        );
        const maxHeight = Math.max(160, rect.top - gap - viewTop - viewportPad);
        setPopoverPos({ bottom, left, width, maxHeight });
        return;
      }
      const top = Math.max(viewTop + viewportPad, rect.bottom + gap);
      const maxHeight = Math.max(160, viewBottom - top - viewportPad);
      setPopoverPos({ top, left, width, maxHeight });
    };
    update();
    const resizeObserver =
      popoverRef.current == null ? null : new ResizeObserver(() => update());
    if (popoverRef.current && resizeObserver) {
      resizeObserver.observe(popoverRef.current);
    }
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
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

  const showCodespaceSection =
    Boolean(onSelectCodespaceDevice) &&
    (codespaceDevices.length > 0 || (variant === "device" && Boolean(onSetupCodespace)));
  const codespaceKeys = useMemo(
    () => codespaceBaseUrlKeys(codespaceDevices),
    [codespaceDevices]
  );
  // Codespace engines also live in the plain connection list (cloud merge);
  // hide them there so each device renders exactly once, in its section.
  const visibleServers = useMemo(() => {
    if (codespaceDevices.length === 0 || !showCodespaceSection) {
      return servers;
    }
    return servers.filter((server) => {
      try {
        return !codespaceKeys.has(getServerConnectionKey(server.baseUrl));
      } catch {
        return true;
      }
    });
  }, [codespaceDevices.length, codespaceKeys, servers, showCodespaceSection]);

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
      className="fixed z-[10050] flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] shadow-lg"
      style={{
        top: popoverPos.top,
        bottom: popoverPos.bottom,
        left: popoverPos.left,
        width: popoverPos.width,
        maxHeight: popoverPos.maxHeight,
      }}
      data-ide-input-sink
      onPointerDown={(event) => event.stopPropagation()}
    >
      <VerticalFadedScroll
        wrapperClassName={connectOpen ? "shrink-0" : undefined}
        measureKey={`${servers.length}\0${connectOpen ? 1 : 0}\0${renamingId ?? ""}\0${cloudDevices.length}\0${selectedCloudDeviceId ?? ""}\0${codespaceDevices.length}\0${codespaceWakeStatus?.phase ?? ""}\0${codespaceWakeFailure?.deviceKey ?? ""}`}
        scrollClassName={
          connectOpen
            ? "hide-scrollbar-y max-h-[min(140px,28dvh)] min-h-0 overflow-y-auto overscroll-contain p-[4px]"
            : "hide-scrollbar-y max-h-[min(420px,70dvh)] min-h-0 overflow-y-auto overscroll-contain p-[4px]"
        }
      >
        {visibleServers.map((server, index) => {
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
                  {isBrowserMachineUrl(server.baseUrl) ? (
                    <Globe
                      className="size-[14px] shrink-0 text-[var(--text-secondary)]"
                      strokeWidth={1.5}
                      aria-hidden
                    />
                  ) : isLocalDevice ? (
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
                    {shouldShowServerUrlInDevicePicker({
                      cloud,
                      isLocalDevice,
                    }) && !isBrowserMachineUrl(server.baseUrl) ? (
                      <span className="mt-[2px] block truncate font-mono text-[10.5px] text-[var(--text-secondary)]">
                        {server.baseUrl}
                      </span>
                    ) : null}
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
        {showCodespaceSection ? (
          <div className="mt-[4px] border-t border-[var(--border-card)] pt-[4px]">
            <div className="px-[8px] pb-[2px] pt-[4px] font-sans text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              GitHub Codespaces
            </div>
            {codespaceDevices.map((device) => {
              const selected =
                device.localServerId !== null &&
                device.localServerId === selectedServerId &&
                !selectedCloudDeviceId;
              const waking = codespaceWakeStatus?.deviceKey === device.key;
              const failure =
                codespaceWakeFailure?.deviceKey === device.key
                  ? codespaceWakeFailure
                  : null;
              const health = device.localServerId
                ? serverStatusById[device.localServerId]?.health ?? "unknown"
                : "unknown";
              return (
                <div key={device.key} className="flex w-full min-w-0 flex-col">
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    disabled={waking}
                    onClick={() => onSelectCodespaceDevice?.(device)}
                    className="flex w-full min-w-0 items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[8px] text-left hover:bg-[var(--accent-bg)] disabled:opacity-70 sm:py-[7px]"
                  >
                    {waking ? (
                      <Loader2
                        className="size-[14px] shrink-0 animate-spin text-[var(--text-secondary)]"
                        strokeWidth={1.7}
                        aria-hidden
                      />
                    ) : (
                      <Github
                        className="size-[14px] shrink-0 text-[var(--text-secondary)]"
                        strokeWidth={1.5}
                        aria-hidden
                      />
                    )}
                    <span
                      className={`shrink-0 text-[10px] ${serverHealthColorClass(health)}`}
                      aria-hidden
                    >
                      {serverHealthIndicator(health)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-sans text-[12.5px] text-[var(--text-primary)]">
                        {device.label}
                      </span>
                      <span className="mt-[2px] block truncate font-sans text-[10.5px] text-[var(--text-secondary)]">
                        {waking && codespaceWakeStatus
                          ? WAKE_PHASE_LABELS[codespaceWakeStatus.phase]
                          : health === "healthy"
                            ? "Running"
                            : categorizeCodespaceState(device.lastKnownState) ===
                                "running"
                              ? // Engine unreachable but GitHub last said running:
                                // it likely idled out since we last synced.
                                "Asleep - select to wake"
                              : codespaceStateLabel(device.lastKnownState)}
                      </span>
                    </span>
                    {selected ? (
                      <Check
                        className="size-[13px] shrink-0 text-[var(--text-primary)]"
                        strokeWidth={2}
                      />
                    ) : null}
                  </button>
                  {failure ? (
                    <div className="mx-[8px] mb-[6px] flex flex-col gap-[6px] rounded-[var(--radius-tab)] bg-[var(--accent-bg)] px-[8px] py-[6px]">
                      <p className="font-sans text-[10.5px] leading-snug text-[var(--goal-accent)]">
                        {failure.message}
                      </p>
                      {failure.reason === "deleted" && onRecreateCodespaceDevice ? (
                        <button
                          type="button"
                          onClick={() => onRecreateCodespaceDevice(device)}
                          className="self-start rounded-[var(--radius-tab)] bg-[var(--accent)] px-[8px] py-[3px] font-sans text-[10.5px] text-[var(--bg-panel)]"
                        >
                          Recreate codespace
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {variant === "device" && onSetupCodespace ? (
              <button
                type="button"
                onClick={onSetupCodespace}
                className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[7px] text-left font-sans text-[12px] text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
              >
                <Plus className="size-[13px] shrink-0" strokeWidth={1.5} aria-hidden />
                Set up a Codespace…
              </button>
            ) : null}
          </div>
        ) : null}
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
        <div
          className={`flex min-h-0 flex-col border-t border-[var(--border-card)] p-[4px] ${
            connectOpen ? "flex-1 overflow-hidden" : ""
          }`}
        >
          {servers.some((server) => isBrowserMachineUrl(server.baseUrl)) ? null : (
            <button
              type="button"
              onClick={() => {
                const saved = saveServer({
                  id: BROWSER_MACHINE_SERVER_ID,
                  label: BROWSER_MACHINE_SERVER_LABEL,
                  baseUrl: BROWSER_MACHINE_BASE_URL,
                });
                onSelect(saved.id);
                onClose();
              }}
              className="flex w-full shrink-0 items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--accent-bg)]"
            >
              <Globe className="size-[13px] shrink-0" strokeWidth={1.5} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">Use this browser</span>
                <span className="mt-[1px] block truncate font-sans text-[10.5px] text-[var(--text-secondary)]">
                  Runs entirely in this tab - no server needed
                </span>
              </span>
            </button>
          )}
          <button
            type="button"
            aria-expanded={connectOpen}
            onClick={() => setConnectOpen((openConnect) => !openConnect)}
            className="flex w-full shrink-0 items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--accent-bg)]"
          >
            <Plus className="size-[13px] shrink-0" strokeWidth={1.5} />
            Connect a device
          </button>
          {connectOpen ? (
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <DeviceConnectPanel
                onConnected={(serverId) => {
                  onSelect(serverId);
                  setConnectOpen(false);
                  onClose();
                }}
              />
            </div>
          ) : null}
          <button
            type="button"
            onClick={openAdvancedServers}
            className="flex w-full shrink-0 items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
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
