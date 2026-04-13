"use client";

import { useCallback, useState, type FormEvent } from "react";
import { Check, PlugZap, Plus, Server, Trash2 } from "lucide-react";
import { useServerConnections } from "@/components/server/ServerConnectionsProvider";

const inputClass =
  "w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[12px] py-[9px] font-sans text-[13px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]";

const actionButtonClass =
  "inline-flex h-[34px] items-center justify-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[12px] font-sans text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]";

function Badge({
  children,
  tone = "default",
}: {
  children: string;
  tone?: "default" | "active";
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-[8px] py-[2px] font-sans text-[11px] font-medium ${
        tone === "active"
          ? "bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--accent)]"
          : "bg-[var(--bg-main)] text-[var(--text-secondary)]"
      }`}
    >
      {children}
    </span>
  );
}

export function ServerConnectionsManager() {
  const {
    activeConnection,
    connections,
    defaultConnectionId,
    saveConnection,
    setActiveConnection,
    removeConnection,
  } = useServerConnections();
  const [draftLabel, setDraftLabel] = useState("");
  const [draftUrl, setDraftUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSave = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      try {
        saveConnection({
          baseUrl: draftUrl,
          label: draftLabel,
          setActive: true,
        });
        setDraftLabel("");
        setDraftUrl("");
        setError(null);
      } catch (nextError) {
        setError(
          nextError instanceof Error ? nextError.message : "Could not save this server."
        );
      }
    },
    [draftLabel, draftUrl, saveConnection]
  );

  return (
    <div className="space-y-[12px]">
      <div className="rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-main)] px-[14px] py-[12px]">
        <div className="mb-[8px] flex items-center gap-[8px]">
          <Server className="size-[15px] text-[var(--text-secondary)]" strokeWidth={1.7} />
          <span className="font-sans text-[12px] font-medium text-[var(--text-secondary)]">
            Active server
          </span>
          <Badge tone="active">Selected</Badge>
        </div>
        <p className="font-sans text-[13px] font-semibold text-[var(--text-primary)]">
          {activeConnection.label}
        </p>
        <p className="mt-[4px] break-all font-mono text-[11px] text-[var(--text-secondary)]">
          {activeConnection.baseUrl}
        </p>
      </div>

      <form className="grid gap-[10px] md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]" onSubmit={handleSave}>
        <label className="flex flex-col gap-[6px]">
          <span className="font-sans text-[12px] font-medium text-[var(--text-secondary)]">
            Label
          </span>
          <input
            type="text"
            value={draftLabel}
            onChange={(event) => setDraftLabel(event.target.value)}
            className={inputClass}
            placeholder="Office server"
          />
        </label>
        <label className="flex flex-col gap-[6px]">
          <span className="font-sans text-[12px] font-medium text-[var(--text-secondary)]">
            Server URL
          </span>
          <input
            type="text"
            value={draftUrl}
            onChange={(event) => setDraftUrl(event.target.value)}
            className={inputClass}
            placeholder="http://localhost:9100"
            required
          />
        </label>
        <div className="flex items-end">
          <button type="submit" className={`${actionButtonClass} min-w-[132px]`}>
            <Plus className="size-[14px]" strokeWidth={1.8} />
            Save & connect
          </button>
        </div>
      </form>

      {error ? (
        <div className="rounded-[var(--radius-tab)] border border-[color-mix(in_srgb,var(--debug-accent)_28%,transparent)] bg-[color-mix(in_srgb,var(--debug-accent-bg)_82%,transparent)] px-[11px] py-[9px] font-sans text-[12px] leading-[1.45] text-[var(--text-primary)]">
          {error}
        </div>
      ) : null}

      <div className="space-y-[8px]">
        {connections.map((connection) => {
          const isActive = connection.id === activeConnection.id;
          const isDefault = connection.id === defaultConnectionId;
          return (
            <div
              key={connection.id}
              className="flex flex-col gap-[12px] rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-main)] px-[14px] py-[12px] md:flex-row md:items-center md:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-[8px]">
                  <p className="font-sans text-[13px] font-semibold text-[var(--text-primary)]">
                    {connection.label}
                  </p>
                  {isActive ? <Badge tone="active">Active</Badge> : null}
                  {isDefault ? <Badge>Built-in</Badge> : null}
                </div>
                <p className="mt-[4px] break-all font-mono text-[11px] text-[var(--text-secondary)]">
                  {connection.baseUrl}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-[8px]">
                <button
                  type="button"
                  className={actionButtonClass}
                  onClick={() => setActiveConnection(connection.id)}
                  disabled={isActive}
                >
                  {isActive ? (
                    <>
                      <Check className="size-[14px]" strokeWidth={1.9} />
                      Active
                    </>
                  ) : (
                    <>
                      <PlugZap className="size-[14px]" strokeWidth={1.8} />
                      Use
                    </>
                  )}
                </button>
                {!isDefault ? (
                  <button
                    type="button"
                    className={actionButtonClass}
                    onClick={() => removeConnection(connection.id)}
                  >
                    <Trash2 className="size-[14px]" strokeWidth={1.8} />
                    Remove
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <p className="font-sans text-[12px] leading-[1.5] text-[var(--text-secondary)]">
        Saved servers live in this browser. Saving an existing URL updates its label and moves
        that connection to the active slot.
      </p>
    </div>
  );
}
