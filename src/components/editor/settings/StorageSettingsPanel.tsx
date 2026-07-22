"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { ChevronRight, Database, Download, RefreshCw, Upload } from "lucide-react";
import {
  buildStorageExportUrl,
  fetchStorageStatus,
  importStorageArchive,
  runStorageMigration,
  type StorageDriverKind,
  type StorageMigrationPhase,
  type StorageMigrationProgress,
  type StorageMigrationResult,
  type StorageStatusResponse,
} from "@/lib/server-api";
import {
  PageIntro,
  SettingsBlock,
  SettingsCallout,
  SettingsRow,
  SettingsSection,
  rowButtonClass,
} from "@/components/editor/settings-ui";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { selectClass } from "./shared";

const STORAGE_DRIVER_LABELS: Record<StorageDriverKind, string> = {
  "legacy-json": "Legacy JSON",
  pg: "Postgres",
};

const STORAGE_PHASE_LABELS: Record<StorageMigrationPhase, string> = {
  workspaces: "Workspaces",
  "workspace-profile": "Workspace profile",
  "global-settings": "Global settings",
  "auth-state": "Auth state",
  "auth-sessions": "Auth sessions",
  "workspace-sessions": "Workspace sessions",
  "workspace-windows": "Workspace windows",
  "workspace-window-sessions": "Workspace window sessions",
  "agent-conversations": "Agent conversations",
  "agent-events": "Agent events",
  goals: "Goals",
  extensions: "Extensions",
  "provider-cache": "Provider cache",
};

function formatStorageStats(stats: StorageStatusResponse["drivers"]["pg"]): string {
  if (!stats.available || !stats.stats) {
    return stats.error ? `unavailable — ${stats.error}` : "unavailable";
  }
  const { workspaces, agentConversations, authSessions, providerCacheEntries } =
    stats.stats;
  return `${workspaces} workspaces · ${agentConversations} conversations · ${authSessions} sessions · ${providerCacheEntries} provider cache entries`;
}

function StorageImportButton({
  target,
  disabled,
  onImport,
}: {
  target: StorageDriverKind;
  disabled?: boolean;
  onImport: (file: File, target: StorageDriverKind, overwrite: boolean) => Promise<void>;
}) {
  const [overwrite, setOverwrite] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const handleFilesChanged = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      await onImport(file, target, overwrite);
    },
    [onImport, overwrite, target]
  );
  return (
    <div className="flex items-center gap-[6px]">
      <input
        ref={inputRef}
        type="file"
        accept=".ndjson,application/x-ndjson,application/json,.json"
        className="hidden"
        onChange={(event) => void handleFilesChanged(event)}
      />
      <label
        className="flex items-center gap-[4px] font-sans text-[11px] text-[var(--text-secondary)]"
        title="Overwrite existing rows on import"
      >
        <input
          type="checkbox"
          checked={overwrite}
          disabled={disabled}
          onChange={(event) => setOverwrite(event.target.checked)}
        />
        overwrite
      </label>
      <button
        type="button"
        className={rowButtonClass}
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
      >
        <Upload className="size-[14px]" strokeWidth={1.5} aria-hidden />
        Import
      </button>
    </div>
  );
}

