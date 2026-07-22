"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Database, Search } from "lucide-react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  createCustomAgentPlugin,
  discoverAgentPlugins,
  fetchAgentPluginHarnessCapabilities,
  fetchAgentPlugins,
  installAgentPlugin,
  setAgentPluginEnabled,
  setAgentPluginHarnessOverride,
  verifyAgentPlugins,
} from "@/lib/server-api";
import type {
  AgentPluginDefinition,
  AgentPluginDiscoveryResult,
  AgentPluginHarnessCapability,
  AgentPluginPublic,
  AgentPluginVerificationReport,
} from "@/lib/plugin-types";
import {
  HARNESS_LABELS,
  HARNESS_ORDER,
} from "@/components/editor/agent-harness-settings";
import { McpServersSettingsPanel } from "@/components/editor/mcp-servers-settings";
import {
  SettingsBlock,
  SettingsBreadcrumbs,
  SettingsCallout,
  SettingsLinkRow,
  SettingsSection,
  rowButtonClass,
} from "@/components/editor/settings-ui";
import { AgentBackendIcon } from "@/components/chat/AgentBackendIcon";
import type { AgentBackendId } from "@/lib/agent-types";
import { shortcutInputClass } from "./shared";

export function usePluginsMcpNavigation() {
  const { workspaceSession, updateWorkspaceSession } = useWorkspace();

  const mcpsOpen = workspaceSession.settingsView.mcpsOpen === true;

  const openMcpServers = useCallback(() => {
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: {
        ...current.settingsView,
        activeNav: "plugins",
        mcpsOpen: true,
      },
    }));
  }, [updateWorkspaceSession]);

  const closeMcpServers = useCallback(() => {
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: {
        ...current.settingsView,
        mcpsOpen: false,
      },
    }));
  }, [updateWorkspaceSession]);

  const openRulesSkills = useCallback(() => {
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: {
        ...current.settingsView,
        activeNav: "rulesSkills",
        mcpsOpen: false,
      },
    }));
  }, [updateWorkspaceSession]);

  return { mcpsOpen, openMcpServers, closeMcpServers, openRulesSkills };
}

function PluginIcon({ iconUrl, size = 18 }: { iconUrl?: string; size?: number }) {
  const sizeClass = size === 16 ? "size-[16px]" : "size-[18px]";
  return iconUrl ? (
    <img alt="" src={iconUrl} className={`${sizeClass} rounded-[4px]`} />
  ) : (
    <Database className={`${sizeClass} text-[var(--text-secondary)]`} strokeWidth={1.5} />
  );
}

