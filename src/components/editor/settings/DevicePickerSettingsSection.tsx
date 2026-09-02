"use client";

import { ChevronDown, ChevronUp, Cloud, Github, Globe, RotateCcw, Server } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { isBrowserMachineUrl } from "@cesium/client";
import { useOptionalAgentConversations } from "@/components/chat/AgentConversationsContext";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { SettingsCallout, SettingsRow, SettingsSection } from "@/components/editor/settings-ui";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { useCloudExecutionDevice } from "@/hooks/useCloudExecutionDevice";
import { useGithubCodespaces } from "@/hooks/useGithubCodespaces";
import {
  DEVICE_PICKER_ACTION_IDS,
  DEVICE_PICKER_ACTION_LABELS,
  DEVICE_PICKER_SECTION_LABELS,
  createDefaultDevicePickerState,
  devicePickerCodespaceEntryId,
  devicePickerSectionHiddenId,
  devicePickerServerEntryId,
  isDevicePickerEntryHidden,
  isDevicePickerSectionHidden,
  moveDevicePickerEntry,
  moveDevicePickerSection,
  sortByDevicePickerOrder,
  toggleDevicePickerHidden,
  type DevicePickerSectionId,
  type DevicePickerState,
} from "@/lib/global-settings";
import { getServerDisplayLabel, getServerRailAppearance } from "@/lib/server-rail-appearance";

type PickerEntry = {
  id: string;
  label: string;
  description?: string;
  icon: ReactNode;
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

function EntryRows({
  entries,
  state,
  update,
  searchPrefix,
}: {
  entries: PickerEntry[];
  state: DevicePickerState;
  update: (next: (current: DevicePickerState) => DevicePickerState) => void;
  searchPrefix: string;
}) {
  const displayedIds = entries.map((entry) => entry.id);
  return (
    <>
      {entries.map((entry, index) => {
        const hidden = isDevicePickerEntryHidden(state, entry.id);
        return (
          <SettingsRow
            key={entry.id}
            searchId={`${searchPrefix}-${entry.id}`}
            title={entry.label}
            description={entry.description}
            leading={entry.icon}
            trailing={
              <div className="flex items-center gap-[8px]">
                <ReorderButtons
                  label={entry.label}
                  canUp={index > 0}
                  canDown={index < entries.length - 1}
                  onUp={() =>
                    update((current) => moveDevicePickerEntry(current, displayedIds, entry.id, -1))
                  }
                  onDown={() =>
                    update((current) => moveDevicePickerEntry(current, displayedIds, entry.id, 1))
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
    </>
  );
}

/**
 * Settings → Servers → Device picker: show / hide and reorder every section,
 * entry, and footer action of the "Switch device" dropdown.
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

  const serverEntries = useMemo<PickerEntry[]>(
    () =>
      sortByDevicePickerOrder(
        servers.map((server, index) => ({
          id: devicePickerServerEntryId(server.id),
          label: getServerDisplayLabel(
            server,
            getServerRailAppearance(serverRailAppearances, server.id, index)
          ),
          description: isBrowserMachineUrl(server.baseUrl) ? undefined : server.baseUrl,
          icon: isBrowserMachineUrl(server.baseUrl) ? (
            <Globe className={ICON_CLASS} strokeWidth={1.5} aria-hidden />
          ) : (
            <Server className={ICON_CLASS} strokeWidth={1.5} aria-hidden />
          ),
        })),
        state.order,
        (entry) => entry.id
      ),
    [serverRailAppearances, servers, state.order]
  );

  const codespaceEntries = useMemo<PickerEntry[]>(
    () =>
      sortByDevicePickerOrder(
        codespaces.devices.map((device) => ({
          id: devicePickerCodespaceEntryId(device.key),
          label: device.label,
          description: device.repoFullName,
          icon: <Github className={ICON_CLASS} strokeWidth={1.5} aria-hidden />,
        })),
        state.order,
        (entry) => entry.id
      ),
    [codespaces.devices, state.order]
  );

  const cloudEntries = useMemo<PickerEntry[]>(
    () =>
      sortByDevicePickerOrder(
        cloudDevices.map((device) => ({
          id: device.id,
          label: device.label,
          description: device.description,
          icon: <Cloud className={ICON_CLASS} strokeWidth={1.5} aria-hidden />,
        })),
        state.order,
        (entry) => entry.id
      ),
    [cloudDevices, state.order]
  );

  const entriesBySection: Record<DevicePickerSectionId, PickerEntry[]> = {
    servers: serverEntries,
    codespaces: codespaceEntries,
    cloud: cloudEntries,
  };
  const sectionDescriptions: Record<DevicePickerSectionId, string> = {
    servers: "Saved engines you have connected to from this client.",
    codespaces: codespaces.available
      ? "Codespaces paired to your GitHub account, plus the setup shortcut."
      : "Shown only when a GitHub account is connected.",
    cloud: "Vendor-hosted execution targets contributed by cloud-capable agents.",
  };

  const isDefault =
    state.order.length === 0 &&
    state.hidden.length === 0 &&
    state.sectionOrder.join(",") === createDefaultDevicePickerState().sectionOrder.join(",");

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
          Choose what appears in the Switch device dropdown and in what order. Sections and
          entries you turn off disappear from the picker; the active device always stays
          visible.
        </SettingsCallout>
        {state.sectionOrder.map((section, index) => {
          const hidden = isDevicePickerSectionHidden(state, section);
          return (
            <SettingsRow
              key={section}
              searchId={`device-picker-section-${section}`}
              title={DEVICE_PICKER_SECTION_LABELS[section]}
              description={sectionDescriptions[section]}
              trailing={
                <div className="flex items-center gap-[8px]">
                  <ReorderButtons
                    label={`${DEVICE_PICKER_SECTION_LABELS[section]} section`}
                    canUp={index > 0}
                    canDown={index < state.sectionOrder.length - 1}
                    onUp={() => update((current) => moveDevicePickerSection(current, section, -1))}
                    onDown={() => update((current) => moveDevicePickerSection(current, section, 1))}
                  />
                  <ToggleSwitch
                    checked={!hidden}
                    onChange={(visible) =>
                      update((current) =>
                        toggleDevicePickerHidden(
                          current,
                          devicePickerSectionHiddenId(section),
                          !visible
                        )
                      )
                    }
                    size="md"
                  />
                </div>
              }
            />
          );
        })}
      </SettingsSection>
      {state.sectionOrder.map((section) => {
        const entries = entriesBySection[section];
        if (entries.length === 0) {
          return null;
        }
        return (
          <SettingsSection
            key={`entries-${section}`}
            title={`${DEVICE_PICKER_SECTION_LABELS[section]} entries`}
          >
            <EntryRows
              entries={entries}
              state={state}
              update={update}
              searchPrefix={`device-picker-${section}`}
            />
          </SettingsSection>
        );
      })}
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
