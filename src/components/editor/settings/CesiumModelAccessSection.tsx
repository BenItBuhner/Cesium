"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import {
  SettingsFieldLabel,
  SettingsSubsectionHeading,
  rowButtonClass,
  tagClass,
} from "@/components/editor/settings-ui";
import type { CesiumModelCatalogEntry } from "@/lib/server-api";

/** Mirrors the server-side cap in cesium-agent-settings.ts. */
export const CESIUM_MODEL_DESCRIPTION_MAX_LENGTH = 250;

export type CesiumModelAccessEntries = Record<
  string,
  { enabled: boolean; description?: string }
>;

export type CesiumModelAccessEntryPatch = Record<
  string,
  { enabled?: boolean; description?: string | null } | null
>;

/** Tool-capable models are the only ones the harness can drive. */
export function selectAccessControlledModels(
  catalog: CesiumModelCatalogEntry[]
): CesiumModelCatalogEntry[] {
  return catalog.filter((entry) => entry.supportsTools);
}

/** Terse rollup used for the collapsed section summary (pure — unit tested). */
export function summarizeCesiumModelAccess(
  catalog: CesiumModelCatalogEntry[],
  entries: CesiumModelAccessEntries
): { total: number; enabled: number; described: number } {
  const models = selectAccessControlledModels(catalog);
  let enabled = 0;
  let described = 0;
  for (const model of models) {
    const entry = entries[model.modelId];
    if (entry?.enabled !== false) {
      enabled += 1;
    }
    if (entry?.description) {
      described += 1;
    }
  }
  return { total: models.length, enabled, described };
}

type ProviderGroup = {
  providerId: string;
  providerName: string;
  models: CesiumModelCatalogEntry[];
};

function groupByProvider(models: CesiumModelCatalogEntry[]): ProviderGroup[] {
  const map = new Map<string, ProviderGroup>();
  for (const model of models) {
    const group = map.get(model.providerId);
    if (group) {
      group.models.push(model);
    } else {
      map.set(model.providerId, {
        providerId: model.providerId,
        providerName: model.providerName,
        models: [model],
      });
    }
  }
  return [...map.values()].sort((a, b) => a.providerName.localeCompare(b.providerName));
}

