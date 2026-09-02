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
  isBrowserMachineOffered,
  isBrowserMachineUrl,
} from "@cesium/client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { VerticalFadedScroll } from "@/components/chat/VerticalFadedScroll";
import { useWorkbenchDialogs } from "@/components/dialogs/WorkbenchDialogProvider";
import { DeviceConnectPanel } from "@/components/preferences/DeviceConnectPanel";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { useShellView } from "@/components/layout/ShellViewContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useCloudContext } from "@/contexts/CloudContext";
import { shouldShowServerUrlInDevicePicker } from "@/lib/account-server-sync";
import {
  devicePickerServerEntryId,
  isDevicePickerEntryHidden,
  isDevicePickerKindHidden,
  sortByDevicePickerOrder,
  type ServerRailAppearance,
} from "@/lib/global-settings";
import {
  getServerDisplayLabel,
  getServerRailAppearance,
  isLocalDeviceServer,
  pickStableServerColor,
} from "@/lib/server-rail-appearance";
import {
  serverHealthColorClass,
  serverHealthIndicator,
} from "@/lib/server-health-display";
import { isValidFolderColor, WorkspaceFolderIcon } from "@/lib/workspace-rail-appearance";
import { RailIconCustomizePanel } from "@/components/ui/RailIconCustomizePanel";
import type { CloudExecutionDevice } from "@/lib/cloud-execution-devices";
import {
  categorizeCodespaceState,
  codespaceBaseUrlKeys,
  codespacePairingMeta,
  codespaceStateLabel,
  type CodespaceDevice,
  type CodespaceWakePhase,
} from "@/lib/github-codespaces";
import type {
  CodespaceWakeFailure,
  CodespaceWakeStatus,
} from "@/hooks/useGithubCodespaces";

/**
 * Subtitle for a codespace whose engine is not answering. Both "GitHub last
 * said Available" (idled out since) and "GitHub says Shutdown" mean the same
 * thing to the user: one click brings it back. Only deleted / failed /
 * transitional states need their own words.
 */
function codespaceSleepingLabel(lastKnownState: string | null): string {
  switch (categorizeCodespaceState(lastKnownState)) {
    case "running":
    case "stopped":
    case "unknown":
      return "Asleep - select to wake";
    default:
      return codespaceStateLabel(lastKnownState);
  }
}

const WAKE_PHASE_LABELS: Record<CodespaceWakePhase, string> = {
  "checking-engine": "Checking…",
  "checking-codespace": "Checking codespace…",
  "starting-codespace": "Starting codespace…",
  "waiting-engine": "Waiting for the engine…",
  "signing-in": "Signing in…",
  "updating-engine": "Updating the engine…",
  ready: "Connected",
};

type PickerServer = { id: string; label: string; baseUrl: string };

/**
 * One flat list: saved servers, GitHub Codespaces, and cloud pseudo-devices
 * share a row shape and differ only by a small kind badge. Ids match the
 * device-picker settings so hiding / ranking applies across all of them.
 */
type PickerItem =
  | { kind: "server"; id: string; server: PickerServer; index: number }
  | { kind: "codespace"; id: string; device: CodespaceDevice }
  | { kind: "cloud"; id: string; device: CloudExecutionDevice };

export type ServerPickerPopoverProps = {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  selectedServerId: string;
  servers: PickerServer[];
  serverStatusById: Record<string, { health: string } | undefined>;
  serverRailAppearances?: Record<string, ServerRailAppearance>;
  onSelect: (serverId: string) => void;
  /** Rail footer opens upward; settings pickers open below the trigger. */
  placement?: "above" | "below";
  /** Device surface adds connect / rename / remove / advanced settings. */
  variant?: "switch" | "device";
  /**
   * Cloud pseudo-devices from cloud-capable backends (e.g. Cursor Cloud).
   * Listed inline with a "Cloud" badge; selecting one does not change the
   * active server - new chats execute on the vendor's cloud instead.
   */
  cloudDevices?: CloudExecutionDevice[];
  /** Active cloud pseudo-device id; overrides server selection highlighting. */
  selectedCloudDeviceId?: string | null;
  onSelectCloudDevice?: (cloudDeviceId: string) => void;
  /**
   * Paired GitHub Codespace devices. These are real engines (their merged
   * local connections are filtered out of the plain server list) listed
   * inline with a "Codespace" badge, codespace state, and auto-wake on select.
   */
  codespaceDevices?: CodespaceDevice[];
  codespaceWakeStatus?: CodespaceWakeStatus | null;
  codespaceWakeFailure?: CodespaceWakeFailure | null;
  onSelectCodespaceDevice?: (device: CodespaceDevice) => void;
  onRecreateCodespaceDevice?: (device: CodespaceDevice) => void;
  /** Opens the Codespace setup wizard (device variant footer entry). */
  onSetupCodespace?: () => void;
};

