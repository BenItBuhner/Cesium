"use client";

import {
  ChevronDown,
  ChevronUp,
  Cloud,
  Github,
  Globe,
  RotateCcw,
  Server,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { isBrowserMachineUrl } from "@cesium/client";
import { useOptionalAgentConversations } from "@/components/chat/AgentConversationsContext";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { DeviceKindBadge } from "@/components/preferences/ServerPickerPopover";
import { SettingsCallout, SettingsRow, SettingsSection } from "@/components/editor/settings-ui";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { useCloudExecutionDevice } from "@/hooks/useCloudExecutionDevice";
import { useGithubCodespaces } from "@/hooks/useGithubCodespaces";
import {
  DEVICE_PICKER_ACTION_IDS,
  DEVICE_PICKER_ACTION_LABELS,
  DEVICE_PICKER_KIND_IDS,
  DEVICE_PICKER_KIND_LABELS,
  createDefaultDevicePickerState,
  devicePickerKindHiddenId,
  devicePickerServerEntryId,
  isDevicePickerEntryHidden,
  isDevicePickerKindHidden,
  moveDevicePickerEntry,
  sortByDevicePickerOrder,
  toggleDevicePickerHidden,
  type DevicePickerState,
} from "@/lib/global-settings";
import { getServerDisplayLabel, getServerRailAppearance } from "@/lib/server-rail-appearance";

type PickerEntry = {
  id: string;
  label: string;
  description?: string;
  icon: ReactNode;
  badge?: ReactNode;
};

const ICON_CLASS = "size-[14px] shrink-0 text-[var(--text-secondary)]";

function ReorderButtons({
  onUp,
  onDown,
  canUp,
  canDown,
  label,
}: {
  onUp: () => void;
  onDown: () => void;
  canUp: boolean;
  canDown: boolean;
  label: string;
}) {
  const buttonClass =
    "flex size-[26px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <div className="flex items-center">
      <button
        type="button"
        aria-label={`Move ${label} up`}
        title="Move up"
        disabled={!canUp}
        onClick={onUp}
        className={buttonClass}
      >
        <ChevronUp className="size-[13px]" strokeWidth={1.7} />
      </button>
      <button
        type="button"
        aria-label={`Move ${label} down`}
        title="Move down"
        disabled={!canDown}
        onClick={onDown}
        className={buttonClass}
      >
        <ChevronDown className="size-[13px]" strokeWidth={1.7} />
      </button>
    </div>
  );
}

/**
 * Settings → Servers → Device picker: show / hide and reorder every entry
 * and footer action of the "Switch device" dropdown. Servers, Codespaces,
 * and cloud devices share one list, mirroring the picker itself.
 */