/** Controlled note field with a live character budget; commits on blur. */
function ModelDescriptionField({
  modelId,
  stored,
  disabled,
  onCommit,
}: {
  modelId: string;
  stored: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const [value, setValue] = useState(stored);
  const remaining = CESIUM_MODEL_DESCRIPTION_MAX_LENGTH - value.length;
  return (
    <div className="mt-[6px] flex flex-col gap-[3px]">
      <input
        type="text"
        value={value}
        maxLength={CESIUM_MODEL_DESCRIPTION_MAX_LENGTH}
        disabled={disabled}
        placeholder="Optional note shown to the agent and its subagents (e.g. “fast + cheap — use for exploration”)"
        aria-label={`Description for ${modelId}`}
        onChange={(event) => setValue(event.currentTarget.value)}
        onBlur={() => {
          if (value.trim() !== stored.trim()) {
            onCommit(value.trim());
          }
        }}
        className="box-border w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[9px] py-[5px] font-sans text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
      />
      <span
        className={`self-end font-mono text-[10px] ${
          remaining <= 25 ? "text-[#b45309] dark:text-[#fbbf24]" : "text-[var(--text-disabled)]"
        }`}
      >
        {remaining} left
      </span>
    </div>
  );
}

/**
 * Per-model access filter for the Cesium first-party harness. Disabled models
 * disappear from the composer picker and are rejected as spawn_agent
 * overrides; the ≤250-char notes are presented to the primary agent and every
 * subagent so model handoffs stay informed at any spawn depth.
 */
export function CesiumModelAccessSection({
  catalog,
  entries,
  defaultModelId,
  busy,
  onPatchEntries,
}: {
  catalog: CesiumModelCatalogEntry[];
  entries: CesiumModelAccessEntries;
  defaultModelId: string;
  busy: boolean;
  onPatchEntries: (patch: CesiumModelAccessEntryPatch) => void;
}) {
  const [query, setQuery] = useState("");
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());

  const models = useMemo(() => selectAccessControlledModels(catalog), [catalog]);
  const summary = useMemo(() => summarizeCesiumModelAccess(catalog, entries), [catalog, entries]);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredGroups = useMemo(() => {
    const filtered = normalizedQuery
      ? models.filter(
          (model) =>
            model.modelId.toLowerCase().includes(normalizedQuery) ||
            model.modelName.toLowerCase().includes(normalizedQuery) ||
            model.providerName.toLowerCase().includes(normalizedQuery)
        )
      : models;
    return groupByProvider(filtered);
  }, [models, normalizedQuery]);

  const toggleProvider = (providerId: string) => {
    setExpandedProviders((current) => {
      const next = new Set(current);
      if (next.has(providerId)) {
        next.delete(providerId);
      } else {
        next.add(providerId);
      }
      return next;
    });
  };

  return (
    <div>
      <SettingsSubsectionHeading>Model access</SettingsSubsectionHeading>
      <p className="mt-[4px] font-sans text-[12px] leading-[1.45] text-[var(--text-secondary)]">
        Filter which catalog models the Cesium agent — and any subagents it spawns — may use.
        Disabled models leave the composer picker and are rejected as{" "}
        <code className="font-mono text-[11px]">spawn_agent</code> overrides. Add a short note (max{" "}
        {CESIUM_MODEL_DESCRIPTION_MAX_LENGTH} characters) to an enabled model and it is presented to
        the primary agent and every subagent, recursively, so they can pick overrides intelligently.
      </p>
      <div className="mt-[10px] flex flex-wrap items-center justify-between gap-[8px]">
        <div className="relative min-w-[220px] flex-1">
          <Search
            className="pointer-events-none absolute left-[9px] top-1/2 size-[13px] -translate-y-1/2 text-[var(--text-disabled)]"
            strokeWidth={1.75}
            aria-hidden
          />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search models or providers"
            aria-label="Search model access list"
            className="box-border min-h-[30px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] py-[5px] pl-[28px] pr-[10px] font-sans text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
          />
        </div>
        <span className="font-sans text-[12px] text-[var(--text-secondary)]">
          {summary.enabled}/{summary.total} enabled
          {summary.described > 0 ? ` · ${summary.described} described` : ""}
        </span>
      </div>
      <div className="mt-[10px] divide-y divide-[var(--border-subtle)] rounded-[8px] border border-[var(--border-subtle)]">
        {filteredGroups.length === 0 ? (
          <p className="px-[12px] py-[16px] text-center font-sans text-[12px] text-[var(--text-disabled)]">
            No tool-capable models match “{query}”.
          </p>
        ) : (
          filteredGroups.map((group) => {
            const open = normalizedQuery.length > 0 || expandedProviders.has(group.providerId);
            const groupEnabled = group.models.filter(
              (model) => entries[model.modelId]?.enabled !== false
            ).length;
            return (
              <div key={group.providerId}>
                <div className="flex items-center justify-between gap-[10px] px-[10px] py-[8px]">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => toggleProvider(group.providerId)}
                    className="flex min-w-0 flex-1 items-center gap-[8px] text-left transition-colors hover:text-[var(--text-primary)]"
                  >
                    <ChevronRight
                      className={`size-[13px] shrink-0 text-[var(--text-secondary)] transition-transform ${
                        open ? "rotate-90" : ""
                      }`}
                      strokeWidth={1.75}
                      aria-hidden
                    />
                    <span className="truncate font-sans text-[13px] font-medium text-[var(--text-primary)]">
                      {group.providerName}
                    </span>
                    <span className="shrink-0 font-mono text-[10.5px] text-[var(--text-disabled)]">
                      {groupEnabled}/{group.models.length} on
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-[6px]">
                    <button
                      type="button"
                      className={rowButtonClass}
                      disabled={busy || groupEnabled === group.models.length}
                      onClick={() =>
                        onPatchEntries(
                          Object.fromEntries(
                            group.models.map((model) => [model.modelId, { enabled: true }])
                          )
                        )
                      }
                    >
                      All on
                    </button>
                    <button
                      type="button"
                      className={rowButtonClass}
                      disabled={busy || groupEnabled === 0}
                      onClick={() =>
                        onPatchEntries(
                          Object.fromEntries(
                            group.models.map((model) => [model.modelId, { enabled: false }])
                          )
                        )
                      }
                    >
                      All off
                    </button>
                  </div>
                </div>
                {open ? (
                  <div className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)] bg-[var(--bg-main)]/40">
                    {group.models.map((model) => {
                      const entry = entries[model.modelId];
                      const enabled = entry?.enabled !== false;
                      const stored = entry?.description ?? "";
                      const isDefault = model.modelId === defaultModelId;
                      const labelId = `cesium-model-access-${model.modelId.replace(/[^a-zA-Z0-9]+/g, "-")}`;
                      return (
                        <div key={model.modelId} className="px-[12px] py-[9px] pl-[31px]">
                          <div className="flex items-center justify-between gap-[12px]">
                            <div className="min-w-0 flex-1">
                              <p
                                id={labelId}
                                className="flex flex-wrap items-center gap-[6px] font-sans text-[13px] text-[var(--text-primary)]"
                              >
                                {model.modelName}
                                {isDefault ? <span className={tagClass}>default</span> : null}
                              </p>
                              <p className="mt-[2px] font-mono text-[10.5px] text-[var(--text-disabled)]">
                                {model.modelId}
                                {model.contextWindow
                                  ? ` · ${model.contextWindow.toLocaleString()} ctx`
                                  : ""}
                                {model.supportsReasoning ? " · reasoning" : ""}
                                {model.supportsImages ? " · images" : ""}
                              </p>
                            </div>
                            <ToggleSwitch
                              checked={enabled}
                              onChange={(next) =>
                                onPatchEntries({ [model.modelId]: { enabled: next } })
                              }
                              size="md"
                              variant="green"
                              labelledBy={labelId}
                              disabled={busy}
                            />
                          </div>
                          {enabled ? (
                            <ModelDescriptionField
                              modelId={model.modelId}
                              stored={stored}
                              disabled={busy}
                              onCommit={(value) =>
                                onPatchEntries({
                                  [model.modelId]: { description: value || null },
                                })
                              }
                            />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
      <p className="mt-[8px] font-sans text-[11px] leading-relaxed text-[var(--text-disabled)]">
        <SettingsFieldLabel className="mr-[4px]">Note:</SettingsFieldLabel>
        the active default model always stays available so running conversations never lose their
        model; subagents inherit the parent&apos;s model unless a spawn override names another
        enabled model.
      </p>
    </div>
  );
}
