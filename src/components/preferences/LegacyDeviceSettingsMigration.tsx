"use client";

import { useEffect, useRef } from "react";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import {
  clearLegacyPinnedAgentConversationIds,
  normalizePinnedAgentConversationIds,
  readLegacyPinnedAgentConversationIds,
} from "@/lib/agent-rail-pins";
import {
  clearLegacyCollapsedRailState,
  readLegacyCollapsedRailState,
} from "@/lib/agent-rail-collapse";
import {
  clearLegacyLastWorkspaceByServer,
  readLegacyLastWorkspaceByServer,
} from "@/lib/per-server-workspace-memory";
import type { GlobalSettingsState } from "@/lib/global-settings";

/**
 * Fold the rail / workspace memory this device kept in localStorage before
 * those preferences became account settings, exactly once and only after the
 * account's real settings are known:
 *
 * - account slice empty + device has values -> adopt the device's values;
 * - account slice populated -> the account wins, the device copy is dropped.
 *
 * Either way the legacy keys are removed afterwards, so nothing on this
 * device can shadow the account again. Applied as a migration, so it lands in
 * the account only when nothing else changed it meanwhile. Renders nothing.
 */
export function LegacyDeviceSettingsMigration() {
  const { hydrated, migrateSettings } = useGlobalSettings();
  const migratedRef = useRef(false);

  useEffect(() => {
    if (!hydrated || migratedRef.current || typeof window === "undefined") {
      return;
    }
    migratedRef.current = true;

    const legacyPins = readLegacyPinnedAgentConversationIds();
    const legacyCollapsed = readLegacyCollapsedRailState();
    const legacyLastWorkspace = readLegacyLastWorkspaceByServer();

    migrateSettings((current) => {
      let general: GlobalSettingsState["general"] = current.general;
      if (
        legacyPins &&
        legacyPins.length > 0 &&
        general.pinnedAgentConversationIds.length === 0
      ) {
        general = {
          ...general,
          pinnedAgentConversationIds: normalizePinnedAgentConversationIds(legacyPins),
        };
      }
      if (
        legacyCollapsed.workspaceKeys &&
        legacyCollapsed.workspaceKeys.length > 0 &&
        general.collapsedRailWorkspaceKeys.length === 0
      ) {
        general = { ...general, collapsedRailWorkspaceKeys: legacyCollapsed.workspaceKeys };
      }
      if (
        legacyCollapsed.folderIds &&
        legacyCollapsed.folderIds.length > 0 &&
        general.collapsedRailFolderIds.length === 0
      ) {
        general = { ...general, collapsedRailFolderIds: legacyCollapsed.folderIds };
      }
      if (
        legacyLastWorkspace &&
        Object.keys(legacyLastWorkspace).length > 0 &&
        Object.keys(general.lastWorkspaceByServer).length === 0
      ) {
        general = { ...general, lastWorkspaceByServer: legacyLastWorkspace };
      }
      return general === current.general ? current : { ...current, general };
    });

    clearLegacyPinnedAgentConversationIds();
    clearLegacyCollapsedRailState();
    clearLegacyLastWorkspaceByServer();
  }, [hydrated, migrateSettings]);

  return null;
}