export function StorageSettingsPanel() {
  const [status, setStatus] = useState<StorageStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [direction, setDirection] = useState<{
    from: StorageDriverKind;
    to: StorageDriverKind;
  }>({ from: "legacy-json", to: "pg" });
  const [overwrite, setOverwrite] = useState(false);
  const [running, setRunning] = useState(false);
  const [currentProgress, setCurrentProgress] =
    useState<StorageMigrationProgress | null>(null);
  const [migrationLog, setMigrationLog] = useState<string[]>([]);
  const [lastResult, setLastResult] = useState<StorageMigrationResult | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const payload = await fetchStorageStatus();
      setStatus(payload);
      setStatusError(null);
      if (payload.currentDriver !== direction.from && !running) {
        const other: StorageDriverKind =
          payload.currentDriver === "pg" ? "legacy-json" : "pg";
        setDirection({ from: payload.currentDriver, to: other });
      }
    } catch (error) {
      setStatusError((error as Error).message);
    }
  }, [direction.from, running]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const handleStartMigration = useCallback(async () => {
    if (running) return;
    if (direction.from === direction.to) return;
    setRunning(true);
    setCurrentProgress(null);
    setLastResult(null);
    setMigrationLog([
      `Starting migration ${STORAGE_DRIVER_LABELS[direction.from]} → ${STORAGE_DRIVER_LABELS[direction.to]}${overwrite ? " (overwrite)" : ""}`,
    ]);
    try {
      await runStorageMigration(
        { from: direction.from, to: direction.to, overwrite },
        {
          onProgress: (event) => {
            setCurrentProgress(event);
          },
          onResult: (result) => {
            setLastResult(result);
            setMigrationLog((log) => [
              ...log,
              ...result.phases.map(
                (phase) =>
                  `${STORAGE_PHASE_LABELS[phase.phase]}: migrated ${phase.migrated}, skipped ${phase.skipped}${
                    phase.errors.length > 0 ? `, ${phase.errors.length} errors` : ""
                  }`
              ),
            ]);
          },
          onError: (message) => {
            setMigrationLog((log) => [...log, `Error: ${message}`]);
          },
        }
      );
    } catch (error) {
      setMigrationLog((log) => [...log, `Failed: ${(error as Error).message}`]);
    } finally {
      setRunning(false);
      void refreshStatus();
    }
  }, [direction, overwrite, refreshStatus, running]);

  const handleExport = useCallback(
    (driver: StorageDriverKind) => {
      if (typeof window === "undefined") return;
      const url = buildStorageExportUrl(driver);
      window.open(url, "_blank", "noopener,noreferrer");
    },
    []
  );

  const handleImport = useCallback(
    async (
      file: File,
      target: StorageDriverKind,
      forceOverwrite: boolean
    ): Promise<void> => {
      try {
        const archive = await file.text();
        const result = await importStorageArchive(archive, {
          driver: target,
          overwrite: forceOverwrite,
        });
        setMigrationLog((log) => [
          ...log,
          `Imported ${result.applied} entries into ${STORAGE_DRIVER_LABELS[target]}${
            result.errors.length > 0 ? ` with ${result.errors.length} errors` : ""
          }`,
        ]);
        await refreshStatus();
      } catch (error) {
        setMigrationLog((log) => [
          ...log,
          `Import failed: ${(error as Error).message}`,
        ]);
      }
    },
    [refreshStatus]
  );

  const legacyDiag = status?.drivers["legacy-json"];
  const pgDiag = status?.drivers.pg;
  const progressPercent = useMemo(() => {
    if (!currentProgress) return null;
    if (currentProgress.total === null || currentProgress.total === 0) return null;
    return Math.min(
      100,
      Math.round((currentProgress.completed / currentProgress.total) * 100)
    );
  }, [currentProgress]);

  return (
    <>
      <PageIntro title="Storage" />
      <SettingsSection
        title="Storage drivers"
        action={
          <button
            type="button"
            className={rowButtonClass}
            onClick={() => void refreshStatus()}
            disabled={running}
          >
            <RefreshCw className="size-[14px]" strokeWidth={1.5} aria-hidden />
            Refresh
          </button>
        }
      >
        {statusError ? (
          <SettingsBlock>
            <SettingsCallout tone="danger">Status unavailable: {statusError}</SettingsCallout>
          </SettingsBlock>
        ) : null}
        <SettingsRow
          title="Current driver"
          description={`OPENCURSOR_STORAGE_DRIVER=${status?.currentDriver ?? "(unknown)"}`}
          trailing={
            <span className="font-sans text-[12px] text-[var(--text-secondary)]">
              {status ? STORAGE_DRIVER_LABELS[status.currentDriver] : "Loading…"}
            </span>
          }
        />
        <SettingsRow
          title="Legacy JSON"
          description={legacyDiag ? formatStorageStats(legacyDiag) : "Loading…"}
          trailing={
            <div className="flex gap-[8px]">
              <button
                type="button"
                className={rowButtonClass}
                onClick={() => handleExport("legacy-json")}
                disabled={running}
              >
                <Download className="size-[14px]" strokeWidth={1.5} aria-hidden />
                Export
              </button>
              <StorageImportButton
                target="legacy-json"
                disabled={running}
                onImport={handleImport}
              />
            </div>
          }
        />
        <SettingsRow
          title="Postgres"
          description={pgDiag ? formatStorageStats(pgDiag) : "Loading…"}
          border={false}
          trailing={
            <div className="flex gap-[8px]">
              <button
                type="button"
                className={rowButtonClass}
                onClick={() => handleExport("pg")}
                disabled={running || !pgDiag?.available}
              >
                <Download className="size-[14px]" strokeWidth={1.5} aria-hidden />
                Export
              </button>
              <StorageImportButton
                target="pg"
                disabled={running || !pgDiag?.available}
                onImport={handleImport}
              />
            </div>
          }
        />
      </SettingsSection>
      <SettingsSection title="Migrate between drivers">
        <SettingsRow
          title="Direction"
          description="Choose which driver to copy from and which to copy to."
          trailing={
            <div className="flex items-center gap-[8px]">
              <select
                className={selectClass}
                value={direction.from}
                disabled={running}
                onChange={(event) => {
                  const next = event.target.value as StorageDriverKind;
                  setDirection(() => ({
                    from: next,
                    to: next === "pg" ? "legacy-json" : "pg",
                  }));
                }}
              >
                <option value="legacy-json">Legacy JSON</option>
                <option value="pg">Postgres</option>
              </select>
              <ChevronRight className="size-[14px] text-[var(--text-secondary)]" aria-hidden />
              <select
                className={selectClass}
                value={direction.to}
                disabled={running}
                onChange={(event) =>
                  setDirection((prev) => ({
                    ...prev,
                    to: event.target.value as StorageDriverKind,
                  }))
                }
              >
                <option value="legacy-json">Legacy JSON</option>
                <option value="pg">Postgres</option>
              </select>
            </div>
          }
        />
        <SettingsRow
          title="Overwrite existing entries"
          description="When off, entries that already exist on the target are skipped. Turn this on only when you want the source to win."
          trailing={
            <ToggleSwitch
              checked={overwrite}
              onChange={setOverwrite}
              size="md"
            />
          }
        />
        <SettingsRow
          title="Run migration"
          description={
            direction.from === direction.to
              ? "Source and target must differ."
              : `Copies data from ${STORAGE_DRIVER_LABELS[direction.from]} to ${STORAGE_DRIVER_LABELS[direction.to]}.`
          }
          border={currentProgress !== null || migrationLog.length > 0}
          trailing={
            <button
              type="button"
              className={rowButtonClass}
              onClick={() => void handleStartMigration()}
              disabled={running || direction.from === direction.to}
            >
              <Database className="size-[14px]" strokeWidth={1.5} aria-hidden />
              {running ? "Migrating…" : "Start migration"}
            </button>
          }
        />
        {currentProgress ? (
          <SettingsBlock className="py-[12px]">
            <p className="font-sans text-[12px] text-[var(--text-secondary)]">
              {STORAGE_PHASE_LABELS[currentProgress.phase] ?? currentProgress.phase}
              {currentProgress.currentKey ? ` · ${currentProgress.currentKey}` : ""}
              {" — "}
              {currentProgress.completed}
              {currentProgress.total === null ? "" : ` / ${currentProgress.total}`}
            </p>
            {progressPercent !== null ? (
              <div className="mt-[8px] h-[4px] w-full overflow-hidden rounded-full bg-[var(--border-subtle)]">
                <div
                  className="h-full bg-[var(--accent-strong)] transition-[width]"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            ) : null}
          </SettingsBlock>
        ) : null}
        {migrationLog.length > 0 ? (
          <SettingsBlock className="py-[12px]">
            <ul className="flex flex-col gap-[4px] font-sans text-[12px] text-[var(--text-secondary)]">
              {migrationLog.map((line, idx) => (
                <li key={idx}>{line}</li>
              ))}
            </ul>
            {lastResult ? (
              <p className="mt-[8px] font-sans text-[12px] text-[var(--text-primary)]">
                {lastResult.ok ? "Completed successfully." : "Completed with errors."}
              </p>
            ) : null}
          </SettingsBlock>
        ) : null}
      </SettingsSection>
    </>
  );
}
