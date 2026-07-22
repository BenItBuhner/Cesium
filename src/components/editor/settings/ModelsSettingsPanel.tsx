"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { HardwareAwareTextInput } from "@/components/input/HardwareAwareTextField";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  HARNESS_LABELS,
  HARNESS_ORDER,
} from "@/components/editor/agent-harness-settings";
import {
  PageIntro,
  SettingsEmptyState,
  SettingsRow,
  SettingsSection,
} from "@/components/editor/settings-ui";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { AgentBackendIcon } from "@/components/chat/AgentBackendIcon";
import type { AgentBackendId } from "@/lib/agent-types";
import type { ModelToggleState } from "@/lib/global-settings";
import { recordPerfSample } from "@/lib/dev-perf";
import {
  compactModelName,
  stripCursorSdkModelParams,
} from "@/lib/settings-model-compaction";
import { panelSearchInputClass } from "./shared";

type CompactModelToggleRow = {
  id: string;
  name: string;
  on: boolean;
  modelIds: string[];
};

function compactModelRowsForBackend(models: ModelToggleState[]): CompactModelToggleRow[] {
  const groups = new Map<string, CompactModelToggleRow>();
  for (const model of models) {
    const baseId = stripCursorSdkModelParams(model.id);
    const baseName = compactModelName(model.name, baseId);
    const key = baseName.toLowerCase();
    const existing = groups.get(key);
    if (existing) {
      existing.on = existing.on || model.on;
      existing.modelIds.push(model.id);
      continue;
    }
    groups.set(key, {
      id: key,
      name: baseName,
      on: model.on,
      modelIds: [model.id],
    });
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function ModelsSettingsPanel() {
  const {
    settings,
    updateSettings,
    refreshModels,
    modelsRefreshing,
    saveModelToggleUpdates,
  } = useGlobalSettings();
  const { workspaceSession, updateWorkspaceSession } = useWorkspace();
  const [modelQuery, setModelQuery] = useState("");
  const [expandedBackends, setExpandedBackends] = useState<Set<string>>(new Set());

  useEffect(() => {
    const focus = workspaceSession.settingsView.panelSearchFocus;
    if (focus?.kind !== "models") {
      return;
    }
    setModelQuery(focus.query);
    if (focus.backendId) {
      setExpandedBackends((prev) => {
        const next = new Set(prev);
        next.add(focus.backendId!);
        return next;
      });
    }
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: {
        ...current.settingsView,
        panelSearchFocus: null,
      },
    }));
  }, [updateWorkspaceSession, workspaceSession.settingsView.panelSearchFocus]);

  const byBackend = useMemo(() => {
    const raw = settings.models.byBackend ?? {};
    const activeOnly: Record<string, ModelToggleState[]> = {};
    for (const backendId of HARNESS_ORDER) {
      const rows = raw[backendId];
      if (rows && rows.length > 0) {
        activeOnly[backendId] = rows;
      }
    }
    return activeOnly;
  }, [settings.models.byBackend]);

  const compactByBackend = useMemo(() => {
    const result: Record<string, CompactModelToggleRow[]> = {};
    for (const [backendId, models] of Object.entries(byBackend)) {
      result[backendId] = compactModelRowsForBackend(models);
    }
    return result;
  }, [byBackend]);

  const setModelsForBackend = useCallback(
    (backendId: string, updater: (current: ModelToggleState[]) => ModelToggleState[]) => {
      updateSettings((current) => ({
        ...current,
        models: {
          ...current.models,
          byBackend: {
            ...current.models.byBackend,
            [backendId]: updater(current.models.byBackend[backendId] ?? []),
          },
        },
      }));
    },
    [updateSettings]
  );

  const toggleModelGroup = useCallback(
    (backendId: string, row: CompactModelToggleRow, on: boolean) => {
      const startedAt = performance.now();
      const modelIds = new Set(row.modelIds);
      setModelsForBackend(backendId, (rows) =>
        rows.map((model) => (modelIds.has(model.id) ? { ...model, on } : model))
      );
      recordPerfSample("settings.models.toggle_visible", startedAt, {
        backendId,
        modelId: row.id,
        on,
      });
      void saveModelToggleUpdates(
        row.modelIds.map((modelId) => ({ backendId, modelId, on }))
      );
    },
    [setModelsForBackend, saveModelToggleUpdates]
  );

  const selectAllForBackend = useCallback(
    (backendId: string) => {
      const startedAt = performance.now();
      const currentModels = byBackend[backendId] ?? [];
      const updates = currentModels
        .filter((m) => !m.on)
        .map((m) => ({ backendId, modelId: m.id, on: true }));
      setModelsForBackend(backendId, (rows) => rows.map((r) => ({ ...r, on: true })));
      if (updates.length > 0) {
        void saveModelToggleUpdates(updates);
      }
      recordPerfSample("settings.models.select_all_visible", startedAt, {
        backendId,
        updates: updates.length,
      });
    },
    [byBackend, setModelsForBackend, saveModelToggleUpdates]
  );

  const deselectAllForBackend = useCallback(
    (backendId: string) => {
      const startedAt = performance.now();
      const currentModels = byBackend[backendId] ?? [];
      const updates = currentModels
        .filter((m) => m.on)
        .map((m) => ({ backendId, modelId: m.id, on: false }));
      setModelsForBackend(backendId, (rows) => rows.map((r) => ({ ...r, on: false })));
      if (updates.length > 0) {
        void saveModelToggleUpdates(updates);
      }
      recordPerfSample("settings.models.deselect_all_visible", startedAt, {
        backendId,
        updates: updates.length,
      });
    },
    [byBackend, setModelsForBackend, saveModelToggleUpdates]
  );

  const toggleCollapse = useCallback((backendId: string) => {
    const startedAt = performance.now();
    setExpandedBackends((prev) => {
      const next = new Set(prev);
      if (next.has(backendId)) {
        next.delete(backendId);
      } else {
        next.add(backendId);
      }
      recordPerfSample("settings.models.backend_toggle_visible", startedAt, {
        backendId,
        collapsed: !next.has(backendId),
      });
      return next;
    });
  }, []);

  const filteredByBackend = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) {
      return compactByBackend;
    }
    const result: Record<string, CompactModelToggleRow[]> = {};
    for (const [backendId, models] of Object.entries(compactByBackend)) {
      const filtered = models.filter((m) => m.name.toLowerCase().includes(q));
      if (filtered.length > 0) {
        result[backendId] = filtered;
      }
    }
    return result;
  }, [modelQuery, compactByBackend]);

  const sortedBackendIds = useMemo(() => {
    const present = new Set(Object.keys(filteredByBackend));
    return HARNESS_ORDER.filter((id) => present.has(id));
  }, [filteredByBackend]);

  return (
    <>
      <PageIntro title="Models" />
      <div className="mb-[16px] flex items-center gap-[8px]">
        <div className="relative min-w-0 flex-1">
          <HardwareAwareTextInput
            type="search"
            value={modelQuery}
            onChange={setModelQuery}
            placeholder="Search models"
            className={panelSearchInputClass}
            ariaLabel="Search models"
          />
        </div>
        <button
          type="button"
          onClick={() => void refreshModels()}
          disabled={modelsRefreshing}
          className="flex size-[36px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] disabled:opacity-50"
          aria-label="Refresh models"
        >
          <RefreshCw
            className={`size-[16px] ${modelsRefreshing ? "animate-spin" : ""}`}
            strokeWidth={1.5}
          />
        </button>
      </div>
      {sortedBackendIds.length === 0 ? (
        <SettingsEmptyState>
          {modelQuery ? "No models match your search" : "No models loaded yet. Click refresh to load from servers."}
        </SettingsEmptyState>
      ) : null}
      {sortedBackendIds.map((backendId) => {
        const models = filteredByBackend[backendId] ?? [];
        const allOn = models.length > 0 && models.every((m) => m.on);
        const onCountForBackend = models.filter((m) => m.on).length;
        const collapsed = !expandedBackends.has(backendId);
        return (
          <SettingsSection key={backendId}>
            <div
              className="flex min-h-[48px] cursor-pointer select-none items-center justify-between gap-[12px] px-[16px] py-[10px]"
              onClick={() => toggleCollapse(backendId)}
            >
              <div className="flex min-w-0 items-center gap-[10px]">
                <AgentBackendIcon
                  backendId={backendId as AgentBackendId}
                  className="size-[18px] shrink-0"
                  strokeWidth={1.5}
                />
                <span className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
                  {HARNESS_LABELS[backendId as AgentBackendId] ?? backendId}
                </span>
                <span className="inline-flex items-center rounded-[var(--radius-tab)] bg-[var(--bg-main)] px-[6px] py-[1px] font-mono text-[11px] text-[var(--text-secondary)]">
                  {onCountForBackend}/{models.length}
                </span>
              </div>
              <div className="flex items-center gap-[8px]">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (allOn) {
                      deselectAllForBackend(backendId);
                    } else {
                      selectAllForBackend(backendId);
                    }
                  }}
                  className="inline-flex shrink-0 items-center gap-[4px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-transparent px-[8px] py-[3px] font-sans text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
                >
                  {allOn ? "Deselect all" : "Select all"}
                </button>
                <ChevronRight
                  className={`size-[14px] shrink-0 text-[var(--text-secondary)] transition-transform ${collapsed ? "" : "rotate-90"}`}
                  strokeWidth={1.5}
                />
              </div>
            </div>
            {collapsed ? null : (
              <div className="max-h-[min(480px,50vh)] overflow-y-auto overscroll-contain border-t border-[var(--border-subtle)]">
                {models.map((m, i) => (
                  <SettingsRow
                    key={`${backendId}::${m.id}`}
                    title={m.name}
                    trailing={
                      <ToggleSwitch
                        checked={m.on}
                        onChange={(v) => toggleModelGroup(backendId, m, v)}
                        size="sm"
                        variant="green"
                      />
                    }
                    border={i < models.length - 1}
                  />
                ))}
              </div>
            )}
          </SettingsSection>
        );
      })}
    </>
  );
}
