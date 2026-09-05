"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, GripVertical, Plus, RefreshCw } from "lucide-react";
import { HardwareAwareTextInput } from "@/components/input/HardwareAwareTextField";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  HARNESS_BACKEND_IDS,
  HARNESS_LABELS,
} from "@/components/editor/agent-harness-settings";
import {
  SettingsEmptyState,
  SettingsNestedBreadcrumbs,
  SettingsBreadcrumbs,
  SettingsRow,
  SettingsSection,
  useSettingsShellChrome,
} from "@/components/editor/settings-ui";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { AgentBackendIcon } from "@/components/chat/AgentBackendIcon";
import type { AgentBackendId } from "@/lib/agent-types";
import type { ModelToggleState } from "@/lib/global-settings";
import { recordPerfSample } from "@/lib/dev-perf";
import {
  appendEnabledModelIds,
  applyEnabledCompactOrder,
  compactModelRowsForBackend,
  moveItem,
  type CompactModelToggleRow,
} from "@/lib/settings-model-order";
import { panelSearchInputClass } from "./shared";

function backendsWithEnabledModels(
  byBackend: Record<string, ModelToggleState[]>
): Set<string> {
  const next = new Set<string>();
  for (const [backendId, models] of Object.entries(byBackend)) {
    if (models.some((model) => model.on)) {
      next.add(backendId);
    }
  }
  return next;
}