export function DevicePickerSettingsSection() {
  const { settings, updateSettings } = useGlobalSettings();
  const state = settings.general.devicePicker;
  const { servers } = useServerConnections();
  const codespaces = useGithubCodespaces();
  const backends = useOptionalAgentConversations()?.backends ?? [];
  const { cloudDevices } = useCloudExecutionDevice(backends);
  const serverRailAppearances = settings.general.serverRailAppearances;

  const update = (next: (current: DevicePickerState) => DevicePickerState) => {
    updateSettings((current) => {
      const nextState = next(current.general.devicePicker);
      if (nextState === current.general.devicePicker) {
        return current;
      }
      return {
        ...current,
        general: { ...current.general, devicePicker: nextState },
      };
    });
  };

  const entries = useMemo<PickerEntry[]>(() => {
    const out: PickerEntry[] = [];
    servers.forEach((server, index) => {
      const isBrowser = isBrowserMachineUrl(server.baseUrl);
      out.push({
        id: devicePickerServerEntryId(server.id),
        label: getServerDisplayLabel(
          server,
          getServerRailAppearance(serverRailAppearances, server.id, index)
        ),
        description: isBrowser ? "Runs entirely in this browser tab." : server.baseUrl,
        icon: isBrowser ? (
          <Globe className={ICON_CLASS} strokeWidth={1.5} aria-hidden />
        ) : (
          <Server className={ICON_CLASS} strokeWidth={1.5} aria-hidden />
        ),
        badge: isBrowser ? <DeviceKindBadge kind="browser" /> : undefined,
      });
    });
    for (const device of codespaces.devices) {
      out.push({
        id: device.key,
        label: device.label,
        description: device.repoFullName,
        icon: <Github className={ICON_CLASS} strokeWidth={1.5} aria-hidden />,
        badge: <DeviceKindBadge kind="codespace" />,
      });
    }
    for (const device of cloudDevices) {
      out.push({
        id: device.id,
        label: device.label,
        description: device.description,
        icon: <Cloud className={ICON_CLASS} strokeWidth={1.5} aria-hidden />,
        badge: <DeviceKindBadge kind="cloud" />,
      });
    }
    return sortByDevicePickerOrder(out, state.order, (entry) => entry.id);
  }, [cloudDevices, codespaces.devices, serverRailAppearances, servers, state.order]);

  const displayedIds = entries.map((entry) => entry.id);
  const isDefault = state.order.length === 0 && state.hidden.length === 0;

  return (
    <>
      <SettingsSection
        title="Device picker"
        action={
          <button
            type="button"
            disabled={isDefault}
            onClick={() => update(() => createDefaultDevicePickerState())}
            className="inline-flex items-center gap-[6px] rounded-[var(--radius-pill)] border border-[var(--border-card)] px-[10px] py-[5px] font-sans text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw className="size-[12px]" strokeWidth={1.7} aria-hidden />
            Reset
          </button>
        }
      >
        <SettingsCallout className="border-b border-[var(--border-subtle)] px-[16px] py-[12px]">
          Choose what appears in the Switch device dropdown and in what order. Servers,
          Codespaces, and cloud devices share one list; anything you turn off disappears
          from the picker, and the active device always stays visible.
        </SettingsCallout>
        {entries.length === 0 ? (
          <SettingsRow
            searchId="device-picker-entries"
            title="No devices yet"
            description="Connect a server or pair a Codespace and it will show up here."
            trailing={<span />}
            border={false}
          />
        ) : null}
        {entries.map((entry, index) => {
          const hidden = isDevicePickerEntryHidden(state, entry.id);
          return (
            <SettingsRow
              key={entry.id}
              searchId={`device-picker-entry-${entry.id}`}
              title={entry.label}
              description={entry.description}
              leading={entry.icon}
              titleExtra={entry.badge}
              trailing={
                <div className="flex items-center gap-[8px]">
                  <ReorderButtons
                    label={entry.label}
                    canUp={index > 0}
                    canDown={index < entries.length - 1}
                    onUp={() =>
                      update((current) =>
                        moveDevicePickerEntry(current, displayedIds, entry.id, -1)
                      )
                    }
                    onDown={() =>
                      update((current) =>
                        moveDevicePickerEntry(current, displayedIds, entry.id, 1)
                      )
                    }
                  />
                  <ToggleSwitch
                    checked={!hidden}
                    onChange={(visible) =>
                      update((current) => toggleDevicePickerHidden(current, entry.id, !visible))
                    }
                    size="md"
                  />
                </div>
              }
            />
          );
        })}
      </SettingsSection>
      <SettingsSection title="Device types">
        {DEVICE_PICKER_KIND_IDS.map((kind) => {
          const info = DEVICE_PICKER_KIND_LABELS[kind];
          const hidden = isDevicePickerKindHidden(state, kind);
          const description =
            kind === "codespace" && !codespaces.available
              ? `${info.description} Shown only when a GitHub account is connected.`
              : info.description;
          return (
            <SettingsRow
              key={kind}
              searchId={`device-picker-kind-${kind}`}
              title={info.label}
              description={description}
              leading={
                kind === "codespace" ? (
                  <Github className={ICON_CLASS} strokeWidth={1.5} aria-hidden />
                ) : (
                  <Cloud className={ICON_CLASS} strokeWidth={1.5} aria-hidden />
                )
              }
              trailing={
                <ToggleSwitch
                  checked={!hidden}
                  onChange={(visible) =>
                    update((current) =>
                      toggleDevicePickerHidden(current, devicePickerKindHiddenId(kind), !visible)
                    )
                  }
                  size="md"
                />
              }
            />
          );
        })}
      </SettingsSection>
      <SettingsSection title="Picker actions">
        {DEVICE_PICKER_ACTION_IDS.map((actionId) => {
          const info = DEVICE_PICKER_ACTION_LABELS[actionId];
          const hidden = isDevicePickerEntryHidden(state, actionId);
          return (
            <SettingsRow
              key={actionId}
              searchId={`device-picker-${actionId}`}
              title={info.label}
              description={info.description}
              trailing={
                <ToggleSwitch
                  checked={!hidden}
                  onChange={(visible) =>
                    update((current) => toggleDevicePickerHidden(current, actionId, !visible))
                  }
                  size="md"
                />
              }
            />
          );
        })}
      </SettingsSection>
    </>
  );
}
