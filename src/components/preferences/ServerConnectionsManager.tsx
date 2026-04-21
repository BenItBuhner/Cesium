"use client";

import { useCallback, useMemo, useState } from "react";
import { Check, Pencil, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";

const inputClass =
  "box-border h-[36px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] font-sans text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]";

const buttonClass =
  "inline-flex h-[32px] items-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)] disabled:cursor-not-allowed disabled:opacity-50";

type ProbeState = {
  status: "idle" | "running" | "ok" | "error";
  message: string | null;
};

export function ServerConnectionsManager({
  onActivate,
  compact = false,
}: {
  onActivate?: (serverId: string) => void;
  compact?: boolean;
}) {
  const { activeServer, servers, saveServer, removeServer, probeServer } = useServerConnections();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [probeByServerId, setProbeByServerId] = useState<Record<string, ProbeState>>({});
  const [savePending, setSavePending] = useState(false);

  const isEditing = editingId !== null;

  const resetForm = useCallback(() => {
    setEditingId(null);
    setLabel("");
    setBaseUrl("");
    setFormError(null);
  }, []);

  const handleSave = useCallback(async () => {
    setSavePending(true);
    setFormError(null);
    try {
      const saved = saveServer({
        id: editingId ?? undefined,
        label,
        baseUrl,
      });
      setProbeByServerId((current) => ({
        ...current,
        [saved.id]: { status: "idle", message: null },
      }));
      resetForm();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Failed to save server.");
    } finally {
      setSavePending(false);
    }
  }, [baseUrl, editingId, label, resetForm, saveServer]);

  const runProbe = useCallback(
    async (serverId: string, candidateBaseUrl: string) => {
      setProbeByServerId((current) => ({
        ...current,
        [serverId]: { status: "running", message: null },
      }));
      const result = await probeServer(candidateBaseUrl);
      setProbeByServerId((current) => ({
        ...current,
        [serverId]: {
          status: result.ok ? "ok" : "error",
          message: result.ok
            ? result.authEnabled
              ? result.authenticated
                ? "Reachable, auth enabled, signed in."
                : "Reachable, auth enabled."
              : "Reachable."
            : result.error,
        },
      }));
    },
    [probeServer]
  );

  const rows = useMemo(
    () =>
      servers.map((server) => {
        const probe = probeByServerId[server.id] ?? { status: "idle", message: null };
        const isActive = server.id === activeServer.id;
        return { isActive, probe, server };
      }),
    [activeServer.id, probeByServerId, servers]
  );

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)]">
        {rows.map(({ isActive, probe, server }, index) => (
          <div
            key={server.id}
            className={`flex flex-col gap-[10px] px-[14px] py-[12px] ${
              index < rows.length - 1 ? "border-b border-[var(--border-subtle)]" : ""
            }`}
          >
            <div className="flex items-start justify-between gap-[12px]">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-[8px]">
                  <p className="truncate font-sans text-[13px] font-medium text-[var(--text-primary)]">
                    {server.label}
                  </p>
                  {isActive ? (
                    <span className="rounded-[999px] bg-[var(--accent-bg)] px-[8px] py-[2px] font-sans text-[11px] text-[var(--text-primary)]">
                      Active
                    </span>
                  ) : null}
                </div>
                <p className="mt-[4px] break-all font-mono text-[11px] text-[var(--text-secondary)]">
                  {server.baseUrl}
                </p>
                {probe.message ? (
                  <p
                    className={`mt-[6px] font-sans text-[11px] ${
                      probe.status === "error"
                        ? "text-[var(--debug-accent)]"
                        : "text-[var(--text-secondary)]"
                    }`}
                  >
                    {probe.message}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-wrap justify-end gap-[8px]">
                {onActivate ? (
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={isActive}
                    onClick={() => onActivate(server.id)}
                  >
                    <Check className="size-[14px]" strokeWidth={1.5} aria-hidden />
                    {isActive ? "Connected" : "Connect"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={buttonClass}
                  disabled={probe.status === "running"}
                  onClick={() => void runProbe(server.id, server.baseUrl)}
                >
                  <RefreshCw
                    className={`size-[14px] ${probe.status === "running" ? "animate-spin" : ""}`}
                    strokeWidth={1.5}
                    aria-hidden
                  />
                  Test
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => {
                    setEditingId(server.id);
                    setLabel(server.label);
                    setBaseUrl(server.baseUrl);
                    setFormError(null);
                  }}
                >
                  <Pencil className="size-[14px]" strokeWidth={1.5} aria-hidden />
                  Edit
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={servers.length <= 1}
                  onClick={() => removeServer(server.id)}
                >
                  <Trash2 className="size-[14px]" strokeWidth={1.5} aria-hidden />
                  Remove
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[14px] py-[14px]">
        <div className="mb-[10px] flex items-center gap-[8px]">
          <Server className="size-[15px] text-[var(--text-secondary)]" strokeWidth={1.6} />
          <h3 className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
            {isEditing ? "Edit server" : "Add server"}
          </h3>
        </div>
        <div className={`grid gap-[10px] ${compact ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2"}`}>
          <label className="flex flex-col gap-[6px]">
            <span className="font-sans text-[11px] text-[var(--text-secondary)]">Label</span>
            <input
              type="text"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="My server"
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-[6px]">
            <span className="font-sans text-[11px] text-[var(--text-secondary)]">Base URL</span>
            <input
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://server.example.com"
              className={inputClass}
            />
          </label>
        </div>
        {formError ? (
          <p className="mt-[10px] font-sans text-[11px] text-[var(--debug-accent)]">{formError}</p>
        ) : null}
        <div className="mt-[12px] flex flex-wrap gap-[8px]">
          <button type="button" className={buttonClass} onClick={() => void handleSave()} disabled={savePending}>
            <Plus className="size-[14px]" strokeWidth={1.5} aria-hidden />
            {isEditing ? "Save changes" : "Save server"}
          </button>
          {isEditing ? (
            <button type="button" className={buttonClass} onClick={resetForm}>
              Cancel
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