export function ModelsSettingsPanel() {
  const {
    settings,
    updateSettings,
    refreshModels,
    modelsRefreshing,
    saveModelToggleUpdates,
    saveModelOrder,
  } = useGlobalSettings();
  const chrome = useSettingsShellChrome();
  const { workspaceSession, updateWorkspaceSession } = useWorkspace();
  const [modelQuery, setModelQuery] = useState("");
  const [addingModels, setAddingModels] = useState(false);
  const [expandedBackends, setExpandedBackends] = useState<Set<string>>(() =>
    backendsWithEnabledModels(settings.models.byBackend ?? {})
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  useEffect(() => {
    const focus = workspaceSession.settingsView.panelSearchFocus;
    if (focus?.kind !== "models") {
      return;
    }
    setModelQuery(focus.query);
    if (focus.query.trim()) {
      setAddingModels(true);
    }
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
    for (const backendId of HARNESS_BACKEND_IDS) {
      const rows = raw[backendId];
      if (rows && rows.length > 0) {
        activeOnly[backendId] = rows;
      }
    }
    return activeOnly;
  }, [settings.models.byBackend]);

  useEffect(() => {
    const ids = Object.keys(byBackend);
    if (ids.length === 0) {
      return;
    }
    setExpandedBackends((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of ids) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [byBackend]);

  const compactByBackend = useMemo(() => {
    const result: Record<string, CompactModelToggleRow[]> = {};
    for (const [backendId, models] of Object.entries(byBackend)) {
      result[backendId] = compactModelRowsForBackend(models);
    }
    return result;
  }, [byBackend]);

  const persistBackendOrder = useCallback(
    (backendId: string, rows: ModelToggleState[]) => {
      void saveModelOrder(
        backendId,
        rows.map((row) => row.id)
      );
    },
    [saveModelOrder]
  );

  const setModelsForBackend = useCallback(
    (backendId: string, updater: (current: ModelToggleState[]) => ModelToggleState[]) => {
      const nextRows = updater(settings.models.byBackend[backendId] ?? []);
      updateSettings((current) => ({
        ...current,
        models: {
          ...current.models,
          byBackend: {
            ...current.models.byBackend,
            [backendId]: nextRows,
          },
        },
      }));
      return nextRows;
    },
    [settings.models.byBackend, updateSettings]
  );

  const toggleModelGroup = useCallback(
    (backendId: string, row: CompactModelToggleRow, on: boolean) => {
      const startedAt = performance.now();
      const nextRows = setModelsForBackend(backendId, (rows) => {
        if (on) {
          return appendEnabledModelIds(rows, row.modelIds);
        }
        const modelIds = new Set(row.modelIds);
        return rows.map((model) => (modelIds.has(model.id) ? { ...model, on } : model));
      });
      recordPerfSample("settings.models.toggle_visible", startedAt, {
        backendId,
        modelId: row.id,
        on,
      });
      void saveModelToggleUpdates(
        row.modelIds.map((modelId) => ({ backendId, modelId, on }))
      );
      persistBackendOrder(backendId, nextRows);
    },
    [persistBackendOrder, setModelsForBackend, saveModelToggleUpdates]
  );

  const reorderEnabledGroup = useCallback(
    (backendId: string, fromIndex: number, toIndex: number) => {
      const compact = compactByBackend[backendId] ?? [];
      const enabled = compact.filter((row) => row.on);
      if (
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= enabled.length ||
        toIndex >= enabled.length ||
        fromIndex === toIndex
      ) {
        return;
      }
      const nextEnabled = moveItem(enabled, fromIndex, toIndex);
      const nextRows = setModelsForBackend(backendId, (rows) =>
        applyEnabledCompactOrder(rows, nextEnabled)
      );
      persistBackendOrder(backendId, nextRows);
    },
    [compactByBackend, persistBackendOrder, setModelsForBackend]
  );

  const selectAllForBackend = useCallback(
    (backendId: string) => {
      const startedAt = performance.now();
      const currentModels = byBackend[backendId] ?? [];
      const updates = currentModels
        .filter((m) => !m.on)
        .map((m) => ({ backendId, modelId: m.id, on: true }));
      const nextRows = setModelsForBackend(backendId, (rows) =>
        rows.map((r) => ({ ...r, on: true }))
      );
      if (updates.length > 0) {
        void saveModelToggleUpdates(updates);
      }
      persistBackendOrder(backendId, nextRows);
      recordPerfSample("settings.models.select_all_visible", startedAt, {
        backendId,
        updates: updates.length,
      });
    },
    [byBackend, persistBackendOrder, setModelsForBackend, saveModelToggleUpdates]
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
    return HARNESS_BACKEND_IDS.filter((id) => present.has(id));
  }, [filteredByBackend]);

  const allBackendIds = useMemo(() => {
    const present = new Set(Object.keys(compactByBackend));
    return HARNESS_BACKEND_IDS.filter((id) => present.has(id));
  }, [compactByBackend]);

  const openAddModels = useCallback((backendId?: string) => {
    setAddingModels(true);
    setModelQuery("");
    if (backendId) {
      setExpandedBackends((prev) => {
        const next = new Set(prev);
        next.add(backendId);
        return next;
      });
    }
  }, []);

  const searching = modelQuery.trim().length > 0;

  return (
    <>
      {addingModels ? (
        <SettingsBreadcrumbs
          segments={[
            {
              label: "Agents",
              onClick: chrome?.navigate ? () => chrome.navigate?.("agents") : undefined,
            },
            {
              label: "Models",
              onClick: () => {
                setAddingModels(false);
                setModelQuery("");
              },
            },
            { label: "Add models" },
          ]}
        />
      ) : (
        <SettingsNestedBreadcrumbs parentNav="agents" parentLabel="Agents" label="Models" />
      )}
      <div className="mb-[16px] flex items-center gap-[8px]">
        <div className="relative min-w-0 flex-1">
          <HardwareAwareTextInput
            type="search"
            value={modelQuery}
            onChange={setModelQuery}
            placeholder={addingModels ? "Search models" : "Search enabled models"}
            className={panelSearchInputClass}
            ariaLabel={addingModels ? "Search models" : "Search enabled models"}
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
      {addingModels ? (
        <>
          {sortedBackendIds.length === 0 ? (
            <SettingsEmptyState>
              {modelQuery
                ? "No models match your search"
                : "No models loaded yet. Click refresh to load from servers."}
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
      ) : (
        <>
          {allBackendIds.length === 0 ? (
            <SettingsEmptyState>
              No models loaded yet. Click refresh to load from servers.
            </SettingsEmptyState>
          ) : null}
          {allBackendIds.map((backendId) => {
            const compact = compactByBackend[backendId] ?? [];
            const enabled = compact.filter((row) => row.on);
            const visibleEnabled = searching
              ? enabled.filter((row) => row.name.toLowerCase().includes(modelQuery.trim().toLowerCase()))
              : enabled;
            const collapsed = !expandedBackends.has(backendId);
            const canDrag = !searching && enabled.length > 1;
            return (
              <SettingsSection key={backendId}>
                <div
                  data-settings-search-id="reorder-models"
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
                      {enabled.length} enabled
                    </span>
                  </div>
                  <ChevronRight
                    className={`size-[14px] shrink-0 text-[var(--text-secondary)] transition-transform ${collapsed ? "" : "rotate-90"}`}
                    strokeWidth={1.5}
                  />
                </div>
                {collapsed ? null : (
                  <div className="border-t border-[var(--border-subtle)]">
                    {visibleEnabled.length === 0 ? (
                      <SettingsEmptyState>
                        {searching
                          ? "No enabled models match your search"
                          : "No models enabled for this harness."}
                      </SettingsEmptyState>
                    ) : (
                      visibleEnabled.map((row) => {
                        const sourceIndex = enabled.findIndex((entry) => entry.id === row.id);
                        return (
                          <div
                            key={`${backendId}::${row.id}`}
                            draggable={canDrag}
                            onDragStart={(event) => {
                              if (!canDrag) {
                                event.preventDefault();
                                return;
                              }
                              event.dataTransfer.setData(
                                "text/plain",
                                `${backendId}::${row.id}`
                              );
                              event.dataTransfer.effectAllowed = "move";
                              setDraggingId(`${backendId}::${row.id}`);
                            }}
                            onDragEnd={() => {
                              setDraggingId(null);
                              setDropTargetId(null);
                            }}
                            onDragOver={(event) => {
                              if (!canDrag) {
                                return;
                              }
                              event.preventDefault();
                              event.dataTransfer.dropEffect = "move";
                              setDropTargetId(`${backendId}::${row.id}`);
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              const payload = event.dataTransfer.getData("text/plain");
                              const prefix = `${backendId}::`;
                              if (!payload.startsWith(prefix)) {
                                setDraggingId(null);
                                setDropTargetId(null);
                                return;
                              }
                              const fromId = payload.slice(prefix.length);
                              const fromIndex = enabled.findIndex((entry) => entry.id === fromId);
                              reorderEnabledGroup(backendId, fromIndex, sourceIndex);
                              setDraggingId(null);
                              setDropTargetId(null);
                            }}
                            className={`flex min-h-[48px] items-center gap-[10px] border-b border-[var(--border-subtle)] px-[16px] py-[10px] ${
                              dropTargetId === `${backendId}::${row.id}`
                                ? "bg-[var(--accent-bg)]"
                                : ""
                            } ${
                              draggingId === `${backendId}::${row.id}` ? "opacity-50" : ""
                            } ${canDrag ? "cursor-grab active:cursor-grabbing" : ""}`}
                          >
                            <span
                              className={`flex size-[18px] shrink-0 items-center justify-center ${
                                canDrag
                                  ? "text-[var(--text-secondary)]"
                                  : "text-[var(--text-disabled)]"
                              }`}
                              aria-hidden
                            >
                              <GripVertical className="size-[14px]" strokeWidth={1.75} />
                            </span>
                            <span className="min-w-0 flex-1 truncate font-sans text-[13px] font-medium text-[var(--text-primary)]">
                              {row.name}
                            </span>
                            <ToggleSwitch
                              checked
                              onChange={(v) => toggleModelGroup(backendId, row, v)}
                              size="sm"
                              variant="green"
                            />
                          </div>
                        );
                      })
                    )}
                    <button
                      type="button"
                      data-settings-search-id="add-models"
                      onClick={() => openAddModels(backendId)}
                      className="flex min-h-[48px] w-full items-center gap-[10px] px-[16px] py-[10px] text-left transition-colors hover:bg-[var(--accent-bg)]"
                    >
                      <Plus
                        className="size-[14px] shrink-0 text-[var(--text-secondary)]"
                        strokeWidth={1.75}
                        aria-hidden
                      />
                      <span className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
                        Add models
                      </span>
                    </button>
                  </div>
                )}
              </SettingsSection>
            );
          })}
        </>
      )}
    </>
  );
}
