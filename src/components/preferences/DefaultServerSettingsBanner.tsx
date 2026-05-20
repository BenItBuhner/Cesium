"use client";

import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";

export function DefaultServerSettingsBanner({ className = "" }: { className?: string }) {
  const { requiresDefaultServer, setDefaultServer, servers } = useServerConnections();

  if (!requiresDefaultServer || servers.length < 2) {
    return null;
  }

  return (
    <div
      className={`rounded-[var(--radius-card)] border border-amber-500/35 bg-amber-500/10 px-[12px] py-[10px] font-sans text-[12px] leading-relaxed text-[var(--text-primary)] ${className}`}
      role="status"
    >
      <p className="font-medium">Choose a default settings server</p>
      <p className="mt-[4px] text-[var(--text-secondary)]">
        With multiple servers connected, theme, keyboard shortcuts, and model preferences are stored on
        one home server so they stay consistent when you switch chats.
      </p>
      <div className="mt-[8px] flex flex-wrap gap-[6px]">
        {servers.map((server) => (
          <button
            key={server.id}
            type="button"
            onClick={() => setDefaultServer(server.id)}
            className="rounded-[var(--radius-tab)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-[10px] py-[5px] text-[11px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]"
          >
            Use {server.label}
          </button>
        ))}
      </div>
    </div>
  );
}
