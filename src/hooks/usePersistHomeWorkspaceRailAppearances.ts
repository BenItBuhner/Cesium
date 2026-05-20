import { useEffect } from "react";
import type { GlobalSettingsState } from "@/lib/global-settings";
import { collectHomeWorkspaceAppearancesToPersist } from "@/lib/workspace-rail-appearance";

export function usePersistHomeWorkspaceRailAppearances(
  appearances: GlobalSettingsState["general"]["workspaceRailAppearances"],
  entries: ReadonlyArray<{ workspaceKey: string; isHome: boolean }>,
  updateSettings: (updater: (current: GlobalSettingsState) => GlobalSettingsState) => void
): void {
  useEffect(() => {
    const patches = collectHomeWorkspaceAppearancesToPersist(appearances, entries);
    if (Object.keys(patches).length === 0) {
      return;
    }
    updateSettings((current) => {
      const stillNeeded = collectHomeWorkspaceAppearancesToPersist(
        current.general.workspaceRailAppearances,
        entries
      );
      if (Object.keys(stillNeeded).length === 0) {
        return current;
      }
      return {
        ...current,
        general: {
          ...current.general,
          workspaceRailAppearances: {
            ...current.general.workspaceRailAppearances,
            ...stillNeeded,
          },
        },
      };
    });
  }, [appearances, entries, updateSettings]);
}
