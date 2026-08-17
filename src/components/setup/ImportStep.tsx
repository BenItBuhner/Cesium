"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CloudDownload, HardDriveDownload, Loader2 } from "lucide-react";
import { useCloudContext, type CloudSnapshotMeta } from "@/contexts/CloudContext";
import {
  bootstrapEngineWorkspaces,
  importEngineHarnessSession,
  listEngineImportSessions,
  listEngineImportSources,
  materializeEngineCloudSnapshot,
  type EngineImportSession,
  type EngineImportSource,
} from "@/lib/onboarding/engine-api";

/**
 * Step 3 — import your previous work. Two sources:
 * - harness CLIs on the engine host (Codex/Claude/OpenCode/… local sessions)
 * - your cloud conversation snapshots, pushed from any other Cesium engine
 * Both materialize as first-class Cesium conversations.
 */
export function ImportStep({
  baseUrl,
  onImported,
}: {
  baseUrl: string;
  onImported: () => void;
}) {
  const cloud = useCloudContext();
  const [sources, setSources] = useState<EngineImportSource[] | null>(null);
  const [sessionsByBackend, setSessionsByBackend] = useState<
    Record<string, EngineImportSession[]>
  >({});
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [importedKeys, setImportedKeys] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const snapshots = cloud.bootstrap?.snapshots ?? [];

  const load = useCallback(async () => {
    try {
      const [sourceList, workspaces] = await Promise.all([
        listEngineImportSources(baseUrl),
        bootstrapEngineWorkspaces(baseUrl),
      ]);
      setSources(sourceList);
      const target =
        workspaces.workspaces.find(
          (workspace) => workspace.id === workspaces.defaultWorkspaceId
        ) ?? workspaces.workspaces[0];
      setWorkspaceId(target?.id ?? null);
      setWorkspaceName(target?.name ?? null);
      const withSessions = sourceList.filter(
        (source) => source.available && source.sessionCount > 0
      );
      const loaded: Record<string, EngineImportSession[]> = {};
      await Promise.all(
        withSessions.map(async (source) => {
          try {
            loaded[source.backendId] = (
              await listEngineImportSessions(
                baseUrl,
                source.backendId,
                target?.id ?? ""
              )
            ).slice(0, 5);
          } catch {
            loaded[source.backendId] = [];
          }
        })
      );
      setSessionsByBackend(loaded);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [baseUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  const importHarness = async (backendId: string, session: EngineImportSession) => {
    if (!workspaceId) {
      return;
    }
    const key = `${backendId}:${session.id}`;
    setBusyKey(key);
    setError(null);
    try {
      await importEngineHarnessSession(baseUrl, backendId, workspaceId, session.id);
      setImportedKeys((prev) => new Set(prev).add(key));
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const importSnapshot = async (snapshot: CloudSnapshotMeta) => {
    if (!workspaceId || !cloud.actions) {
      return;
    }
    const key = `cloud:${snapshot.snapshotKey}`;
    setBusyKey(key);
    setError(null);
    try {
      const full = await cloud.actions.getSnapshot(snapshot.snapshotKey);
      if (!full) {
        throw new Error("Snapshot no longer exists in your cloud context.");
      }
      await materializeEngineCloudSnapshot(baseUrl, workspaceId, {
        snapshotKey: full.snapshotKey,
        recordJson: full.recordJson,
        eventsJson: full.eventsJson,
        sourceServerName: full.serverName,
        sourceWorkspaceName: full.workspaceName,
        sourceUpdatedAt: full.sourceUpdatedAt,
      });
      setImportedKeys((prev) => new Set(prev).add(key));
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  if (!sources) {
    return (
      <div className="flex items-center gap-[10px] p-[16px] text-[13px] text-[var(--text-secondary)]">
        <Loader2 className="size-[15px] animate-spin" strokeWidth={2} aria-hidden />
        Scanning the engine for importable work…
      </div>
    );
  }

  const availableSources = sources.filter(
    (source) => source.available && source.sessionCount > 0
  );

  return (
    <div className="space-y-[16px]">
      <section>
        <p className="mb-[8px] flex items-center gap-[8px] font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--text-disabled)]">
          <CloudDownload className="size-[13px]" strokeWidth={1.75} aria-hidden />
          From your cloud
        </p>
        {cloud.mode === "disabled" ? (
          <p className="text-[12.5px] text-[var(--text-secondary)]">
            Cloud sync is not configured for this build — nothing to pull.
          </p>
        ) : snapshots.length === 0 ? (
          <p className="text-[12.5px] text-[var(--text-secondary)]">
            No synced conversations yet. Conversations you sync from any engine
            appear here on every device.
          </p>
        ) : (
          <div className="space-y-[8px]">
            {snapshots.map((snapshot) => {
              const key = `cloud:${snapshot.snapshotKey}`;
              const done = importedKeys.has(key);
              return (
                <div
                  key={snapshot.snapshotKey}
                  className="flex items-center gap-[10px] rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-[14px] py-[10px]"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                      {snapshot.title}
                    </p>
                    <p className="font-mono text-[10.5px] text-[var(--text-disabled)]">
                      {snapshot.messageCount} messages · {snapshot.backendId}
                      {snapshot.serverName ? ` · from ${snapshot.serverName}` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busyKey !== null || done || !workspaceId}
                    onClick={() => void importSnapshot(snapshot)}
                    className="ml-auto inline-flex shrink-0 items-center gap-[6px] rounded-[var(--radius-tab)] bg-[var(--accent)] px-[10px] py-[5px] text-[12px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)] disabled:opacity-60"
                  >
                    {busyKey === key ? (
                      <Loader2 className="size-[12px] animate-spin" strokeWidth={2} aria-hidden />
                    ) : done ? (
                      <CheckCircle2 className="size-[12px]" strokeWidth={2} aria-hidden />
                    ) : null}
                    {done ? "Imported" : "Import"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <p className="mb-[8px] flex items-center gap-[8px] font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--text-disabled)]">
          <HardDriveDownload className="size-[13px]" strokeWidth={1.75} aria-hidden />
          From CLIs on the engine host
        </p>
        {availableSources.length === 0 ? (
          <p className="text-[12.5px] text-[var(--text-secondary)]">
            No harness CLI sessions found on this engine (Codex, Claude Code,
            OpenCode, and friends store sessions locally once you use them).
          </p>
        ) : (
          <div className="space-y-[10px]">
            {availableSources.map((source) => (
              <div key={source.backendId}>
                <p className="mb-[6px] text-[12.5px] font-medium text-[var(--text-secondary)]">
                  {source.label} · {source.sessionCount} session
                  {source.sessionCount === 1 ? "" : "s"}
                </p>
                <div className="space-y-[6px]">
                  {(sessionsByBackend[source.backendId] ?? []).map((session) => {
                    const key = `${source.backendId}:${session.id}`;
                    const done =
                      importedKeys.has(key) || session.importedConversationId !== null;
                    return (
                      <div
                        key={session.id}
                        className="flex items-center gap-[10px] rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-[14px] py-[10px]"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                            {session.title}
                          </p>
                          <p className="font-mono text-[10.5px] text-[var(--text-disabled)]">
                            {session.messageCount} messages
                          </p>
                        </div>
                        <button
                          type="button"
                          disabled={busyKey !== null || done || !workspaceId}
                          onClick={() => void importHarness(source.backendId, session)}
                          className="ml-auto inline-flex shrink-0 items-center gap-[6px] rounded-[var(--radius-tab)] bg-[var(--accent)] px-[10px] py-[5px] text-[12px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)] disabled:opacity-60"
                        >
                          {busyKey === key ? (
                            <Loader2 className="size-[12px] animate-spin" strokeWidth={2} aria-hidden />
                          ) : done ? (
                            <CheckCircle2 className="size-[12px]" strokeWidth={2} aria-hidden />
                          ) : null}
                          {done ? "Imported" : "Import"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {workspaceName ? (
        <p className="font-mono text-[10.5px] text-[var(--text-disabled)]">
          Imports land in workspace “{workspaceName}”.
        </p>
      ) : (
        <p className="font-mono text-[10.5px] text-[var(--text-disabled)]">
          Imports need a workspace to land in — none exists yet. Create or open
          one in the workbench first (chatting works without one).
        </p>
      )}
      {error ? <p className="text-[12.5px] text-[var(--goal-accent)]">{error}</p> : null}
    </div>
  );
}
