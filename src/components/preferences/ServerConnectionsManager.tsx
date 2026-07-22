"use client";

import { useCallback, useMemo, useState } from "react";
import { Check, Pencil, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import {
  setStoredSessionToken,
  syncAuthTokenFromResponse,
  updateStoredAuthSession,
  type AuthSession,
} from "@/lib/auth-client";
import { ServerSetupCommand } from "@/components/preferences/ServerSetupCommand";

const inputClass =
  "box-border h-[36px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] font-sans text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]";

const buttonClass =
  "inline-flex h-[36px] min-w-0 items-center justify-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] text-center font-sans text-[12px] leading-none text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)] disabled:cursor-not-allowed disabled:opacity-50 sm:h-[32px]";

type ProbeState = {
  status: "idle" | "running" | "ok" | "error";
  message: string | null;
};

export function ServerConnectionsManager({
  onActivate,
  onSetDefault,
  compact = false,
}: {
  onActivate?: (serverId: string) => void;
  onSetDefault?: (serverId: string) => void;
  compact?: boolean;
}) {
  const {
    activeServer,
    settingsServer,
    servers,
    onlineServers,
    serverStatusById,
    saveServer,
    removeServer,
    probeServer,
    refreshServerHealth,
  } = useServerConnections();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [probeByServerId, setProbeByServerId] = useState<Record<string, ProbeState>>({});
  const [savePending, setSavePending] = useState(false);
  const [authServerId, setAuthServerId] = useState<string | null>(null);
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authPending, setAuthPending] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

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

  const handleServerLogin = useCallback(
    async (serverId: string, candidateBaseUrl: string) => {
      setAuthPending(true);
      setAuthError(null);
      try {
        const response = await fetch(`${candidateBaseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          cache: "no-store",
          body: JSON.stringify({
            username: authUsername,
            password: authPassword,
            remember: true,
          }),
        });
        syncAuthTokenFromResponse(response, candidateBaseUrl);
        const payload = (await response.json().catch(() => ({}))) as
          | {
              authenticated?: boolean;
              session?: AuthSession | null;
              token?: string;
              error?: string;
            }
          | Record<string, never>;
        if (!response.ok || payload.authenticated !== true || !payload.session) {
          throw new Error(
            typeof payload.error === "string" ? payload.error : "Invalid username or password."
          );
        }
        if (typeof payload.token === "string" && payload.token.trim()) {
          setStoredSessionToken(payload.token, payload.session, candidateBaseUrl);
        }
        updateStoredAuthSession(payload.session, candidateBaseUrl);
        setAuthServerId(null);
        setAuthUsername("");
        setAuthPassword("");
        await refreshServerHealth();
        await runProbe(serverId, candidateBaseUrl);
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : "Sign in failed.");
      } finally {
        setAuthPending(false);
      }
    },
    [authPassword, authUsername, refreshServerHealth, runProbe]
  );

  const rows = useMemo(
    () =>
      servers.map((server) => {
        const probe = probeByServerId[server.id] ?? { status: "idle", message: null };
        const isActiveChat = server.id === activeServer.id;
        const isDefaultSettings = server.id === settingsServer?.id;
        const runtimeStatus = serverStatusById[server.id];
        const isRuntimeConnected = onlineServers.some((candidate) => candidate.id === server.id);
        return { isActiveChat, isDefaultSettings, isRuntimeConnected, probe, runtimeStatus, server };
      }),
    [
      activeServer.id,
      onlineServers,
      probeByServerId,
      serverStatusById,
      servers,
      settingsServer?.id,
    ]
  );

  return (
    <div className="min-w-0 overflow-hidden">
      <div className="flex min-w-0 flex-col gap-[12px] sm:gap-[14px]">
        {rows.length > 0 ? (
          <div className="flex min-w-0 flex-col">
            {rows.map(({ isActiveChat, isDefaultSettings, isRuntimeConnected, probe, runtimeStatus, server }, index) => (
              <div
                key={server.id}
                className={`flex min-w-0 flex-col gap-[10px] py-[10px] sm:py-[12px] ${
                  index < rows.length - 1 ? "border-b border-[var(--border-subtle)]" : ""
                }`}
              >
            <div
              className={
                compact
                  ? "flex min-w-0 flex-col gap-[9px]"
                  : "flex min-w-0 flex-col gap-[9px] sm:flex-row sm:items-start sm:justify-between sm:gap-[12px]"
              }
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-[6px] sm:gap-[8px]">
                  <p className="min-w-0 max-w-full truncate font-sans text-[13px] font-medium text-[var(--text-primary)]">
                    {server.label}
                  </p>
                  {isDefaultSettings ? (
                    <span className="shrink-0 rounded-[999px] bg-[var(--accent-bg)] px-[8px] py-[2px] font-sans text-[11px] text-[var(--text-primary)]">
                      Default settings
                    </span>
                  ) : null}
                  {isActiveChat ? (
                    <span className="shrink-0 rounded-[999px] border border-[var(--border-subtle)] px-[8px] py-[2px] font-sans text-[11px] text-[var(--text-secondary)]">
                      Active chat
                    </span>
                  ) : null}
                  {isRuntimeConnected ? (
                    <span className="shrink-0 rounded-[999px] border border-[var(--border-subtle)] px-[8px] py-[2px] font-sans text-[11px] text-[var(--text-secondary)]">
                      {runtimeStatus?.health === "auth_required" ? "Auth needed" : "Connected"}
                    </span>
                  ) : runtimeStatus?.health === "offline" ? (
                    <span className="shrink-0 rounded-[999px] border border-[var(--border-subtle)] px-[8px] py-[2px] font-sans text-[11px] text-[var(--text-disabled)]">
                      Offline
                    </span>
                  ) : null}
                </div>
                <p className="mt-[4px] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] text-[var(--text-secondary)]" title={server.baseUrl}>
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
              <div
                className={
                  compact
                    ? "grid w-full grid-cols-2 gap-[8px]"
                    : "grid w-full grid-cols-2 gap-[8px] sm:flex sm:w-auto sm:shrink-0 sm:flex-wrap sm:justify-end"
                }
              >
                {onSetDefault ? (
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={isDefaultSettings}
                    onClick={() => onSetDefault(server.id)}
                  >
                    <Check className="size-[14px]" strokeWidth={1.5} aria-hidden />
                    {isDefaultSettings ? "Default" : "Set default"}
                  </button>
                ) : null}
                {onActivate ? (
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={isActiveChat}
                    onClick={() => onActivate(server.id)}
                  >
                    <Check className="size-[14px]" strokeWidth={1.5} aria-hidden />
                    {onSetDefault
                      ? isActiveChat
                        ? "Active chat"
                        : "Use for chats"
                      : isActiveChat
                        ? "Selected"
                        : "Use for settings"}
                  </button>
                ) : null}
                {runtimeStatus?.health === "auth_required" ? (
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => {
                      setAuthServerId((current) => (current === server.id ? null : server.id));
                      setAuthError(null);
                    }}
                  >
                    Sign in
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
            {authServerId === server.id ? (
              <form
                className={`grid gap-[8px] rounded-[var(--radius-tab)] border border-[var(--border-subtle)] bg-[var(--bg-main)] p-[10px] ${
                  compact ? "grid-cols-1" : "grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
                }`}
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleServerLogin(server.id, server.baseUrl);
                }}
              >
                <input
                  type="text"
                  value={authUsername}
                  onChange={(event) => setAuthUsername(event.target.value)}
                  placeholder="Username"
                  autoComplete="username"
                  className={inputClass}
                  required
                />
                <input
                  type="password"
                  value={authPassword}
                  onChange={(event) => setAuthPassword(event.target.value)}
                  placeholder="Password"
                  autoComplete="current-password"
                  className={inputClass}
                  required
                />
                <button type="submit" className={buttonClass} disabled={authPending}>
                  {authPending ? "Signing in..." : "Sign in"}
                </button>
                {authError ? (
                  <p className="font-sans text-[11px] text-[var(--debug-accent)] md:col-span-3">
                    {authError}
                  </p>
                ) : null}
              </form>
            ) : null}
            </div>
          ))}
          </div>
        ) : null}
        <button
          type="button"
          className={`${buttonClass} w-full sm:w-auto`}
          onClick={() => void refreshServerHealth()}
        >
          <RefreshCw className="size-[14px]" strokeWidth={1.5} aria-hidden />
          Refresh all server status
        </button>

        <ServerSetupCommand compact={compact} />

        <div className="border-t border-[var(--border-subtle)] pt-[16px]">
        <div className="mb-[10px] flex items-center gap-[8px] px-[2px]">
          <Server className="size-[15px] text-[var(--text-secondary)]" strokeWidth={1.6} />
          <h3 className="font-sans text-[15px] font-semibold text-[var(--text-primary)]">
            {isEditing ? "Edit server" : "Add server"}
          </h3>
        </div>
        <div className={`grid min-w-0 gap-[10px] ${compact ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2"}`}>
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
        <div className="mt-[12px] grid grid-cols-2 gap-[8px] sm:flex sm:flex-wrap">
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
    </div>
  );
}
