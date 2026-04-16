"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { Check, ChevronDown, LockKeyhole, LogOut, Plus, Server, Trash2 } from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useServerConnections } from "@/components/server/ServerConnectionsProvider";
import { HardwareAwareTextInput } from "@/components/input/HardwareAwareTextField";

export function AuthGate({ children }: { children: ReactNode }) {
  const { ready, enabled, authenticated, session, loginPending, error, login, logout } =
    useAuth();
  const {
    activeServer,
    activeRequestBaseUrl,
    defaultServerBaseUrl,
    servers,
    activateServer,
    saveServer,
    removeServer,
  } = useServerConnections();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [newServerUrl, setNewServerUrl] = useState("");
  const [newServerName, setNewServerName] = useState("");
  const [serverPickerOpen, setServerPickerOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await login({ username, password, remember });
    setPassword("");
  };

  const handleAddServer = () => {
    try {
      const saved = saveServer({
        baseUrl: newServerUrl,
        name: newServerName,
        activate: true,
      });
      setNewServerUrl("");
      setNewServerName("");
      setServerPickerOpen(false);
      setServerError(null);
      setUsername("");
      setPassword("");
      setRemember(true);
      if (saved.id !== activeServer.id) {
        setServerError(null);
      }
    } catch (nextError) {
      setServerError(nextError instanceof Error ? nextError.message : "Could not save server.");
    }
  };

  const handleActivateServer = (serverId: string) => {
    activateServer(serverId);
    setServerPickerOpen(false);
    setServerError(null);
    setUsername("");
    setPassword("");
    setRemember(true);
  };

  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[var(--bg-main)] px-6">
        <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] px-5 py-4 font-sans text-[13px] text-[var(--text-secondary)] shadow-[var(--palette-shadow)]">
          Checking authentication...
        </div>
      </div>
    );
  }

  if (!enabled || authenticated) {
    return <>{children}</>;
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--bg-main)] px-6 py-10">
      <div className="w-full max-w-[420px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-6 shadow-[var(--palette-shadow)]">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-2 inline-flex size-[36px] items-center justify-center rounded-[10px] border border-[var(--border-card)] bg-[var(--bg-panel)] text-[var(--text-primary)]">
              <LockKeyhole className="size-[18px]" strokeWidth={1.8} />
            </div>
            <h1 className="font-sans text-[20px] font-semibold text-[var(--text-primary)]">
              Sign in to OpenCursor
            </h1>
            <p className="mt-2 font-sans text-[13px] leading-[1.5] text-[var(--text-secondary)]">
              This server requires authentication before workspace files, terminals, and agent
              events can be accessed.
            </p>
          </div>
          {session ? (
            <button
              type="button"
              onClick={() => void logout()}
              className="inline-flex h-[32px] shrink-0 items-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[10px] font-sans text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
            >
              <LogOut className="size-[14px]" strokeWidth={1.8} />
              Clear
            </button>
          ) : null}
        </div>

        <div className="mb-4 rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-[6px] font-sans text-[12px] font-medium text-[var(--text-primary)]">
                <Server className="size-[14px]" strokeWidth={1.8} />
                Connected server
              </p>
              <p className="mt-1 truncate font-mono text-[12px] text-[var(--text-primary)]">
                {activeServer.name}
              </p>
              <p className="mt-[2px] break-all font-mono text-[11px] text-[var(--text-secondary)]">
                {activeRequestBaseUrl}
              </p>
              {activeServer.baseUrl !== defaultServerBaseUrl ? (
                <p className="mt-[6px] font-sans text-[11px] text-[var(--text-secondary)]">
                  Default server: <span className="font-mono">{defaultServerBaseUrl}</span>
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setServerPickerOpen((current) => !current)}
              className="inline-flex h-[32px] shrink-0 items-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] font-sans text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
              aria-expanded={serverPickerOpen}
            >
              Switch
              <ChevronDown className="size-[14px]" strokeWidth={1.8} />
            </button>
          </div>

          {serverPickerOpen ? (
            <div className="mt-3 space-y-3 border-t border-[var(--border-subtle)] pt-3">
              <div className="space-y-2">
                {servers.map((server) => {
                  const isActive = server.id === activeServer.id;
                  return (
                    <div
                      key={server.id}
                      className="flex items-start gap-2 rounded-[var(--radius-tab)] border border-[var(--border-subtle)] bg-[var(--bg-main)] p-2"
                    >
                      <button
                        type="button"
                        onClick={() => handleActivateServer(server.id)}
                        className={`flex min-w-0 flex-1 items-start justify-between gap-2 rounded-[var(--radius-tab)] px-[2px] py-[1px] text-left ${
                          isActive
                            ? "text-[var(--text-primary)]"
                            : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-sans text-[12px] font-medium">
                            {server.name}
                          </span>
                          <span className="mt-[2px] block break-all font-mono text-[11px]">
                            {server.baseUrl}
                          </span>
                        </span>
                        {isActive ? (
                          <Check className="mt-[2px] size-[14px] shrink-0 text-[var(--accent)]" strokeWidth={2} />
                        ) : null}
                      </button>
                      {servers.length > 1 && !isActive ? (
                        <button
                          type="button"
                          onClick={() => removeServer(server.id)}
                          className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--debug-accent)]"
                          aria-label={`Remove ${server.name}`}
                          title={`Remove ${server.name}`}
                        >
                          <Trash2 className="size-[13px]" strokeWidth={1.8} />
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              <div className="rounded-[var(--radius-tab)] border border-[var(--border-subtle)] bg-[var(--bg-main)] p-3">
                <p className="mb-2 flex items-center gap-[6px] font-sans text-[12px] font-medium text-[var(--text-primary)]">
                  <Plus className="size-[13px]" strokeWidth={1.8} />
                  Add server
                </p>
                <div className="space-y-2">
                  <HardwareAwareTextInput
                    value={newServerUrl}
                    onChange={setNewServerUrl}
                    placeholder="http://localhost:9100"
                    className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[10px] py-[8px] font-mono text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
                    ariaLabel="Server base URL"
                  />
                  <HardwareAwareTextInput
                    value={newServerName}
                    onChange={setNewServerName}
                    placeholder="Optional display name"
                    className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[10px] py-[8px] font-sans text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
                    ariaLabel="Server display name"
                  />
                  <button
                    type="button"
                    onClick={handleAddServer}
                    className="inline-flex h-[34px] items-center justify-center rounded-[var(--radius-tab)] border border-[var(--accent)] bg-[var(--accent)] px-[12px] font-sans text-[12px] font-medium text-[var(--bg-main)] transition-opacity hover:opacity-90 dark:text-[var(--bg-panel)]"
                  >
                    Save and switch
                  </button>
                </div>
              </div>

              {serverError ? (
                <div className="rounded-[var(--radius-tab)] border border-[color-mix(in_srgb,var(--debug-accent)_28%,transparent)] bg-[color-mix(in_srgb,var(--debug-accent-bg)_82%,transparent)] px-[11px] py-[9px] font-sans text-[12px] leading-[1.45] text-[var(--text-primary)]">
                  {serverError}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

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

          <label className="mt-1 inline-flex items-center gap-[8px] font-sans text-[12px] text-[var(--text-secondary)]">
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
            className="mt-2 inline-flex h-[40px] items-center justify-center rounded-[var(--radius-tab)] border border-[var(--accent)] bg-[var(--accent)] px-[12px] font-sans text-[13px] font-medium text-[var(--bg-main)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:text-[var(--bg-panel)]"
          >
            {loginPending ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