/** Small trailing pill naming non-default device kinds. */
export function DeviceKindBadge({
  kind,
}: {
  kind: "codespace" | "cloud" | "browser";
}) {
  const { label, title, Icon } =
    kind === "codespace"
      ? { label: "Codespace", title: "GitHub Codespace", Icon: Github }
      : kind === "cloud"
        ? { label: "Cloud", title: "Cloud execution", Icon: Cloud }
        : { label: "Browser", title: "Runs in this browser tab", Icon: Globe };
  return (
    <span
      className="inline-flex shrink-0 items-center gap-[3px] rounded-[999px] border border-[var(--border-subtle)] px-[5px] py-[1px] font-sans text-[9.5px] font-medium uppercase tracking-[0.04em] text-[var(--text-secondary)]"
      title={title}
      data-device-kind={kind}
    >
      <Icon className="size-[9px]" strokeWidth={1.8} aria-hidden />
      {label}
    </span>
  );
}

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
  const { saveServer, removeServer } = useServerConnections();
  const dialogs = useWorkbenchDialogs();
  const { updateWorkspaceSession } = useWorkspace();
  const { openSettingsView } = useShellView();
  const cloud = useCloudContext();
  const { settings, updateSettings } = useGlobalSettings();
  const devicePicker = settings.general.devicePicker;

  /**
   * One inline customize panel (name + icon + color) at a time, shared by
   * plain servers and Codespace devices so both kinds get the same
   * customization surface. Icon and color apply live; the name commits when
   * the panel (or the whole popover) closes.
   */
  const [customize, setCustomize] = useState<
    | { kind: "server"; id: string; baseUrl: string; label: string }
    | { kind: "codespace"; device: CodespaceDevice }
    | null
  >(null);
  const [nameDraft, setNameDraft] = useState("");

  const commitCustomizeName = useCallback(() => {
    if (!customize) {
      return;
    }
    const next = nameDraft.trim();
    if (!next) {
      return;
    }
    if (customize.kind === "server") {
      if (next !== customize.label) {
        saveServer({ id: customize.id, label: next, baseUrl: customize.baseUrl });
      }
      return;
    }
    const device = customize.device;
    if (next === device.label) {
      return;
    }
    // The durable name lives on the account pairing row (it syncs to every
    // device); the merged local connection mirrors it so this device agrees
    // immediately.
    if (device.localServerId) {
      saveServer({ id: device.localServerId, label: next, baseUrl: device.baseUrl });
    }
    void cloud.actions
      ?.saveServer({
        name: next,
        baseUrl: device.baseUrl,
        kind: "codespace",
        codespace: codespacePairingMeta(device),
      })
      .catch(() => undefined);
  }, [cloud.actions, customize, nameDraft, saveServer]);

  const closeCustomize = useCallback(() => {
    commitCustomizeName();
    setCustomize(null);
  }, [commitCustomizeName]);
  const closeCustomizeRef = useRef(closeCustomize);
  closeCustomizeRef.current = closeCustomize;

  const updateEntryAppearance = useCallback(
    (
      entryId: string,
      fallback: { icon: string; color: string },
      patch: { icon?: string; color?: string }
    ) => {
      updateSettings((current) => {
        const saved = current.general.serverRailAppearances[entryId];
        const base = {
          icon: saved?.icon || fallback.icon,
          color: saved?.color || fallback.color,
          ...(saved?.nickname ? { nickname: saved.nickname } : {}),
        };
        const nextIcon = patch.icon?.trim() || base.icon;
        const nextColor =
          patch.color && isValidFolderColor(patch.color) ? patch.color : base.color;
        return {
          ...current,
          general: {
            ...current.general,
            serverRailAppearances: {
              ...current.general.serverRailAppearances,
              [entryId]: { ...base, icon: nextIcon, color: nextColor },
            },
          },
        };
      });
    },
    [updateSettings]
  );

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
  }, [anchorRef, connectOpen, customize, open, placement, servers.length, variant]);

  useEffect(() => {
    if (!open) {
      setConnectOpen(false);
      // Commit a pending rename before the panel state is dropped, so
      // closing the popover mid-edit never loses the typed name.
      closeCustomizeRef.current();
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

  const offerBrowserMachine = isBrowserMachineOffered();
  const codespacesEnabled =
    Boolean(onSelectCodespaceDevice) && !isDevicePickerKindHidden(devicePicker, "codespace");
  const cloudEnabled =
    Boolean(onSelectCloudDevice) && !isDevicePickerKindHidden(devicePicker, "cloud");
  const showSetupCodespace =
    variant === "device" &&
    Boolean(onSetupCodespace) &&
    codespacesEnabled &&
    !isDevicePickerEntryHidden(devicePicker, "action:setup-codespace");
  const showBrowserAction = !isDevicePickerEntryHidden(devicePicker, "action:browser");
  const showConnectAction = !isDevicePickerEntryHidden(devicePicker, "action:connect");

  const codespaceKeys = useMemo(
    () => codespaceBaseUrlKeys(codespaceDevices),
    [codespaceDevices]
  );

  // Build the flat list: servers (MRU order) -> codespaces -> cloud, then the
  // user's ranking on top. User-hidden entries stay visible while they are
  // the active selection so the picker never shows an empty highlight.
  const items = useMemo<PickerItem[]>(() => {
    const out: PickerItem[] = [];
    const surfaceServers = offerBrowserMachine
      ? servers
      : servers.filter((server) => !isBrowserMachineUrl(server.baseUrl));
    surfaceServers.forEach((server, index) => {
      // Codespace engines also live in the plain connection list (cloud
      // merge); drop them here so each device renders exactly once.
      if (codespacesEnabled && codespaceDevices.length > 0) {
        try {
          if (codespaceKeys.has(getServerConnectionKey(server.baseUrl))) {
            return;
          }
        } catch {
          // Unparseable URL: keep the row.
        }
      }
      const id = devicePickerServerEntryId(server.id);
      if (server.id !== selectedServerId && isDevicePickerEntryHidden(devicePicker, id)) {
        return;
      }
      out.push({ kind: "server", id, server, index });
    });
    if (codespacesEnabled) {
      for (const device of codespaceDevices) {
        const selected =
          device.localServerId !== null && device.localServerId === selectedServerId;
        if (!selected && isDevicePickerEntryHidden(devicePicker, device.key)) {
          continue;
        }
        out.push({ kind: "codespace", id: device.key, device });
      }
    }
    if (cloudEnabled) {
      for (const device of cloudDevices) {
        if (
          device.id !== selectedCloudDeviceId &&
          isDevicePickerEntryHidden(devicePicker, device.id)
        ) {
          continue;
        }
        out.push({ kind: "cloud", id: device.id, device });
      }
    }
    return sortByDevicePickerOrder(out, devicePicker.order, (item) => item.id);
  }, [
    cloudDevices,
    cloudEnabled,
    codespaceDevices,
    codespaceKeys,
    codespacesEnabled,
    devicePicker,
    offerBrowserMachine,
    selectedCloudDeviceId,
    selectedServerId,
    servers,
  ]);

  if (!open) {
    return null;
  }

  const openAdvancedServers = () => {
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: { ...current.settingsView, activeNav: "servers" },
    }));
    openSettingsView();
    onClose();
  };

  const rowClass =
    "flex w-full min-w-0 items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[8px] text-left sm:py-[7px]";
  const titleClass = "block truncate font-sans text-[12.5px] text-[var(--text-primary)]";
  const subtitleClass =
    "mt-[2px] block truncate font-sans text-[10.5px] text-[var(--text-secondary)]";
  const iconClass = "size-[14px] shrink-0 text-[var(--text-secondary)]";

  const renderHealth = (health: string) => (
    <span className={`shrink-0 text-[10px] ${serverHealthColorClass(health)}`} aria-hidden>
      {serverHealthIndicator(health)}
    </span>
  );
  const renderCheck = (selected: boolean) =>
    selected ? (
      <Check className="size-[13px] shrink-0 text-[var(--text-primary)]" strokeWidth={2} />
    ) : null;

  const renderServerRow = (item: Extract<PickerItem, { kind: "server" }>): ReactNode => {
    const { server, index } = item;
    const selected = server.id === selectedServerId && !selectedCloudDeviceId;
    const health = serverStatusById[server.id]?.health ?? "unknown";
    const appearance = getServerRailAppearance(serverRailAppearances, server.id, index);
    const displayLabel = getServerDisplayLabel(server, appearance);
    const isLocalDevice = isLocalDeviceServer(server);
    const isBrowser = isBrowserMachineUrl(server.baseUrl);
    const customizing = customize?.kind === "server" && customize.id === server.id;
    return (
      <div key={item.id} className="flex w-full min-w-0 flex-col">
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
            {isBrowser ? (
              <Globe className={iconClass} strokeWidth={1.5} aria-hidden />
            ) : isLocalDevice ? (
              <CircleUserRound className={iconClass} strokeWidth={1.5} aria-hidden />
            ) : (
              <WorkspaceFolderIcon
                iconName={appearance.icon}
                color={appearance.color}
                className="size-[14px] shrink-0"
                strokeWidth={1.8}
              />
            )}
            {renderHealth(health)}
            <span className="min-w-0 flex-1">
              <span className={titleClass}>{displayLabel}</span>
              {shouldShowServerUrlInDevicePicker({ cloud, isLocalDevice }) && !isBrowser ? (
                <span className="mt-[2px] block truncate font-mono text-[10.5px] text-[var(--text-secondary)]">
                  {server.baseUrl}
                </span>
              ) : null}
            </span>
            {isBrowser ? <DeviceKindBadge kind="browser" /> : null}
            {renderCheck(selected)}
          </button>
          {variant === "device" ? (
            <div className="flex shrink-0 items-center pr-[4px]">
              <button
                type="button"
                aria-label={`Customize ${displayLabel}`}
                title="Rename and customize"
                onClick={(event) => {
                  event.stopPropagation();
                  if (customizing) {
                    closeCustomize();
                    return;
                  }
                  commitCustomizeName();
                  setCustomize({
                    kind: "server",
                    id: server.id,
                    baseUrl: server.baseUrl,
                    label: server.label,
                  });
                  setNameDraft(server.label);
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
                  void dialogs
                    .confirm({
                      title: `Remove ${displayLabel}?`,
                      message:
                        "The device is removed from this list only. Nothing on the device itself changes, and you can connect it again later.",
                      detail: isBrowser ? undefined : server.baseUrl,
                      tone: "danger",
                      confirmLabel: "Remove",
                    })
                    .then((confirmed) => {
                      if (confirmed) {
                        removeServer(server.id);
                      }
                    });
                }}
                className="flex size-[26px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] disabled:opacity-35"
              >
                <Trash2 className="size-[12px]" strokeWidth={1.7} />
              </button>
            </div>
          ) : null}
        </div>
        {customizing ? (
          <div className="mb-[6px] mr-[8px]">
            <RailIconCustomizePanel
              title={displayLabel}
              icon={appearance.icon}
              color={appearance.color}
              showNameField={!isBrowser && !isLocalDevice}
              name={nameDraft}
              nameFieldLabel="Device name"
              allowEmptyName
              onClose={closeCustomize}
              onUpdate={(patch) => {
                if (patch.name !== undefined) {
                  setNameDraft(patch.name);
                }
                if (patch.icon !== undefined || patch.color !== undefined) {
                  updateEntryAppearance(server.id, appearance, patch);
                }
              }}
            />
          </div>
        ) : null}
      </div>
    );
  };

  /**
   * Unpair a Codespace device: removes the account pairing (every signed-in
   * device drops it) and its merged local connection, after offering to also
   * delete the codespace on GitHub so it stops consuming storage. Keeping
   * the codespace is safe - setup for the same repository adopts it again.
   */
  const unpairCodespace = async (device: CodespaceDevice, displayLabel: string) => {
    const confirmed = await dialogs.confirm({
      title: `Remove ${displayLabel}?`,
      message:
        "The Codespace pairing is removed from your account, so it disappears from the device list on every signed-in device.",
      detail: device.repoFullName,
      tone: "danger",
      confirmLabel: "Remove",
    });
    if (!confirmed) {
      return;
    }
    let deleteOnGithub = false;
    if (cloud.github) {
      deleteOnGithub = await dialogs.confirm({
        title: "Also delete the codespace on GitHub?",
        message:
          "Deleting frees your GitHub Codespaces storage but discards any uncommitted work inside it. If you keep it, pairing this repository again reuses it.",
        detail: device.codespaceName,
        tone: "danger",
        confirmLabel: "Delete on GitHub",
        cancelLabel: "Keep it",
      });
    }
    if (deleteOnGithub) {
      try {
        await cloud.github?.deleteCodespace(device.codespaceName);
      } catch {
        // Unpairing below still applies; the codespace can be deleted from
        // github.com/codespaces by hand.
      }
    }
    if (device.localServerId) {
      removeServer(device.localServerId);
    }
    void cloud.actions?.removeServer({ baseUrl: device.baseUrl }).catch(() => undefined);
  };

  const renderCodespaceRow = (item: Extract<PickerItem, { kind: "codespace" }>): ReactNode => {
    const { device } = item;
    const selected =
      device.localServerId !== null &&
      device.localServerId === selectedServerId &&
      !selectedCloudDeviceId;
    const waking = codespaceWakeStatus?.deviceKey === device.key;
    const failure =
      codespaceWakeFailure?.deviceKey === device.key ? codespaceWakeFailure : null;
    const health = device.localServerId
      ? serverStatusById[device.localServerId]?.health ?? "unknown"
      : "unknown";
    const stateLabel =
      waking && codespaceWakeStatus
        ? WAKE_PHASE_LABELS[codespaceWakeStatus.phase]
        : health === "healthy"
          ? "Running"
          : codespaceSleepingLabel(device.lastKnownState);
    // Appearance parity with plain servers, keyed by the durable pairing key
    // so a recreated codespace (new URL, new local id) keeps its look.
    const savedAppearance = serverRailAppearances[device.key];
    const appearance = {
      icon: savedAppearance?.icon || "Github",
      color: savedAppearance?.color || pickStableServerColor(device.key),
    };
    const customizing = customize?.kind === "codespace" && customize.device.key === device.key;
    // Unpairing only leaves the picker empty when the merged local
    // connection is the last remaining server.
    const removable = !device.localServerId || servers.length > 1;
    return (
      <div key={item.id} className="flex w-full min-w-0 flex-col">
        <div className="flex w-full min-w-0 items-center gap-[4px] rounded-[var(--radius-tab)] hover:bg-[var(--accent-bg)]">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            disabled={waking}
            onClick={() => onSelectCodespaceDevice?.(device)}
            className="flex min-w-0 flex-1 items-center gap-[8px] px-[8px] py-[8px] text-left disabled:opacity-70 sm:py-[7px]"
          >
            {waking ? (
              <Loader2 className={`${iconClass} animate-spin`} strokeWidth={1.7} aria-hidden />
            ) : (
              <WorkspaceFolderIcon
                iconName={appearance.icon}
                color={appearance.color}
                className="size-[14px] shrink-0"
                strokeWidth={1.8}
              />
            )}
            {renderHealth(health)}
            <span className="min-w-0 flex-1">
              <span className={titleClass}>{device.label}</span>
              <span className={subtitleClass}>{stateLabel}</span>
            </span>
            <DeviceKindBadge kind="codespace" />
            {renderCheck(selected)}
          </button>
          {variant === "device" ? (
            <div className="flex shrink-0 items-center pr-[4px]">
              <button
                type="button"
                aria-label={`Customize ${device.label}`}
                title="Rename and customize"
                onClick={(event) => {
                  event.stopPropagation();
                  if (customizing) {
                    closeCustomize();
                    return;
                  }
                  commitCustomizeName();
                  setCustomize({ kind: "codespace", device });
                  setNameDraft(device.label);
                }}
                className="flex size-[26px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
              >
                <Pencil className="size-[12px]" strokeWidth={1.7} />
              </button>
              <button
                type="button"
                aria-label={`Remove ${device.label}`}
                title="Remove"
                disabled={waking || !removable}
                onClick={(event) => {
                  event.stopPropagation();
                  if (waking || !removable) {
                    return;
                  }
                  void unpairCodespace(device, device.label);
                }}
                className="flex size-[26px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] disabled:opacity-35"
              >
                <Trash2 className="size-[12px]" strokeWidth={1.7} />
              </button>
            </div>
          ) : null}
        </div>
        {customizing ? (
          <div className="mb-[6px] mr-[8px]">
            <RailIconCustomizePanel
              title={device.label}
              icon={appearance.icon}
              color={appearance.color}
              showNameField
              name={nameDraft}
              nameFieldLabel="Device name"
              allowEmptyName
              onClose={closeCustomize}
              onUpdate={(patch) => {
                if (patch.name !== undefined) {
                  setNameDraft(patch.name);
                }
                if (patch.icon !== undefined || patch.color !== undefined) {
                  updateEntryAppearance(device.key, appearance, patch);
                }
              }}
            />
          </div>
        ) : null}
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
  };

  const renderCloudRow = (item: Extract<PickerItem, { kind: "cloud" }>): ReactNode => {
    const { device } = item;
    const selected = device.id === selectedCloudDeviceId;
    return (
      <button
        key={item.id}
        type="button"
        role="menuitemradio"
        aria-checked={selected}
        onClick={() => {
          onSelectCloudDevice?.(device.id);
          onClose();
        }}
        className={`${rowClass} hover:bg-[var(--accent-bg)]`}
      >
        <Cloud className={iconClass} strokeWidth={1.5} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className={titleClass}>{device.label}</span>
          <span className={subtitleClass}>{device.description}</span>
        </span>
        <DeviceKindBadge kind="cloud" />
        {renderCheck(selected)}
      </button>
    );
  };

  const footerButtonClass =
    "flex w-full shrink-0 items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--accent-bg)]";

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
        measureKey={`${items.map((item) => item.id).join(",")}\0${connectOpen ? 1 : 0}\0${customize ? (customize.kind === "server" ? customize.id : customize.device.key) : ""}\0${selectedCloudDeviceId ?? ""}\0${codespaceWakeStatus?.phase ?? ""}\0${codespaceWakeFailure?.deviceKey ?? ""}`}
        scrollClassName={
          connectOpen
            ? "hide-scrollbar-y max-h-[min(140px,28dvh)] min-h-0 overflow-y-auto overscroll-contain p-[4px]"
            : "hide-scrollbar-y max-h-[min(420px,70dvh)] min-h-0 overflow-y-auto overscroll-contain p-[4px]"
        }
      >
        {items.map((item) =>
          item.kind === "server"
            ? renderServerRow(item)
            : item.kind === "codespace"
              ? renderCodespaceRow(item)
              : renderCloudRow(item)
        )}
        {items.length === 0 ? (
          <p className="px-[8px] py-[10px] text-center font-sans text-[11.5px] text-[var(--text-secondary)]">
            Every device is hidden. Restore entries under Settings → Servers.
          </p>
        ) : null}
      </VerticalFadedScroll>
      {variant === "device" ? (
        <div
          className={`flex min-h-0 flex-col border-t border-[var(--border-card)] p-[4px] ${
            connectOpen ? "flex-1 overflow-hidden" : ""
          }`}
        >
          {offerBrowserMachine &&
          showBrowserAction &&
          !servers.some((server) => isBrowserMachineUrl(server.baseUrl)) ? (
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
              className={footerButtonClass}
            >
              <Globe className="size-[13px] shrink-0" strokeWidth={1.5} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">Use this browser</span>
                <span className="mt-[1px] block truncate font-sans text-[10.5px] text-[var(--text-secondary)]">
                  Runs entirely in this tab - no server needed
                </span>
              </span>
            </button>
          ) : null}
          {showConnectAction ? (
            <button
              type="button"
              aria-expanded={connectOpen}
              onClick={() => setConnectOpen((openConnect) => !openConnect)}
              className={footerButtonClass}
            >
              <Plus className="size-[13px] shrink-0" strokeWidth={1.5} />
              Connect a device
            </button>
          ) : null}
          {connectOpen && showConnectAction ? (
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
          {showSetupCodespace ? (
            <button type="button" onClick={onSetupCodespace} className={footerButtonClass}>
              <Github className="size-[13px] shrink-0" strokeWidth={1.5} />
              Set up a Codespace…
            </button>
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