function InstalledPluginBlock({
  plugin,
  capabilityById,
  workspaceId,
  pendingAction,
  onRunAction,
}: {
  plugin: AgentPluginPublic;
  capabilityById: Map<AgentBackendId, AgentPluginHarnessCapability>;
  workspaceId: string | null;
  pendingAction: string | null;
  onRunAction: (actionId: string, action: () => Promise<AgentPluginPublic[]>) => Promise<void>;
}) {
  const installed = Boolean(plugin.install);
  const enabled = plugin.enabled;
  const limitedHarnesses = HARNESS_ORDER.filter((backendId) => {
    const capability = capabilityById.get(backendId);
    const pluginSupport = plugin.definition.harnesses?.[backendId];
    const nativeMcp = pluginSupport?.nativeMcp ?? capability?.nativeMcp ?? true;
    return plugin.definition.mcp.length > 0 && !nativeMcp;
  });

  return (
    <SettingsBlock>
      <div className="flex items-start justify-between gap-[12px]">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-[8px]">
            <PluginIcon iconUrl={plugin.definition.iconUrl} />
            <span className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
              {plugin.definition.displayName}
            </span>
            <span className="rounded-full bg-[var(--accent-bg)] px-[7px] py-[2px] font-sans text-[10px] uppercase tracking-[0.08em] text-[var(--accent)]">
              {enabled ? "Enabled" : installed ? "Installed" : "Catalog"}
            </span>
          </div>
          <p className="mt-[6px] font-sans text-[12px] leading-[18px] text-[var(--text-secondary)]">
            {plugin.definition.description}
          </p>
          <div className="mt-[6px] flex flex-wrap gap-[6px] font-sans text-[11px] text-[var(--text-secondary)]">
            <span>{plugin.definition.skills.length} skill(s)</span>
            <span>{plugin.definition.mcp.length} MCP contribution(s)</span>
            {plugin.managedMcpServerIds.length > 0 ? (
              <span>MCP: {plugin.managedMcpServerIds.join(", ")}</span>
            ) : null}
          </div>
          {installed && limitedHarnesses.length > 0 ? (
            <SettingsCallout tone="warning" className="mt-[8px] text-[11px] leading-[16px]">
              MCP tools will not work natively on{" "}
              {limitedHarnesses.map((id) => HARNESS_LABELS[id] ?? id).join(", ")}. Skills still
              sync via prompt guidance.
            </SettingsCallout>
          ) : null}
        </div>
        <button
          type="button"
          className={rowButtonClass}
          disabled={pendingAction !== null || !workspaceId}
          onClick={() =>
            void onRunAction(plugin.definition.pluginId, () =>
              installed
                ? setAgentPluginEnabled(workspaceId!, plugin.definition.pluginId, !enabled)
                : installAgentPlugin(workspaceId!, plugin.definition.pluginId)
            )
          }
        >
          {pendingAction === plugin.definition.pluginId
            ? "Working..."
            : installed
              ? enabled
                ? "Disable"
                : "Enable"
              : "Install"}
        </button>
      </div>
      {installed ? (
        <div className="mt-[12px] grid gap-[6px] sm:grid-cols-2">
          {HARNESS_ORDER.map((backendId) => {
            const override = plugin.install?.harnessOverrides.find(
              (entry) => entry.backendId === backendId
            );
            const harnessEnabled = override?.enabled ?? plugin.enabled;
            const capability = capabilityById.get(backendId);
            const pluginSupport = plugin.definition.harnesses?.[backendId];
            const nativeMcp = pluginSupport?.nativeMcp ?? capability?.nativeMcp ?? true;
            const limited = plugin.definition.mcp.length > 0 && !nativeMcp;
            return (
              <button
                key={backendId}
                type="button"
                title={
                  limited
                    ? pluginSupport?.notes ??
                      capability?.notes ??
                      "This harness does not support native plugin MCP."
                    : capability?.notes
                }
                className={`flex items-center justify-between rounded-[var(--radius-tab)] border border-[var(--border-subtle)] px-[9px] py-[7px] font-sans text-[11px] hover:bg-[var(--accent-bg)] ${
                  limited
                    ? "text-[#b45309] dark:text-[#fbbf24]"
                    : "text-[var(--text-secondary)]"
                }`}
                disabled={pendingAction !== null || !workspaceId}
                onClick={() =>
                  void onRunAction(`${plugin.definition.pluginId}:${backendId}`, () =>
                    setAgentPluginHarnessOverride(
                      workspaceId!,
                      plugin.definition.pluginId,
                      backendId,
                      !harnessEnabled
                    )
                  )
                }
              >
                <span className="flex items-center gap-[6px]">
                  <AgentBackendIcon backendId={backendId} className="size-[13px]" />
                  {HARNESS_LABELS[backendId] ?? backendId}
                  {limited ? (
                    <AlertTriangle className="size-[11px]" strokeWidth={1.75} />
                  ) : null}
                </span>
                <span>{harnessEnabled ? "On" : "Off"}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </SettingsBlock>
  );
}

function VerificationReportBlock({
  verification,
}: {
  verification: AgentPluginVerificationReport;
}) {
  return (
    <SettingsBlock>
      <p className="font-sans text-[12px] font-medium text-[var(--text-primary)]">
        Harness verification
      </p>
      <p className="mt-[4px] font-sans text-[11px] leading-[16px] text-[var(--text-secondary)]">
        {verification.enabledPluginCount} enabled plugin(s) identified by{" "}
        {verification.summary.identifyingPlugins.length}/{verification.harnesses.length}{" "}
        harnesses. Prompt-only MCP:{" "}
        {verification.summary.promptOnlyMcp
          .map((id) => HARNESS_LABELS[id] ?? id)
          .join(", ") || "none"}
        .
      </p>
      <ul className="mt-[8px] divide-y divide-[var(--border-subtle)]">
        {verification.harnesses.map((harness) => (
          <li key={harness.backendId} className="py-[7px]">
            <div className="flex items-center justify-between gap-[8px]">
              <span className="flex items-center gap-[6px] font-sans text-[11px] text-[var(--text-primary)]">
                <AgentBackendIcon backendId={harness.backendId} className="size-[13px]" />
                {HARNESS_LABELS[harness.backendId] ?? harness.backendId}
              </span>
              <span className="font-sans text-[10px] uppercase tracking-[0.06em] text-[var(--text-secondary)]">
                {harness.identified ? "Identified" : "Idle"}
              </span>
            </div>
            <div className="mt-[3px] font-sans text-[10px] text-[var(--text-secondary)]">
              {harness.skillCount} skill(s) ·{" "}
              {harness.nativeMcp
                ? `${harness.nativeMcpServerIds.length} native MCP`
                : "prompt-only MCP"}
            </div>
            {harness.warnings[0] ? (
              <SettingsCallout tone="warning" className="mt-[3px] text-[10px] leading-[14px]">
                {harness.warnings[0].reason}
              </SettingsCallout>
            ) : null}
          </li>
        ))}
      </ul>
    </SettingsBlock>
  );
}

export function PluginsSettingsPanel() {
  const { mcpsOpen, openMcpServers, closeMcpServers, openRulesSkills } =
    usePluginsMcpNavigation();
  const { workspaceInfo } = useWorkspace();
  const [plugins, setPlugins] = useState<AgentPluginPublic[]>([]);
  const [capabilities, setCapabilities] = useState<AgentPluginHarnessCapability[]>([]);
  const [discovery, setDiscovery] = useState<AgentPluginDiscoveryResult | null>(null);
  const [discoveryQuery, setDiscoveryQuery] = useState("");
  const [verification, setVerification] = useState<AgentPluginVerificationReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customName, setCustomName] = useState("");
  const [customSkill, setCustomSkill] = useState("");
  const [customMcpUrl, setCustomMcpUrl] = useState("");

  const workspaceId = workspaceInfo?.id ?? null;

  const capabilityById = useMemo(() => {
    const map = new Map<AgentBackendId, AgentPluginHarnessCapability>();
    for (const capability of capabilities) {
      map.set(capability.backendId, capability);
    }
    return map;
  }, [capabilities]);

  const promptOnlyHarnesses = useMemo(
    () => capabilities.filter((capability) => !capability.nativeMcp),
    [capabilities]
  );

  const refreshPlugins = useCallback(async () => {
    if (!workspaceId) {
      setPlugins([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextPlugins, nextCapabilities] = await Promise.all([
        fetchAgentPlugins(workspaceId),
        fetchAgentPluginHarnessCapabilities(),
      ]);
      setPlugins(nextPlugins);
      setCapabilities(nextCapabilities);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load plugins.");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  const refreshDiscovery = useCallback(async (query = discoveryQuery) => {
    setDiscovering(true);
    try {
      setDiscovery(await discoverAgentPlugins(query));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to discover plugins.");
    } finally {
      setDiscovering(false);
    }
  }, [discoveryQuery]);

  useEffect(() => {
    void refreshPlugins();
  }, [refreshPlugins]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setDiscovering(true);
      try {
        const result = await discoverAgentPlugins("");
        if (!cancelled) setDiscovery(result);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to discover plugins.");
        }
      } finally {
        if (!cancelled) setDiscovering(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runPluginAction = useCallback(
    async (actionId: string, action: () => Promise<AgentPluginPublic[]>) => {
      if (!workspaceId) return;
      setPendingAction(actionId);
      setError(null);
      try {
        setPlugins(await action());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Plugin action failed.");
      } finally {
        setPendingAction(null);
      }
    },
    [workspaceId]
  );

  const runVerify = useCallback(async () => {
    if (!workspaceId) return;
    setVerifying(true);
    setError(null);
    try {
      setVerification(await verifyAgentPlugins(workspaceId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to verify plugin harness sync.");
    } finally {
      setVerifying(false);
    }
  }, [workspaceId]);

  const createCustomPlugin = useCallback(async () => {
    if (!workspaceId || !customName.trim()) return;
    const pluginId = customName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const definition: AgentPluginDefinition = {
      schemaVersion: 1,
      pluginId: pluginId || "custom-plugin",
      displayName: customName.trim(),
      description: "Custom workspace plugin",
      mcp: customMcpUrl.trim()
        ? [
            {
              id: "custom-mcp",
              server: {
                label: customName.trim(),
                transport: "streamable-http",
                remote: { url: customMcpUrl.trim() },
                auth: { kind: "none" },
                summary: `${customName.trim()} custom MCP server`,
              },
            },
          ]
        : [],
      skills: customSkill.trim()
        ? [
            {
              id: "custom-skill",
              title: `${customName.trim()} skill`,
              description: "Custom plugin skill instructions",
              body: customSkill.trim(),
            },
          ]
        : [],
    };
    await runPluginAction("custom:create", async () => {
      const next = await createCustomAgentPlugin(workspaceId, definition);
      setCustomName("");
      setCustomSkill("");
      setCustomMcpUrl("");
      return next;
    });
  }, [customMcpUrl, customName, customSkill, runPluginAction, workspaceId]);

  const uninstalledDiscoveryEntries = useMemo(
    () =>
      (discovery?.plugins ?? []).filter(
        (entry) =>
          !plugins.some(
            (plugin) =>
              plugin.definition.pluginId === entry.definition.pluginId && plugin.install
          )
      ),
    [discovery, plugins]
  );

  if (mcpsOpen) {
    return (
      <>
        <SettingsBreadcrumbs
          segments={[
            { label: "Plugins", onClick: closeMcpServers },
            { label: "MCP servers" },
          ]}
        />
        <McpServersSettingsPanel />
      </>
    );
  }

  return (
    <>
      <SettingsBreadcrumbs segments={[{ label: "Plugins" }]} />
      <SettingsSection
        title="Agent Plugins"
        action={
          <div className="flex items-center gap-[8px]">
            <button
              type="button"
              className={rowButtonClass}
              disabled={!workspaceId || verifying}
              onClick={() => void runVerify()}
            >
              {verifying ? "Verifying..." : "Verify harness sync"}
            </button>
            <button
              type="button"
              className={rowButtonClass}
              disabled={loading || pendingAction !== null}
              onClick={() => void refreshPlugins()}
            >
              Refresh
            </button>
          </div>
        }
      >
        <SettingsBlock className="space-y-[8px]" searchId="harness-overrides">
          <p className="font-sans text-[12px] leading-[18px] text-[var(--text-secondary)]">
            Plugins bundle MCP servers, skill instructions, and branding into one installable unit.
            Installed plugins sync to compatible harnesses automatically. Per-harness overrides let
            you disable a plugin for backends that cannot run its MCP tools natively.
          </p>
          {promptOnlyHarnesses.length > 0 ? (
            <SettingsCallout tone="warning">
              <span className="font-medium">Limited MCP support:</span>{" "}
              {promptOnlyHarnesses
                .map((entry) => HARNESS_LABELS[entry.backendId] ?? entry.backendId)
                .join(", ")}{" "}
              receive plugin skills and guidance in the prompt only. MCP tools will not run
              natively across those harnesses.
            </SettingsCallout>
          ) : null}
          {error ? <SettingsCallout tone="danger">{error}</SettingsCallout> : null}
          {loading ? (
            <p className="font-sans text-[12px] text-[var(--text-secondary)]">
              Loading plugins...
            </p>
          ) : null}
        </SettingsBlock>
        {verification ? <VerificationReportBlock verification={verification} /> : null}
        {plugins.map((plugin) => (
          <InstalledPluginBlock
            key={plugin.definition.pluginId}
            plugin={plugin}
            capabilityById={capabilityById}
            workspaceId={workspaceId}
            pendingAction={pendingAction}
            onRunAction={runPluginAction}
          />
        ))}
      </SettingsSection>

      <SettingsSection title="Discover">
        <SettingsBlock className="space-y-[10px]">
          <p className="font-sans text-[12px] leading-[18px] text-[var(--text-secondary)]">
            Browse the local catalog and optional remote/GitHub registries. Set{" "}
            <span className="font-mono text-[11px]">OPENCURSOR_PLUGIN_REGISTRY_URL</span> or{" "}
            <span className="font-mono text-[11px]">OPENCURSOR_PLUGIN_GITHUB_REPO</span> to pull
            additional plugins.
          </p>
          <div className="flex items-center gap-[8px]">
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-[10px] top-1/2 size-[13px] -translate-y-1/2 text-[var(--text-secondary)]"
                strokeWidth={1.75}
              />
              <input
                className={`${shortcutInputClass} w-full max-w-none pl-[30px]`}
                placeholder="Search plugins"
                value={discoveryQuery}
                onChange={(event) => setDiscoveryQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void refreshDiscovery(discoveryQuery);
                  }
                }}
              />
            </div>
            <button
              type="button"
              className={rowButtonClass}
              disabled={discovering}
              onClick={() => void refreshDiscovery(discoveryQuery)}
            >
              {discovering ? "Searching..." : "Search"}
            </button>
          </div>
          {discovery?.sources?.length ? (
            <div className="flex flex-wrap gap-[6px] font-sans text-[10px] text-[var(--text-secondary)]">
              {discovery.sources.map((source) => (
                <span
                  key={`${source.id}:${source.label}`}
                  className="rounded-full border border-[var(--border-subtle)] px-[7px] py-[2px]"
                  title={source.error ?? source.url}
                >
                  {source.label}: {source.error ? "error" : source.pluginCount}
                </span>
              ))}
            </div>
          ) : null}
        </SettingsBlock>
        {uninstalledDiscoveryEntries.slice(0, 12).map((entry) => (
          <SettingsBlock
            key={`${entry.source}:${entry.definition.pluginId}`}
            className="flex items-start justify-between gap-[12px] py-[10px]"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-[8px]">
                <PluginIcon iconUrl={entry.definition.iconUrl} size={16} />
                <span className="font-sans text-[12px] font-medium text-[var(--text-primary)]">
                  {entry.definition.displayName}
                </span>
                <span className="font-sans text-[10px] uppercase tracking-[0.06em] text-[var(--text-secondary)]">
                  {entry.sourceLabel}
                </span>
              </div>
              <p className="mt-[4px] font-sans text-[11px] leading-[16px] text-[var(--text-secondary)]">
                {entry.definition.description}
              </p>
            </div>
            <button
              type="button"
              className={rowButtonClass}
              disabled={!workspaceId || pendingAction !== null}
              onClick={() =>
                void runPluginAction(`discover:${entry.definition.pluginId}`, () =>
                  installAgentPlugin(workspaceId!, entry.definition.pluginId)
                )
              }
            >
              Install
            </button>
          </SettingsBlock>
        ))}
        {discovery && uninstalledDiscoveryEntries.length === 0 ? (
          <SettingsBlock>
            <p className="font-sans text-[12px] text-[var(--text-secondary)]">
              No additional plugins to install for this search.
            </p>
          </SettingsBlock>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Custom Plugin">
        <SettingsBlock className="space-y-[8px]">
          <input
            className={shortcutInputClass}
            placeholder="Plugin name"
            value={customName}
            onChange={(event) => setCustomName(event.target.value)}
          />
          <input
            className={shortcutInputClass}
            placeholder="Optional streamable HTTP MCP URL"
            value={customMcpUrl}
            onChange={(event) => setCustomMcpUrl(event.target.value)}
          />
          <textarea
            className={`${shortcutInputClass} min-h-[82px] w-full max-w-none resize-y`}
            placeholder="Optional skill instructions"
            value={customSkill}
            onChange={(event) => setCustomSkill(event.target.value)}
          />
          <div>
            <button
              type="button"
              className={rowButtonClass}
              disabled={!workspaceId || !customName.trim() || pendingAction !== null}
              onClick={() => void createCustomPlugin()}
            >
              Create custom plugin
            </button>
          </div>
        </SettingsBlock>
      </SettingsSection>

      <SettingsSection title="Related">
        <SettingsLinkRow
          searchId="mcp-link"
          title="MCP servers"
          description="Preset, custom, and connected MCP servers for this workspace."
          onClick={openMcpServers}
        />
        <SettingsLinkRow
          searchId="rules-link"
          title="Rules, skills, and subagents"
          description="Instruction files, skills, and subagent presets."
          onClick={openRulesSkills}
          border={false}
        />
      </SettingsSection>
    </>
  );
}
