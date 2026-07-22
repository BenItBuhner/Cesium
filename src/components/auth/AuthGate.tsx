"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { LockKeyhole, LogOut, RefreshCw, Server } from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";
import { ServerConnectionsManager } from "@/components/preferences/ServerConnectionsManager";
import { ServerSetupCommand } from "@/components/preferences/ServerSetupCommand";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";

export function AuthGate({ children }: { children: ReactNode }) {
  const {
    ready,
    enabled,
    authenticated,
    session,
    loginPending,
    error,
    connectionError,
    login,
    logout,
    refreshAuthStatus,
  } = useAuth();
  const { activeServer, serverStatusById, setActiveServer } = useServerConnections();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [manageServersOpen, setManageServersOpen] = useState(false);
  const activeServerHealth = serverStatusById[activeServer.id]?.health ?? "unknown";
  const activeServerRequiresAuth = activeServerHealth === "auth_required";

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await login({ username, password, remember });
    setPassword("");
  };

  if (!ready) {
    return (
      <div className="mobile-safe-top-content flex h-dvh min-h-0 items-center justify-center overflow-y-auto overscroll-contain bg-[var(--bg-main)] px-4 py-4 max-[480px]:pl-[max(12px,env(safe-area-inset-left,0px))] max-[480px]:pr-[max(12px,env(safe-area-inset-right,0px))] sm:px-6">
        <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] px-4 py-3 font-sans text-[13px] text-[var(--text-secondary)] shadow-[var(--palette-shadow)] sm:px-5 sm:py-4">
          Checking authentication...
        </div>
      </div>
    );
  }

  if ((!enabled && !activeServerRequiresAuth && !connectionError) || authenticated) {
    return <>{children}</>;
  }

  const showConnectionIssue = Boolean(connectionError);

  return (
    <main className="mobile-safe-top-content flex h-dvh min-h-0 items-start justify-center overflow-y-auto overscroll-contain bg-[var(--bg-main)] px-3 py-4 max-[480px]:pl-[max(12px,env(safe-area-inset-left,0px))] max-[480px]:pr-[max(12px,env(safe-area-inset-right,0px))] sm:items-center sm:px-6 sm:py-10">
      <div className="w-full max-w-[560px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-4 shadow-[var(--palette-shadow)] sm:p-6">
        <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <div className="mb-2 inline-flex size-[32px] items-center justify-center rounded-[9px] border border-[var(--border-card)] bg-[var(--bg-panel)] text-[var(--text-primary)] sm:size-[36px] sm:rounded-[10px]">
              {showConnectionIssue ? (
                <Server className="size-[18px]" strokeWidth={1.8} />
              ) : (
                <LockKeyhole className="size-[18px]" strokeWidth={1.8} />
              )}
            </div>
            <h1 className="font-sans text-[18px] font-semibold leading-tight text-[var(--text-primary)] sm:text-[20px]">
              {showConnectionIssue ? "Check Cesium server" : "Sign in to Cesium"}
            </h1>
            <p className="mt-2 max-w-[46ch] font-sans text-[12.5px] leading-[1.45] text-[var(--text-secondary)] sm:text-[13px] sm:leading-[1.5]">
              {showConnectionIssue
                ? "The selected server could not be reached. Switch to another saved server or fix the current base URL, then retry."
                : "This server requires authentication before workspace files, terminals, and agent events can be accessed."}
            </p>
            <div className="mt-3 min-w-0 rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[10px] py-[8px] sm:px-[11px] sm:py-[9px]">
              <p className="truncate font-sans text-[12px] font-medium text-[var(--text-primary)]">
                {activeServer.label}
              </p>
              <p className="mt-[2px] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] text-[var(--text-secondary)]" title={activeServer.baseUrl}>
                {activeServer.baseUrl}
              </p>
            </div>
          </div>
          <div className="grid w-full grid-cols-2 gap-[8px] sm:flex sm:w-auto sm:shrink-0 sm:flex-wrap sm:justify-end">
            <button
              type="button"
              onClick={() => setManageServersOpen((current) => !current)}
              className="inline-flex h-[36px] min-w-0 items-center justify-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[10px] font-sans text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)] sm:h-[32px]"
            >
              <Server className="size-[14px]" strokeWidth={1.8} />
              <span className="truncate">{manageServersOpen ? "Hide servers" : "Servers"}</span>
            </button>
            {showConnectionIssue ? (
              <button
                type="button"
                onClick={() => void refreshAuthStatus()}
                className="inline-flex h-[36px] min-w-0 items-center justify-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[10px] font-sans text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)] sm:h-[32px]"
              >
                <RefreshCw className="size-[14px]" strokeWidth={1.8} />
                <span className="truncate">Retry</span>
              </button>
            ) : null}
            {session ? (
              <button
                type="button"
                onClick={() => void logout()}
                className="inline-flex h-[36px] min-w-0 items-center justify-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[10px] font-sans text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)] sm:h-[32px]"
              >
                <LogOut className="size-[14px]" strokeWidth={1.8} />
                <span className="truncate">Clear</span>
              </button>
            ) : null}
          </div>
        </div>

        {manageServersOpen ? (
          <div className="mb-4 max-h-[min(58vh,420px)] min-w-0 overflow-y-auto overscroll-contain rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-3 py-2">
            <ServerConnectionsManager
              compact
              onActivate={(serverId) => {
                setActiveServer(serverId);
              }}
            />
          </div>
        ) : null}

        {!showConnectionIssue ? (
          <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
            <label className="flex flex-col gap-[6px]">
              <span className="font-sans text-[12px] font-medium text-[var(--text-secondary)]">
                Username
              </span>
              <input
                type="text"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[12px] py-[10px] font-sans text-[13px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
                placeholder="Username"
                required
              />
            </label>

            <label className="flex flex-col gap-[6px]">
              <span className="font-sans text-[12px] font-medium text-[var(--text-secondary)]">
                Password
              </span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[12px] py-[10px] font-sans text-[13px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
                placeholder="Password"
                required
              />
            </label>

            <label className="mt-1 inline-flex min-w-0 items-center gap-[8px] font-sans text-[12px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
                className="size-[14px] rounded-[var(--radius-checkbox)] border border-[var(--border-card)] bg-[var(--bg-main)] accent-[var(--accent)]"
              />
              Remember this session
            </label>

            {error ? (
              <div className="rounded-[var(--radius-tab)] border border-[color-mix(in_srgb,var(--debug-accent)_28%,transparent)] bg-[color-mix(in_srgb,var(--debug-accent-bg)_82%,transparent)] px-[11px] py-[9px] font-sans text-[12px] leading-[1.45] text-[var(--text-primary)]">
                {error}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={loginPending}
              className="mt-2 inline-flex h-[42px] items-center justify-center rounded-[var(--radius-tab)] border border-[var(--accent)] bg-[var(--accent)] px-[12px] font-sans text-[13px] font-medium text-[var(--bg-main)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:text-[var(--bg-panel)] sm:h-[40px]"
            >
              {loginPending ? "Signing in..." : "Sign in"}
            </button>
          </form>
        ) : (
          <div className="flex flex-col gap-[10px]">
            <div className="rounded-[var(--radius-tab)] border border-[color-mix(in_srgb,var(--debug-accent)_28%,transparent)] bg-[color-mix(in_srgb,var(--debug-accent-bg)_82%,transparent)] px-[11px] py-[9px] font-sans text-[12px] leading-[1.45] text-[var(--text-primary)]">
              {connectionError}
            </div>
            <ServerSetupCommand compact />
          </div>
        )}
      </div>
    </main>
  );
}
