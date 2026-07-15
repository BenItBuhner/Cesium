"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import type {
  McpAuthConfig,
  McpPresetDefinition,
  McpServerPublic,
  McpTransportKind,
} from "@/lib/mcp-types";
import {
  deleteMcpServer,
  fetchMcpPresets,
  fetchMcpServers,
  refreshMcpServerMirror,
  setBuiltInMcpServerEnabled,
  startMcpOAuth,
  testMcpServerConnection,
  upsertMcpServer,
} from "@/lib/server-api";
import { SettingsRow, SettingsSection, rowButtonClass } from "./settings-ui";

function statusLabel(server: McpServerPublic): string {
  const status = server.connectionStatus;
  if (!status) return "Unknown";
  if (status.needsAuth) return "Needs authentication";
  if (status.connected) {
    return status.toolCount != null
      ? `Connected · ${status.toolCount} tools`
      : "Connected";
  }
  if (status.error) return status.error;
  return "Disconnected";
}

export function McpServersSettingsPanel() {
  const { activeWorkspaceId } = useWorkspace();
  const [servers, setServers] = useState<McpServerPublic[]>([]);
  const [presets, setPresets] = useState<McpPresetDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customLabel, setCustomLabel] = useState("");
  const [customTransport, setCustomTransport] = useState<McpTransportKind>("streamable-http");
  const [customCommand, setCustomCommand] = useState("npx");
  const [customArgs, setCustomArgs] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customAuth, setCustomAuth] = useState<McpAuthConfig["kind"]>("none");
  const [customBearer, setCustomBearer] = useState("");

  const reload = useCallback(async () => {
    if (!activeWorkspaceId) {
      setServers([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextServers, nextPresets] = await Promise.all([
        fetchMcpServers(activeWorkspaceId),
        fetchMcpPresets(),
      ]);
      setServers(nextServers);
      setPresets(nextPresets);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [activeWorkspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "opencursor-mcp-oauth") {
        void reload();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [reload]);

  const addPreset = async (preset: McpPresetDefinition) => {
    if (!activeWorkspaceId) return;
    setBusyId(preset.presetId);
    try {
      await upsertMcpServer(activeWorkspaceId, { presetId: preset.presetId });
      await reload();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusyId(null);
    }
  };

  const testServer = async (serverId: string) => {
    if (!activeWorkspaceId) return;
    setBusyId(serverId);
    try {
      await testMcpServerConnection(activeWorkspaceId, serverId);
      await reload();
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : String(testError));
    } finally {
      setBusyId(null);
    }
  };

  const refreshServer = async (serverId: string) => {
    if (!activeWorkspaceId) return;
    setBusyId(serverId);
    try {
      await refreshMcpServerMirror(activeWorkspaceId, serverId);
      await reload();
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      setBusyId(null);
    }
  };

  const removeServer = async (serverId: string) => {
    if (!activeWorkspaceId) return;
    setBusyId(serverId);
    try {
      await deleteMcpServer(activeWorkspaceId, serverId);
      await reload();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setBusyId(null);
    }
  };

  const toggleBuiltInServer = async (server: McpServerPublic) => {
    if (!activeWorkspaceId) return;
    setBusyId(server.id);
    try {
      await setBuiltInMcpServerEnabled(activeWorkspaceId, server.id, !server.enabled);
      await reload();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError));
    } finally {
      setBusyId(null);
    }
  };

  const addCustomServer = async () => {
    if (!activeWorkspaceId || !customLabel.trim()) return;
    setBusyId("__custom__");
    setError(null);
    try {
      const isStdio = customTransport === "stdio";
      const auth: McpAuthConfig =
        customAuth === "bearer"
          ? { kind: "bearer", secretId: "bearer" }
          : customAuth === "oauth"
            ? { kind: "oauth" }
            : { kind: "none" };
      await upsertMcpServer(activeWorkspaceId, {
        server: {
          label: customLabel.trim(),
          enabled: true,
          transport: customTransport,
          ...(isStdio
            ? {
                stdio: {
                  command: customCommand.trim() || "npx",
                  args: customArgs
                    .split(/\s+/)
                    .map((part) => part.trim())
                    .filter(Boolean),
                },
              }
            : {
                remote: { url: customUrl.trim() },
              }),
          auth,
        },
        secretValues:
          customAuth === "bearer" && customBearer.trim()
            ? { bearer: customBearer.trim() }
            : undefined,
      });
      setShowCustomForm(false);
      setCustomLabel("");
      setCustomUrl("");
      setCustomArgs("");
      setCustomBearer("");
      await reload();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusyId(null);
    }
  };

  const authenticate = async (serverId: string) => {
    if (!activeWorkspaceId) return;
    setBusyId(serverId);
    try {
      const { authorizationUrl } = await startMcpOAuth(activeWorkspaceId, serverId);
      window.open(authorizationUrl, "_blank", "noopener,noreferrer,width=520,height=720");
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : String(authError));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      {error ? (
        <p className="mb-[12px] px-[2px] font-sans text-[12px] text-[var(--error-fg)]">{error}</p>
      ) : null}

      <SettingsSection
        title="Presets"
        action={
          <button type="button" className={rowButtonClass} onClick={() => void reload()}>
            <RefreshCw className="size-[14px]" strokeWidth={1.5} />
            Reload
          </button>
        }
      >
        <div className="divide-y divide-[var(--border-subtle)]">
          {presets.map((preset) => (
            <div
              key={preset.presetId}
              className="flex items-center justify-between gap-[12px] px-[16px] py-[12px]"
            >
              <div className="min-w-0">
                <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
                  {preset.label}
                </p>
                <p className="mt-[4px] font-sans text-[12px] text-[var(--text-secondary)]">
                  {preset.description}
                </p>
              </div>
              <button
                type="button"
                className={rowButtonClass}
                disabled={!activeWorkspaceId || busyId === preset.presetId}
                onClick={() => void addPreset(preset)}
              >
                <Plus className="size-[14px]" strokeWidth={1.5} />
                Add
              </button>
            </div>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Custom server"
        action={
          <button
            type="button"
            className={rowButtonClass}
            onClick={() => setShowCustomForm((open) => !open)}
          >
            {showCustomForm ? "Cancel" : "Add custom"}
          </button>
        }
      >
        {showCustomForm ? (
          <div className="space-y-[10px] px-[16px] py-[12px]">
            <label className="block font-sans text-[12px] text-[var(--text-secondary)]">
              Label
              <input
                className="mt-[4px] w-full rounded-[6px] border border-[var(--border-subtle)] bg-transparent px-[8px] py-[6px] font-sans text-[13px] text-[var(--text-primary)]"
                value={customLabel}
                onChange={(event) => setCustomLabel(event.target.value)}
                placeholder="My MCP server"
              />
            </label>
            <label className="block font-sans text-[12px] text-[var(--text-secondary)]">
              Transport
              <select
                className="mt-[4px] w-full rounded-[6px] border border-[var(--border-subtle)] bg-transparent px-[8px] py-[6px] font-sans text-[13px] text-[var(--text-primary)]"
                value={customTransport}
                onChange={(event) =>
                  setCustomTransport(event.target.value as McpTransportKind)
                }
              >
                <option value="streamable-http">Streamable HTTP</option>
                <option value="sse">Legacy SSE</option>
                <option value="stdio">stdio</option>
              </select>
            </label>
            {customTransport === "stdio" ? (
              <>
                <label className="block font-sans text-[12px] text-[var(--text-secondary)]">
                  Command
                  <input
                    className="mt-[4px] w-full rounded-[6px] border border-[var(--border-subtle)] bg-transparent px-[8px] py-[6px] font-sans text-[13px]"
                    value={customCommand}
                    onChange={(event) => setCustomCommand(event.target.value)}
                  />
                </label>
                <label className="block font-sans text-[12px] text-[var(--text-secondary)]">
                  Args (space-separated)
                  <input
                    className="mt-[4px] w-full rounded-[6px] border border-[var(--border-subtle)] bg-transparent px-[8px] py-[6px] font-sans text-[13px]"
                    value={customArgs}
                    onChange={(event) => setCustomArgs(event.target.value)}
                    placeholder="-y @modelcontextprotocol/server-everything"
                  />
                </label>
              </>
            ) : (
              <label className="block font-sans text-[12px] text-[var(--text-secondary)]">
                URL
                <input
                  className="mt-[4px] w-full rounded-[6px] border border-[var(--border-subtle)] bg-transparent px-[8px] py-[6px] font-sans text-[13px]"
                  value={customUrl}
                  onChange={(event) => setCustomUrl(event.target.value)}
                  placeholder="https://example.com/mcp"
                />
              </label>
            )}
            <label className="block font-sans text-[12px] text-[var(--text-secondary)]">
              Authentication
              <select
                className="mt-[4px] w-full rounded-[6px] border border-[var(--border-subtle)] bg-transparent px-[8px] py-[6px] font-sans text-[13px]"
                value={customAuth}
                onChange={(event) =>
                  setCustomAuth(event.target.value as McpAuthConfig["kind"])
                }
              >
                <option value="none">None</option>
                <option value="bearer">Bearer token</option>
                <option value="oauth">OAuth (configure client id after save)</option>
              </select>
            </label>
            {customAuth === "bearer" ? (
              <label className="block font-sans text-[12px] text-[var(--text-secondary)]">
                Bearer token
                <input
                  type="password"
                  className="mt-[4px] w-full rounded-[6px] border border-[var(--border-subtle)] bg-transparent px-[8px] py-[6px] font-sans text-[13px]"
                  value={customBearer}
                  onChange={(event) => setCustomBearer(event.target.value)}
                />
              </label>
            ) : null}
            <button
              type="button"
              className={rowButtonClass}
              disabled={!activeWorkspaceId || !customLabel.trim() || busyId === "__custom__"}
              onClick={() => void addCustomServer()}
            >
              Save server
            </button>
          </div>
        ) : (
          <p className="px-[16px] py-[12px] font-sans text-[12px] text-[var(--text-secondary)]">
            Add a manual MCP server when no preset matches your setup.
          </p>
        )}
      </SettingsSection>

      <SettingsSection title="Connected servers">
        {loading ? (
          <p className="px-[16px] py-[16px] font-sans text-[13px] text-[var(--text-secondary)]">
            Loading…
          </p>
        ) : servers.length === 0 ? (
          <p className="px-[16px] py-[16px] font-sans text-[13px] text-[var(--text-secondary)]">
            No MCP servers configured for this workspace yet.
          </p>
        ) : (
          servers.map((server) => (
            <SettingsRow
              key={server.id}
              title={server.label}
              description={`${server.builtIn ? "Built-in" : server.transport} · ${statusLabel(server)} · mcp-servers/${server.id}/`}
              trailing={
                <div className="flex flex-wrap items-center justify-end gap-[6px]">
                  {server.builtIn ? (
                    <button
                      type="button"
                      className={rowButtonClass}
                      disabled={busyId === server.id}
                      onClick={() => void toggleBuiltInServer(server)}
                    >
                      {server.enabled ? "Disable" : "Enable"}
                    </button>
                  ) : null}
                  {server.auth.kind === "oauth" ? (
                    <button
                      type="button"
                      className={rowButtonClass}
                      disabled={busyId === server.id}
                      onClick={() => void authenticate(server.id)}
                    >
                      Sign in
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={rowButtonClass}
                    disabled={busyId === server.id}
                    onClick={() => void testServer(server.id)}
                  >
                    Test
                  </button>
                  <button
                    type="button"
                    className={rowButtonClass}
                    disabled={busyId === server.id}
                    onClick={() => void refreshServer(server.id)}
                  >
                    Refresh
                  </button>
                  {server.removable !== false ? (
                    <button
                      type="button"
                      className={rowButtonClass}
                      disabled={busyId === server.id}
                      onClick={() => void removeServer(server.id)}
                    >
                      <Trash2 className="size-[14px]" strokeWidth={1.5} />
                    </button>
                  ) : null}
                </div>
              }
            />
          ))
        )}
      </SettingsSection>
    </>
  );
}
