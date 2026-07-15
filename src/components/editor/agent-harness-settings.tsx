"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronRight, ExternalLink, Plus, RefreshCw, X } from "lucide-react";
import { AgentBackendIcon } from "@/components/chat/AgentBackendIcon";
import { VerticalFadedScroll } from "@/components/chat/VerticalFadedScroll";
import { HardwareAwareTextInput } from "@/components/input/HardwareAwareTextField";
import { SettingsThemeSelect } from "@/components/editor/SettingsThemeSelect";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import type { AgentBackendId } from "@/lib/agent-types";
import type { AgentsSettingsState, RememberedAgentPermissionRule } from "@/lib/global-settings";
import {
  deleteCursorSdkApiKey,
  deleteClaudeCodeSdkSettings,
  deleteCesiumProviderKey,
  disconnectPiAgentOAuth,
  discoverCesiumProviderModels,
  fetchClaudeCodeSdkSettings,
  fetchCesiumAgentSettings,
  fetchCesiumModelCatalog,
  fetchCursorSdkCredentialStatus,
  fetchPiAgentSettings,
  patchCesiumAgentSettings,
  refreshCesiumModelCatalog,
  saveClaudeCodeSdkSettings,
  saveCursorSdkApiKey,
  saveCesiumProviderKey,
  savePiAgentProviderKey,
  startPiAgentOAuth,
  type ClaudeCodeSdkSettingsPayload,
  type CesiumAgentSettingsPayload,
  type CesiumCustomProvider,
  type CesiumDiscoveredProviderModel,
  type CesiumModelCatalogEntry,
  type CesiumProviderKeyStatus,
  type CesiumProviderKind,
  type CursorSdkCredentialStatus,
  type PiAgentProviderStatus,
  type PiAgentSettingsResponse,
} from "@/lib/server-api";
import {
  detectShortcutPlatform,
  primaryModifierLabel,
} from "@/lib/keyboard-shortcuts";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import {
  SettingsBreadcrumbs,
  SettingsRow,
  SettingsSection,
  SettingsSubsectionHeading,
  SettingsFieldLabel,
  rowButtonClass,
  settingsSelectTriggerClass,
  tagClass,
} from "@/components/editor/settings-ui";
import { notifyAgentBackendsChanged } from "@/lib/agent-backend-events";

export const HARNESS_ORDER: AgentBackendId[] = [
  "cesium-agent",
  "cursor-sdk",
  "codex-app-server",
  "opencode-server",
  "gemini-acp",
  "claude-code-sdk",
  "pi-agent",
  "google-antigravity-cli",
];

export const HARNESS_LABELS: Record<AgentBackendId, string> = {
  "cesium-agent": "Cesium Agent (Beta)",
  "cursor-sdk": "Cursor SDK",
  "opencode-server": "OpenCode Server",
  "gemini-acp": "Gemini",
  "codex-app-server": "Codex App Server",
  "claude-code-sdk": "Claude Code",
  "pi-agent": "Pi Agent",
  "google-antigravity-cli": "Google Antigravity",
};

const HARNESS_DESCRIPTIONS: Record<AgentBackendId, string> = {
  "cesium-agent":
    "First-party Cesium harness with direct inference APIs, tools, subagents, and compression.",
  "cursor-sdk":
    "Cursor TypeScript SDK runtime. Uses the server-stored API key and enabled MCP servers from Plugins.",
  "opencode-server":
    "OpenCode native HTTP/SSE server API. Uses ambient OpenCode auth or the configured external server.",
  "gemini-acp": "Gemini CLI over ACP (`gemini --acp`).",
  "codex-app-server":
    "Codex App Server over JSON-RPC stdio. Uses ambient Codex auth and mirrors native plans into OpenCursor plan files.",
  "claude-code-sdk":
    "Anthropic Claude Agent SDK with stock Claude Code tools. Uses configured API/proxy auth and enabled MCP servers from Plugins.",
  "pi-agent": "Pi coding agent SDK with built-in read, edit, grep, and bash tools.",
  "google-antigravity-cli":
    "Google Antigravity CLI harness. Requires `agy` installed and ambient CLI auth; MCP comes from `.agents/mcp_config.json`, and prompt images are not exposed yet.",
};

/** Custom endpoints support the same four inference APIs as model discovery. */
const CUSTOM_PROVIDER_API_OPTIONS: Array<{ value: CesiumProviderKind; label: string }> = [
  { value: "openai-chat-completions", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses (SSE)" },
  { value: "anthropic", label: "Anthropic Messages" },
  { value: "openai-compatible", label: "OpenAI-compatible" },
];

const CUSTOM_PROVIDER_API_HINTS: Partial<Record<CesiumProviderKind, string>> = {
  "openai-chat-completions":
    "POST /v1/chat/completions — OpenAI, Groq, Together, and most third-party hosts.",
  "openai-responses":
    "POST /v1/responses with SSE streaming — OpenAI Responses API shape.",
  anthropic: "POST /v1/messages — Anthropic Messages API (x-api-key header).",
  "openai-compatible":
    "Legacy OpenAI-compatible hosts; routed as Chat Completions at runtime.",
};

const CESIUM_API_KIND_OPTIONS: Array<{ value: CesiumProviderKind; label: string }> = [
  { value: "openai-chat-completions", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses (SSE)" },
  { value: "openai-realtime", label: "OpenAI Realtime (WebSocket)" },
  { value: "anthropic", label: "Anthropic Messages" },
  { value: "google-genai", label: "Google GenAI" },
  { value: "openai-compatible", label: "OpenAI-compatible" },
];

const TOOL_PERMISSION_OPTIONS = [
  { value: "ask", label: "Ask every time" },
  { value: "allow", label: "Always allow" },
  { value: "deny", label: "Always deny" },
] as const;

type CesiumProviderOption = {
  id: string;
  providerId: string;
  label: string;
  apiKind: CesiumProviderKind;
  baseUrl?: string;
  modelCount?: number;
  custom?: boolean;
};

const FALLBACK_PROVIDER_OPTIONS: CesiumProviderOption[] = [
  {
    id: "openai",
    providerId: "openai",
    label: "OpenAI",
    apiKind: "openai-responses",
    modelCount: 0,
  },
  {
    id: "anthropic",
    providerId: "anthropic",
    label: "Anthropic",
    apiKind: "anthropic",
    modelCount: 0,
  },
  {
    id: "google",
    providerId: "google",
    label: "Google",
    apiKind: "google-genai",
    modelCount: 0,
  },
];

const inputClass =
  "box-border min-h-[32px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[6px] font-sans text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]";

const monoInputClass = `${inputClass} font-mono text-[11px]`;

const modelsLinkClass =
  "font-sans text-[12px] text-[var(--accent)] underline-offset-2 transition-colors hover:underline";

function parseHarnessId(value: string | null | undefined): AgentBackendId | null {
  if (!value || !HARNESS_ORDER.includes(value as AgentBackendId)) {
    return null;
  }
  return value as AgentBackendId;
}

function apiKindLabel(kind: CesiumProviderKind): string {
  return (
    CUSTOM_PROVIDER_API_OPTIONS.find((option) => option.value === kind)?.label ??
    CESIUM_API_KIND_OPTIONS.find((option) => option.value === kind)?.label ??
    kind
  );
}

function slugifyProviderId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function providerLabelFromId(providerId: string, options: CesiumProviderOption[]): string {
  return options.find((option) => option.providerId === providerId)?.label ?? providerId;
}

function buildProviderOptionsFromCatalog(catalog: CesiumModelCatalogEntry[]): CesiumProviderOption[] {
  const map = new Map<string, CesiumProviderOption>();
  for (const entry of catalog) {
    const existing = map.get(entry.providerId);
    if (existing) {
      existing.modelCount = (existing.modelCount ?? 0) + 1;
      if (!existing.baseUrl && entry.providerApiBaseUrl) {
        existing.baseUrl = entry.providerApiBaseUrl;
      }
      continue;
    }
    map.set(entry.providerId, {
      id: entry.providerId,
      providerId: entry.providerId,
      label: entry.providerName,
      apiKind: entry.apiKind,
      baseUrl: entry.providerApiBaseUrl,
      modelCount: 1,
    });
  }
  const sorted = [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  if (sorted.length === 0) {
    return FALLBACK_PROVIDER_OPTIONS;
  }
  return sorted;
}

/** Vertical block on harness detail — spacing only, no card borders. */
function HarnessDetailBlock({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`px-[2px] ${className}`.trim()}>{children}</section>;
}

/** Inset row inside a list-view SettingsSection card. */
function HarnessListInset({ children }: { children: ReactNode }) {
  return (
    <div className="border-b border-[var(--border-subtle)] px-[16px] py-[14px] last:border-b-0">
      {children}
    </div>
  );
}

function HarnessDetailToggleRow({
  title,
  description,
  trailing,
}: {
  title: string;
  description: string;
  trailing: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-[16px]">
      <div className="min-w-0 flex-1">
        <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">{title}</p>
        <p className="mt-[4px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
          {description}
        </p>
      </div>
      <div className="shrink-0">{trailing}</div>
    </div>
  );
}

function ModelsSettingsLink({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className={modelsLinkClass} onClick={onOpen}>
      Open Models settings
    </button>
  );
}

export function useAgentsHarnessNavigation() {
  const { workspaceSession, updateWorkspaceSession } = useWorkspace();

  const activeHarnessId = useMemo(
    () => parseHarnessId(workspaceSession.settingsView.agentsHarnessId),
    [workspaceSession.settingsView.agentsHarnessId]
  );

  const openHarness = useCallback(
    (backendId: AgentBackendId) => {
      updateWorkspaceSession((current) => ({
        ...current,
        settingsView: {
          ...current.settingsView,
          activeNav: "agents",
          agentsHarnessId: backendId,
        },
      }));
    },
    [updateWorkspaceSession]
  );

  const openAgentsList = useCallback(() => {
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: {
        ...current.settingsView,
        activeNav: "agents",
        agentsHarnessId: null,
      },
    }));
  }, [updateWorkspaceSession]);

  const openModelsSettings = useCallback(() => {
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: {
        ...current.settingsView,
        activeNav: "models",
        agentsHarnessId: null,
      },
    }));
  }, [updateWorkspaceSession]);

  return {
    activeHarnessId,
    openHarness,
    openAgentsList,
    openModelsSettings,
  };
}

function CursorSdkCredentialSettings() {
  const [status, setStatus] = useState<CursorSdkCredentialStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await fetchCursorSdkCredentialStatus();
      setStatus(result.status);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load Cursor SDK status.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveKey = useCallback(async () => {
    if (!apiKey.trim()) {
      setMessage("Paste a Cursor API key first.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await saveCursorSdkApiKey(apiKey);
      setStatus(result.status);
      setApiKey("");
      setMessage("Cursor SDK key verified and saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Cursor SDK key verification failed.");
    } finally {
      setBusy(false);
    }
  }, [apiKey]);

  const deleteKey = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await deleteCursorSdkApiKey();
      setStatus(result.status);
      setMessage(
        result.status.source === "env"
          ? "Stored key removed; CURSOR_API_KEY is still configured on the server."
          : "Stored Cursor SDK key removed."
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to remove Cursor SDK key.");
    } finally {
      setBusy(false);
    }
  }, []);

  const statusText = !status
    ? "Loading…"
    : status.configured
      ? status.source === "env"
        ? "Configured from CURSOR_API_KEY"
        : `Configured${status.apiKeyName ? ` as ${status.apiKeyName}` : ""}`
      : "Not configured";

  return (
    <HarnessDetailBlock>
      <SettingsSubsectionHeading>API credentials</SettingsSubsectionHeading>
      <div className="mt-[10px] flex flex-col gap-[12px] font-sans text-[12px] text-[var(--text-secondary)]">
        <div className="flex flex-wrap items-center justify-between gap-[10px]">
          <div>
            <p className="text-[13px] font-medium text-[var(--text-primary)]">{statusText}</p>
            {status?.userEmail ? (
              <p className="mt-[3px] font-mono text-[11px]">{status.userEmail}</p>
            ) : null}
          </div>
          <a
            href="https://cursor.com/dashboard/integrations"
            target="_blank"
            rel="noreferrer"
            className={rowButtonClass}
          >
            Get API key
            <ExternalLink className="size-[13px]" strokeWidth={1.6} />
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-[8px]">
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.currentTarget.value)}
            placeholder="Paste Cursor API key"
            className="box-border min-h-[32px] min-w-[260px] flex-1 rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[6px] font-mono text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
          />
          <button type="button" className={rowButtonClass} disabled={busy} onClick={saveKey}>
            Test and save
          </button>
          <button
            type="button"
            className={rowButtonClass}
            disabled={busy || status?.source !== "stored"}
            onClick={deleteKey}
          >
            Remove stored key
          </button>
        </div>
        <p className="leading-relaxed">
          The key stays server-side and is used only by the Cursor SDK harness.
        </p>
        {message ? <p className="text-[var(--text-primary)]">{message}</p> : null}
      </div>
    </HarnessDetailBlock>
  );
}

function ClaudeCodeSdkHarnessSettings() {
  const [settings, setSettings] = useState<ClaudeCodeSdkSettingsPayload | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [pathToExecutable, setPathToExecutable] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await fetchClaudeCodeSdkSettings();
      setSettings(result.settings);
      setBaseUrl(result.settings.baseUrl ?? "");
      setModel(result.settings.model ?? "");
      setPathToExecutable(result.settings.pathToExecutable ?? "");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load Claude Code SDK settings.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveSettings = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await saveClaudeCodeSdkSettings({
        baseUrl: baseUrl.trim() || null,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        model: model.trim() || null,
        pathToExecutable: pathToExecutable.trim() || null,
      });
      setSettings(result.settings);
      setApiKey("");
      setBaseUrl(result.settings.baseUrl ?? "");
      setModel(result.settings.model ?? "");
      setPathToExecutable(result.settings.pathToExecutable ?? "");
      notifyAgentBackendsChanged();
      setMessage("Claude Code SDK settings verified and saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Claude Code SDK settings save failed.");
    } finally {
      setBusy(false);
    }
  }, [apiKey, baseUrl, model, pathToExecutable]);

  const clearStoredSettings = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await deleteClaudeCodeSdkSettings();
      setSettings(result.settings);
      setApiKey("");
      setBaseUrl(result.settings.baseUrl ?? "");
      setModel(result.settings.model ?? "");
      setPathToExecutable(result.settings.pathToExecutable ?? "");
      notifyAgentBackendsChanged();
      setMessage(
        result.settings.source === "env"
          ? "Stored settings removed; Claude Code SDK env vars are still configured on the server."
          : "Stored Claude Code SDK settings removed."
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to remove Claude Code SDK settings.");
    } finally {
      setBusy(false);
    }
  }, []);

  const statusText = !settings
    ? "Loading…"
    : settings.configured
      ? settings.source === "env"
        ? "Configured from server environment variables"
        : `Configured${settings.apiKeyLastFour ? ` · key ···${settings.apiKeyLastFour}` : ""}`
      : "Not configured";

  return (
    <HarnessDetailBlock>
      <SettingsSubsectionHeading>Proxy and credentials</SettingsSubsectionHeading>
      <div className="mt-[10px] flex flex-col gap-[12px] font-sans text-[12px] text-[var(--text-secondary)]">
        <div>
          <p className="text-[13px] font-medium text-[var(--text-primary)]">{statusText}</p>
          {settings?.baseUrl ? (
            <p className="mt-[3px] font-mono text-[11px]">{settings.baseUrl}</p>
          ) : null}
        </div>
        <div className="flex flex-col gap-[8px]">
          <SettingsFieldLabel>Base URL</SettingsFieldLabel>
          <input
            type="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.currentTarget.value)}
            placeholder="https://your-proxy.example/v1"
            className={monoInputClass}
          />
        </div>
        <div className="flex flex-col gap-[8px]">
          <SettingsFieldLabel>API key</SettingsFieldLabel>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.currentTarget.value)}
            placeholder={
              settings?.apiKeyLastFour
                ? `Stored key ends with ${settings.apiKeyLastFour}`
                : "Paste Anthropic or proxy API key"
            }
            className={monoInputClass}
          />
        </div>
        <div className="flex flex-col gap-[8px]">
          <SettingsFieldLabel>Model</SettingsFieldLabel>
          <input
            type="text"
            value={model}
            onChange={(event) => setModel(event.currentTarget.value)}
            placeholder="glm-5.1-precision"
            className={monoInputClass}
          />
        </div>
        <div className="flex flex-col gap-[8px]">
          <SettingsFieldLabel>Claude Code binary path (optional)</SettingsFieldLabel>
          <input
            type="text"
            value={pathToExecutable}
            onChange={(event) => setPathToExecutable(event.currentTarget.value)}
            placeholder="C:\\path\\to\\claude.exe"
            className={monoInputClass}
          />
        </div>
        <div className="flex flex-wrap items-center gap-[8px]">
          <button type="button" className={rowButtonClass} disabled={busy} onClick={saveSettings}>
            Test and save
          </button>
          <button
            type="button"
            className={rowButtonClass}
            disabled={busy || settings?.source !== "stored"}
            onClick={clearStoredSettings}
          >
            Remove stored settings
          </button>
        </div>
        <p className="leading-relaxed">
          Credentials stay server-side and are used only by the Claude Code SDK harness. Stored
          settings override OPENCURSOR_CLAUDE_CODE_SDK_* and ANTHROPIC_* env vars.
        </p>
        {message ? <p className="text-[var(--text-primary)]">{message}</p> : null}
      </div>
    </HarnessDetailBlock>
  );
}

type CustomProviderModalProps = {
  open: boolean;
  onClose: () => void;
  existingProviders: CesiumCustomProvider[];
  onSaved: (settings: CesiumAgentSettingsPayload) => void;
};

function CustomProviderModal({
  open,
  onClose,
  existingProviders,
  onSaved,
}: CustomProviderModalProps) {
  const [displayName, setDisplayName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKind, setApiKind] = useState<CesiumProviderKind>("openai-chat-completions");
  const [discovered, setDiscovered] = useState<CesiumDiscoveredProviderModel[]>([]);
  const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(new Set());
  const [manualModelId, setManualModelId] = useState("");
  const [manualModelName, setManualModelName] = useState("");
  const [manualModels, setManualModels] = useState<CesiumCustomProvider["models"]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setDisplayName("");
    setBaseUrl("");
    setApiKey("");
    setApiKind("openai-chat-completions");
    setDiscovered([]);
    setSelectedModelIds(new Set());
    setManualModelId("");
    setManualModelName("");
    setManualModels([]);
    setMessage(null);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const mergedModels = useMemo(() => {
    const map = new Map<string, CesiumCustomProvider["models"][number]>();
    for (const model of discovered) {
      if (selectedModelIds.has(model.id)) {
        map.set(model.id, {
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow,
        });
      }
    }
    for (const model of manualModels) {
      map.set(model.id, model);
    }
    return [...map.values()];
  }, [discovered, manualModels, selectedModelIds]);

  const discoverModels = async () => {
    if (!apiKey.trim() || !baseUrl.trim()) {
      setMessage("API key and base URL are required to discover models.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await discoverCesiumProviderModels({
        apiKind,
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
      });
      setDiscovered(result.models);
      setSelectedModelIds(new Set(result.models.map((model) => model.id)));
      setMessage(
        result.models.length > 0
          ? `Discovered ${result.models.length} models.`
          : "No models returned from this endpoint."
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Model discovery failed.");
    } finally {
      setBusy(false);
    }
  };

  const addManualModel = () => {
    const id = manualModelId.trim();
    const name = manualModelName.trim() || id;
    if (!id) {
      setMessage("Model id is required for manual add.");
      return;
    }
    setManualModels((current) => {
      if (current.some((model) => model.id === id)) {
        return current;
      }
      return [...current, { id, name }];
    });
    setManualModelId("");
    setManualModelName("");
    setMessage(null);
  };

  const saveProvider = async () => {
    const name = displayName.trim();
    const resolvedBaseUrl = baseUrl.trim();
    if (!name || !resolvedBaseUrl || !apiKey.trim()) {
      setMessage("Display name, base URL, and API key are required.");
      return;
    }
    if (mergedModels.length === 0) {
      setMessage("Add at least one model via discovery or manual entry.");
      return;
    }
    const providerId = slugifyProviderId(name) || `custom-${Date.now()}`;
    setBusy(true);
    setMessage(null);
    try {
      await saveCesiumProviderKey({
        providerId,
        label: name,
        apiKind,
        apiKey: apiKey.trim(),
        baseUrl: resolvedBaseUrl,
      });
      const customProvider: CesiumCustomProvider = {
        id: `custom-${providerId}`,
        name,
        apiKind,
        baseUrl: resolvedBaseUrl,
        models: mergedModels,
      };
      const patchResult = await patchCesiumAgentSettings({
        customProviders: [...existingProviders, customProvider],
      });
      onSaved(patchResult.settings);
      notifyAgentBackendsChanged();
      onClose();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save custom provider.");
    } finally {
      setBusy(false);
    }
  };

  if (!open || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[10060] flex items-center justify-center bg-black/45 p-[16px]"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add custom provider"
        className="flex max-h-[min(720px,92vh)] w-full max-w-[560px] flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] shadow-lg"
        onPointerDown={(event) => event.stopPropagation()}
        data-ide-input-sink
      >
        <div className="flex items-center justify-between gap-[12px] border-b border-[var(--border-subtle)] px-[16px] py-[12px]">
          <h3 className="font-sans text-[15px] font-semibold text-[var(--text-primary)]">
            Add custom provider
          </h3>
          <button
            type="button"
            className="flex size-[28px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
            aria-label="Close"
            onClick={onClose}
          >
            <X className="size-[16px]" strokeWidth={1.5} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[16px] py-[14px] hide-scrollbar-y">
          <div className="flex flex-col gap-[12px]">
            <label className="flex flex-col gap-[5px]">
              <SettingsFieldLabel>Inference API</SettingsFieldLabel>
              <SettingsThemeSelect
                value={apiKind}
                options={CUSTOM_PROVIDER_API_OPTIONS}
                onChange={(value) => setApiKind(value as CesiumProviderKind)}
                ariaLabel="Provider inference API"
                className="w-full max-w-none"
                triggerClassName={`${settingsSelectTriggerClass} w-full max-w-none`}
              />
              {CUSTOM_PROVIDER_API_HINTS[apiKind] ? (
                <p className="font-sans text-[11px] leading-relaxed text-[var(--text-secondary)]">
                  {CUSTOM_PROVIDER_API_HINTS[apiKind]}
                </p>
              ) : null}
            </label>
            <label className="flex flex-col gap-[5px]">
              <SettingsFieldLabel>Display name</SettingsFieldLabel>
              <HardwareAwareTextInput
                value={displayName}
                onChange={setDisplayName}
                placeholder="e.g. OpenRouter"
                className={inputClass}
                ariaLabel="Provider display name"
              />
            </label>
            <label className="flex flex-col gap-[5px]">
              <SettingsFieldLabel>Base URL</SettingsFieldLabel>
              <HardwareAwareTextInput
                value={baseUrl}
                onChange={setBaseUrl}
                placeholder="https://api.provider.com/v1"
                className={monoInputClass}
                ariaLabel="Provider base URL"
              />
            </label>
            <label className="flex flex-col gap-[5px]">
              <SettingsFieldLabel>API key</SettingsFieldLabel>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.currentTarget.value)}
                placeholder="Paste provider API key"
                className={monoInputClass}
              />
            </label>
            <div className="flex flex-wrap items-center gap-[8px]">
              <button
                type="button"
                className={rowButtonClass}
                disabled={busy}
                onClick={() => void discoverModels()}
              >
                Discover models
              </button>
              <button type="button" className={rowButtonClass} disabled={busy} onClick={saveProvider}>
                Save provider
              </button>
            </div>
            {discovered.length > 0 ? (
              <VerticalFadedScroll
                measureKey={discovered.length}
                edgeColorVar="var(--bg-panel)"
                scrollClassName="hide-scrollbar-y max-h-[200px] min-h-0 overflow-y-auto overscroll-contain rounded-[var(--radius-tab)] border border-[var(--border-card)]"
              >
                <ul className="divide-y divide-[var(--border-subtle)]">
                  {discovered.map((model) => {
                    const checked = selectedModelIds.has(model.id);
                    return (
                      <li key={model.id} className="flex items-center gap-[10px] px-[10px] py-[8px]">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            setSelectedModelIds((current) => {
                              const next = new Set(current);
                              if (next.has(model.id)) {
                                next.delete(model.id);
                              } else {
                                next.add(model.id);
                              }
                              return next;
                            });
                          }}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="font-sans text-[12px] text-[var(--text-primary)]">{model.name}</p>
                          <p className="font-mono text-[10px] text-[var(--text-secondary)]">{model.id}</p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </VerticalFadedScroll>
            ) : null}
            <div className="border-t border-[var(--border-subtle)] pt-[12px]">
              <SettingsSubsectionHeading>Manual model</SettingsSubsectionHeading>
              <div className="mt-[8px] grid gap-[8px] sm:grid-cols-2">
                <HardwareAwareTextInput
                  value={manualModelId}
                  onChange={setManualModelId}
                  placeholder="model-id"
                  className={monoInputClass}
                  ariaLabel="Manual model id"
                />
                <HardwareAwareTextInput
                  value={manualModelName}
                  onChange={setManualModelName}
                  placeholder="Display name (optional)"
                  className={inputClass}
                  ariaLabel="Manual model name"
                />
              </div>
              <button
                type="button"
                className={`${rowButtonClass} mt-[8px]`}
                onClick={addManualModel}
              >
                Add model
              </button>
              {manualModels.length > 0 ? (
                <ul className="mt-[8px] divide-y divide-[var(--border-subtle)] rounded-[var(--radius-tab)] border border-[var(--border-card)]">
                  {manualModels.map((model) => (
                    <li
                      key={model.id}
                      className="flex items-center justify-between gap-[8px] px-[10px] py-[6px] font-mono text-[11px] text-[var(--text-secondary)]"
                    >
                      <span className="truncate text-[var(--text-primary)]">{model.name}</span>
                      <span className="truncate">{model.id}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            {message ? (
              <p className="font-sans text-[12px] text-[var(--text-primary)]">{message}</p>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

function CesiumAgentHarnessSettings() {
  const [settings, setSettings] = useState<CesiumAgentSettingsPayload | null>(null);
  const [catalog, setCatalog] = useState<CesiumModelCatalogEntry[]>([]);
  const [providerOptionId, setProviderOptionId] = useState("openai");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [customModalOpen, setCustomModalOpen] = useState(false);

  const providerOptions = useMemo(
    () => buildProviderOptionsFromCatalog(catalog),
    [catalog]
  );

  const providerSelectOptions = useMemo(
    () =>
      providerOptions.map((option) => ({
        value: option.id,
        label:
          option.modelCount != null && option.modelCount > 0
            ? `${option.label} (${option.modelCount})`
            : option.label,
      })),
    [providerOptions]
  );

  const selectedProvider = useMemo(
    () =>
      providerOptions.find((option) => option.id === providerOptionId) ?? providerOptions[0] ?? null,
    [providerOptionId, providerOptions]
  );

  const refresh = useCallback(async () => {
    try {
      const [settingsResult, catalogResult] = await Promise.all([
        fetchCesiumAgentSettings(),
        fetchCesiumModelCatalog(),
      ]);
      setSettings(settingsResult.settings);
      setCatalog(catalogResult.models);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load Cesium settings.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveKey = useCallback(async () => {
    if (!selectedProvider || !apiKey.trim()) {
      setMessage("Choose a provider and paste an API key.");
      return;
    }
    const resolvedBaseUrl = baseUrl.trim() || selectedProvider.baseUrl?.trim() || "";
    if (
      (selectedProvider.apiKind === "openai-compatible" ||
        selectedProvider.custom ||
        !selectedProvider.baseUrl) &&
      !resolvedBaseUrl
    ) {
      setMessage("Base URL is required for this provider.");
      return;
    }
    const displayLabel = label.trim() || selectedProvider.label;
    setBusy(true);
    setMessage(null);
    try {
      const result = await saveCesiumProviderKey({
        providerId: selectedProvider.providerId,
        label: displayLabel,
        apiKind: selectedProvider.apiKind,
        apiKey: apiKey.trim(),
        baseUrl: resolvedBaseUrl || undefined,
      });
      setSettings(result.settings);
      setApiKey("");
      setLabel("");
      if (!selectedProvider.baseUrl) {
        setBaseUrl("");
      }
      setMessage("Provider API key saved.");
      notifyAgentBackendsChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save provider key.");
    } finally {
      setBusy(false);
    }
  }, [apiKey, baseUrl, label, selectedProvider]);

  const removeKey = useCallback(async (id: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await deleteCesiumProviderKey(id);
      setSettings(result.settings);
      setMessage("Provider key removed.");
      notifyAgentBackendsChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to remove provider key.");
    } finally {
      setBusy(false);
    }
  }, []);

  const patchSettings = useCallback(
    async (patch: Parameters<typeof patchCesiumAgentSettings>[0]) => {
      setBusy(true);
      setMessage(null);
      try {
        const result = await patchCesiumAgentSettings(patch);
        setSettings(result.settings);
        notifyAgentBackendsChanged();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Failed to update Cesium settings.");
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const refreshCatalog = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await refreshCesiumModelCatalog();
      setCatalog(result.models);
      setMessage(`models.dev refreshed: ${result.models.length} models loaded.`);
      notifyAgentBackendsChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to refresh models.dev catalog.");
    } finally {
      setBusy(false);
    }
  }, []);

  const uniqueProviderKeys = useMemo(() => {
    if (!settings) {
      return [] as CesiumProviderKeyStatus[];
    }
    const seen = new Map<string, CesiumProviderKeyStatus>();
    for (const key of settings.providerKeys) {
      const existing = seen.get(key.providerId);
      if (!existing || key.updatedAt > existing.updatedAt) {
        seen.set(key.providerId, key);
      }
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [settings]);

  const defaultProviderOptions = useMemo(() => {
    const options = uniqueProviderKeys.map((key) => ({
      value: key.id,
      label: `${key.label}${key.lastFour ? ` · ****${key.lastFour}` : ""}`,
    }));
    return [{ value: "", label: "Automatic" }, ...options];
  }, [uniqueProviderKeys]);

  const needsBaseUrlField =
    selectedProvider &&
    (selectedProvider.custom ||
      selectedProvider.apiKind === "openai-compatible" ||
      !selectedProvider.baseUrl);

  return (
    <>
      <div className="flex flex-col gap-[28px]">
        <HarnessDetailBlock>
          <SettingsSubsectionHeading>Provider API keys</SettingsSubsectionHeading>
        <div className="mt-[10px] flex flex-col gap-[12px] font-sans text-[12px] text-[var(--text-secondary)]">
          <div className="flex flex-wrap items-center justify-between gap-[10px]">
            <div>
              <p className="text-[13px] font-medium text-[var(--text-primary)]">
                {settings?.configured ? "Configured" : "Not configured"}
              </p>
              <p className="mt-[3px] leading-relaxed">
                Keys from models.dev providers plus custom OpenAI-compatible endpoints. Secrets stay
                on the server.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-[8px]">
              <button
                type="button"
                className={rowButtonClass}
                disabled={busy}
                onClick={() => void refreshCatalog()}
              >
                <RefreshCw className={`size-[14px] ${busy ? "animate-spin" : ""}`} strokeWidth={1.5} />
                Refresh models.dev
              </button>
              <button
                type="button"
                className={rowButtonClass}
                disabled={busy}
                onClick={() => setCustomModalOpen(true)}
              >
                <Plus className="size-[14px]" strokeWidth={1.5} />
                Custom provider
              </button>
            </div>
          </div>

          {uniqueProviderKeys.length > 0 ? (
            <ul className="divide-y divide-[var(--border-subtle)]">
              {uniqueProviderKeys.map((key) => (
                <li
                  key={key.id}
                  className="-mx-[6px] flex flex-wrap items-center justify-between gap-[8px] rounded-[var(--radius-tab)] px-[6px] py-[8px] transition-colors first:pt-[8px] last:pb-[8px] hover:bg-[var(--accent-bg)]"
                >
                  <div className="min-w-0">
                    <p className="text-[13px] text-[var(--text-primary)]">
                      {providerLabelFromId(key.providerId, providerOptions)}{" "}
                      <span className="text-[var(--text-secondary)]">({key.apiKind})</span>
                    </p>
                    <p className="mt-[2px] font-mono text-[11px]">
                      {key.providerId} · {key.source}
                      {key.lastFour ? ` · ****${key.lastFour}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-[8px]">
                    <button
                      type="button"
                      className={rowButtonClass}
                      disabled={busy}
                      onClick={() =>
                        void patchSettings({
                          defaultProviderKeyId: key.id,
                          defaultApiKind: key.apiKind,
                        })
                      }
                    >
                      Use by default
                    </button>
                    {key.source === "stored" ? (
                      <button
                        type="button"
                        className={rowButtonClass}
                        disabled={busy}
                        onClick={() => void removeKey(key.id)}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[var(--text-disabled)]">No provider keys saved yet.</p>
          )}

          <div className="mt-[16px] flex flex-col gap-[10px] border-t border-[var(--border-subtle)] pt-[16px]">
          <div className="grid gap-[10px] md:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
            <label className="flex flex-col gap-[5px]">
              <SettingsFieldLabel>Provider</SettingsFieldLabel>
              <SettingsThemeSelect
                value={providerOptionId}
                options={providerSelectOptions}
                onChange={setProviderOptionId}
                ariaLabel="Cesium provider"
                className="w-full max-w-none"
                triggerClassName={`${settingsSelectTriggerClass} w-full max-w-none`}
                disabled={providerSelectOptions.length === 0}
              />
            </label>
            <div className="flex min-w-0 flex-col justify-end">
              {selectedProvider ? (
                <>
                  <p className="font-sans text-[12px] leading-relaxed text-[var(--text-secondary)]">
                    {selectedProvider.label}
                    {selectedProvider.baseUrl ? (
                      <span className="mt-[4px] block font-mono text-[10.5px] text-[var(--text-disabled)]">
                        {selectedProvider.baseUrl}
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-[4px] font-mono text-[10.5px] text-[var(--text-disabled)]">
                    {CESIUM_API_KIND_OPTIONS.find((option) => option.value === selectedProvider.apiKind)
                      ?.label ?? selectedProvider.apiKind}
                  </p>
                </>
              ) : null}
            </div>
          </div>

          <div className="grid gap-[8px] md:grid-cols-2">
            <HardwareAwareTextInput
              value={label}
              onChange={setLabel}
              placeholder="Label (optional)"
              className={inputClass}
              ariaLabel="Provider label"
            />
            {needsBaseUrlField ? (
              <HardwareAwareTextInput
                value={baseUrl}
                onChange={setBaseUrl}
                placeholder={selectedProvider?.baseUrl ?? "https://api.provider.com/v1"}
                className={monoInputClass}
                ariaLabel="Provider base URL"
              />
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-[8px]">
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.currentTarget.value)}
              placeholder="Paste provider API key"
              className="box-border min-h-[32px] min-w-[260px] flex-1 rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[6px] font-mono text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
            />
            <button
              type="button"
              className={rowButtonClass}
              disabled={busy}
              onClick={() => void saveKey()}
            >
              Save key
            </button>
          </div>
          </div>
        </div>
      </HarnessDetailBlock>

      {settings ? (
        <>
          <HarnessDetailBlock>
            <SettingsSubsectionHeading>Defaults</SettingsSubsectionHeading>
            <div className="mt-[10px] grid gap-[12px] md:grid-cols-2">
              <label className="flex flex-col gap-[5px]">
                <SettingsFieldLabel>Default API</SettingsFieldLabel>
                <SettingsThemeSelect
                  value={settings.defaultApiKind}
                  options={CESIUM_API_KIND_OPTIONS}
                  onChange={(value) =>
                    void patchSettings({ defaultApiKind: value as CesiumProviderKind })
                  }
                  ariaLabel="Default Cesium API kind"
                  className="w-full max-w-none"
                  triggerClassName={`${settingsSelectTriggerClass} w-full max-w-none`}
                  disabled={busy}
                />
              </label>
              <label className="flex flex-col gap-[5px]">
                <SettingsFieldLabel>Default provider key</SettingsFieldLabel>
                <SettingsThemeSelect
                  value={settings.defaultProviderKeyId ?? ""}
                  options={defaultProviderOptions}
                  onChange={(value) =>
                    void patchSettings({
                      defaultProviderKeyId: value || null,
                    })
                  }
                  ariaLabel="Default provider key"
                  className="w-full max-w-none"
                  triggerClassName={`${settingsSelectTriggerClass} w-full max-w-none`}
                  disabled={busy}
                />
              </label>
            </div>
          </HarnessDetailBlock>

          <HarnessDetailBlock>
            <HarnessDetailToggleRow
              title="Context compression"
              description="Summarize older turns when the session approaches the model context limit."
              trailing={
                <ToggleSwitch
                  checked={settings.compression.enabled}
                  onChange={(enabled) =>
                    void patchSettings({
                      compression: {
                        ...settings.compression,
                        enabled,
                      },
                    })
                  }
                  size="md"
                  variant="green"
                />
              }
            />
          </HarnessDetailBlock>

          <HarnessDetailBlock>
            <SettingsSubsectionHeading>Orchestration Agent</SettingsSubsectionHeading>
            <HarnessDetailToggleRow
              title="Continue when work remains"
              description="When a Cesium agent stops with incomplete todos or open kanban issues, automatically prompt it to continue toward the user's core goals."
              trailing={
                <ToggleSwitch
                  checked={settings.orchestration.continueWhenIncomplete}
                  onChange={(continueWhenIncomplete) =>
                    void patchSettings({
                      orchestration: {
                        ...settings.orchestration,
                        continueWhenIncomplete,
                      },
                    })
                  }
                  size="md"
                  variant="green"
                />
              }
            />
          </HarnessDetailBlock>

          <HarnessDetailBlock>
            <SettingsSubsectionHeading>Tool permissions</SettingsSubsectionHeading>
            <div className="mt-[10px] grid gap-[12px] md:grid-cols-2">
              <label className="flex flex-col gap-[5px]">
                <SettingsFieldLabel>Edit file</SettingsFieldLabel>
                <SettingsThemeSelect
                  value={settings.toolPermissions.editFile}
                  options={[...TOOL_PERMISSION_OPTIONS]}
                  onChange={(value) =>
                    void patchSettings({
                      toolPermissions: {
                        ...settings.toolPermissions,
                        editFile: value as "ask" | "allow" | "deny",
                      },
                    })
                  }
                  ariaLabel="Edit file permission"
                  className="w-full max-w-none"
                  triggerClassName={`${settingsSelectTriggerClass} w-full max-w-none`}
                  disabled={busy}
                />
              </label>
              <label className="flex flex-col gap-[5px]">
                <SettingsFieldLabel>Terminal</SettingsFieldLabel>
                <SettingsThemeSelect
                  value={settings.toolPermissions.terminal}
                  options={[...TOOL_PERMISSION_OPTIONS]}
                  onChange={(value) =>
                    void patchSettings({
                      toolPermissions: {
                        ...settings.toolPermissions,
                        terminal: value as "ask" | "allow" | "deny",
                      },
                    })
                  }
                  ariaLabel="Terminal permission"
                  className="w-full max-w-none"
                  triggerClassName={`${settingsSelectTriggerClass} w-full max-w-none`}
                  disabled={busy}
                />
              </label>
            </div>
          </HarnessDetailBlock>

          {settings.customProviders.length > 0 ? (
            <HarnessDetailBlock>
              <SettingsSubsectionHeading>Custom providers</SettingsSubsectionHeading>
              <ul className="mt-[8px] divide-y divide-[var(--border-subtle)]">
                {settings.customProviders.map((provider) => (
                  <li
                    key={provider.id}
                    className="-mx-[6px] rounded-[var(--radius-tab)] px-[6px] py-[8px] transition-colors first:pt-[8px] last:pb-[8px] hover:bg-[var(--accent-bg)]"
                  >
                    <p className="font-sans text-[13px] text-[var(--text-primary)]">{provider.name}</p>
                    <p className="mt-[2px] font-mono text-[11px] text-[var(--text-secondary)]">
                      {apiKindLabel(provider.apiKind)}
                      {provider.baseUrl ? ` · ${provider.baseUrl}` : ""} · {provider.models.length}{" "}
                      model{provider.models.length === 1 ? "" : "s"}
                    </p>
                  </li>
                ))}
              </ul>
            </HarnessDetailBlock>
          ) : null}
        </>
      ) : null}

      {message ? (
        <HarnessDetailBlock>
          <p className="font-sans text-[12px] text-[var(--text-primary)]">{message}</p>
        </HarnessDetailBlock>
      ) : null}
      </div>

      <CustomProviderModal
        open={customModalOpen}
        onClose={() => setCustomModalOpen(false)}
        existingProviders={settings?.customProviders ?? []}
        onSaved={setSettings}
      />
    </>
  );
}

function PiAgentHarnessSettings() {
  const { refreshModels } = useGlobalSettings();
  const [payload, setPayload] = useState<PiAgentSettingsResponse | null>(null);
  const [apiKeysByProvider, setApiKeysByProvider] = useState<Record<string, string>>({});
  const [busyProviderId, setBusyProviderId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await fetchPiAgentSettings();
      setPayload(result);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load Pi Agent settings.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "opencursor-pi-agent-oauth") {
        void refresh()
          .then(() => refreshModels())
          .then(() => notifyAgentBackendsChanged());
        setMessage("Pi Agent provider connected.");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [refresh, refreshModels]);

  const connectOAuth = useCallback(
    async (provider: PiAgentProviderStatus) => {
      setBusyProviderId(provider.id);
      setMessage(null);
      try {
        const result = await startPiAgentOAuth(provider.id);
        if (result.authUrl) {
          window.open(result.authUrl, "_blank", "noopener,noreferrer,width=520,height=720");
          setMessage(
            result.instructions ??
              `Complete sign-in for ${provider.name} in your browser, then return here.`
          );
          window.setTimeout(() => {
            void refresh()
              .then(() => refreshModels())
              .then(() => notifyAgentBackendsChanged());
          }, 4000);
          return;
        }
        if (result.verificationUri && result.userCode) {
          window.open(result.verificationUri, "_blank", "noopener,noreferrer,width=520,height=720");
          setMessage(`Enter code ${result.userCode} at ${result.verificationUri}`);
          window.setTimeout(() => {
            void refresh()
              .then(() => refreshModels())
              .then(() => notifyAgentBackendsChanged());
          }, 4000);
          return;
        }
        setMessage("OAuth flow started. Refreshing provider status…");
        await refresh();
        await refreshModels();
        notifyAgentBackendsChanged();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Pi Agent OAuth failed.");
      } finally {
        setBusyProviderId(null);
      }
    },
    [refresh, refreshModels]
  );

  const disconnectProvider = useCallback(
    async (providerId: string) => {
      setBusyProviderId(providerId);
      setMessage(null);
      try {
        const result = await disconnectPiAgentOAuth(providerId);
        setPayload(result);
        await refreshModels();
        notifyAgentBackendsChanged();
        setMessage("Provider disconnected.");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Failed to disconnect provider.");
      } finally {
        setBusyProviderId(null);
      }
    },
    [refreshModels]
  );

  const saveApiKey = useCallback(
    async (provider: PiAgentProviderStatus) => {
      const apiKey = apiKeysByProvider[provider.id]?.trim();
      if (!apiKey) {
        setMessage(`Paste an API key for ${provider.name}.`);
        return;
      }
      setBusyProviderId(provider.id);
      setMessage(null);
      try {
        const result = await savePiAgentProviderKey({
          providerId: provider.id,
          label: provider.name,
          apiKey,
        });
        setPayload(result);
        setApiKeysByProvider((current) => ({ ...current, [provider.id]: "" }));
        await refreshModels();
        notifyAgentBackendsChanged();
        setMessage(`${provider.name} API key saved.`);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Failed to save API key.");
      } finally {
        setBusyProviderId(null);
      }
    },
    [apiKeysByProvider, refreshModels]
  );

  const providers = payload?.providers ?? [];
  const configuredCount = providers.filter((provider) => provider.configured).length;

  return (
    <HarnessDetailBlock>
      <SettingsSubsectionHeading>Provider credentials</SettingsSubsectionHeading>
      <div className="mt-[10px] flex flex-col gap-[12px] font-sans text-[12px] text-[var(--text-secondary)]">
        <p className="text-[13px] font-medium text-[var(--text-primary)]">
          {payload
            ? configuredCount > 0
              ? `${configuredCount} provider${configuredCount === 1 ? "" : "s"} configured`
              : "No Pi Agent providers configured"
            : "Loading…"}
        </p>
        <p className="leading-relaxed">
          Connect OAuth providers or paste API keys as a fallback. Credentials are stored in an
          isolated Pi Agent auth directory on the server.
        </p>
        <ul className="divide-y divide-[var(--border-subtle)] rounded-[8px] border border-[var(--border-subtle)]">
          {providers.map((provider) => {
            const busy = busyProviderId === provider.id;
            const statusLabel = provider.configured
              ? provider.authLabel ??
                (provider.authMethod === "oauth"
                  ? "OAuth connected"
                  : provider.authMethod === "env"
                    ? "Environment variable"
                    : provider.apiKeyLastFour
                      ? `API key ···${provider.apiKeyLastFour}`
                      : "Configured")
              : "Not connected";
            return (
              <li key={provider.id} className="flex flex-col gap-[10px] px-[12px] py-[12px]">
                <div className="flex flex-wrap items-start justify-between gap-[10px]">
                  <div className="min-w-0">
                    <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
                      {provider.name}
                    </p>
                    <p className="mt-[3px] font-mono text-[11px] text-[var(--text-secondary)]">
                      {provider.id}
                      {provider.modelCount > 0
                        ? ` · ${provider.modelCount} model${provider.modelCount === 1 ? "" : "s"}`
                        : ""}
                      {provider.modelsAvailable ? " · available" : ""}
                    </p>
                    <p className="mt-[4px] font-sans text-[12px] text-[var(--text-secondary)]">
                      {statusLabel}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-[8px]">
                    {provider.oauthSupported ? (
                      <button
                        type="button"
                        className={rowButtonClass}
                        disabled={busy}
                        onClick={() => void connectOAuth(provider)}
                      >
                        Connect
                      </button>
                    ) : null}
                    {provider.configured ? (
                      <button
                        type="button"
                        className={rowButtonClass}
                        disabled={busy}
                        onClick={() => void disconnectProvider(provider.id)}
                      >
                        Disconnect
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-col gap-[8px] sm:flex-row sm:items-center">
                  <input
                    type="password"
                    value={apiKeysByProvider[provider.id] ?? ""}
                    onChange={(event) =>
                      setApiKeysByProvider((current) => ({
                        ...current,
                        [provider.id]: event.currentTarget.value,
                      }))
                    }
                    placeholder={
                      provider.apiKeyLastFour
                        ? `Stored key ends with ${provider.apiKeyLastFour}`
                        : "API key fallback"
                    }
                    className={`${monoInputClass} min-w-0 flex-1`}
                  />
                  <button
                    type="button"
                    className={rowButtonClass}
                    disabled={busy}
                    onClick={() => void saveApiKey(provider)}
                  >
                    Save key
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center gap-[8px]">
          <button type="button" className={rowButtonClass} onClick={() => void refresh()}>
            <RefreshCw className="size-[14px]" strokeWidth={1.5} />
            Refresh status
          </button>
        </div>
        {message ? <p className="text-[var(--text-primary)]">{message}</p> : null}
      </div>
    </HarnessDetailBlock>
  );
}

function HarnessGenericSettings() {
  return (
    <HarnessDetailBlock>
      <p className="font-sans text-[12px] leading-relaxed text-[var(--text-secondary)]">
        Session options (mode, model, web search, and similar) are chosen in the chat composer for
        each conversation. Use Models settings to control which models appear in the dropdown for
        this harness.
      </p>
    </HarnessDetailBlock>
  );
}

function HarnessSpecificSettings({ backendId }: { backendId: AgentBackendId }) {
  switch (backendId) {
    case "cesium-agent":
      return <CesiumAgentHarnessSettings />;
    case "cursor-sdk":
      return <CursorSdkCredentialSettings />;
    case "claude-code-sdk":
      return <ClaudeCodeSdkHarnessSettings />;
    case "pi-agent":
      return <PiAgentHarnessSettings />;
    default:
      return <HarnessGenericSettings />;
  }
}

function HarnessRememberedPermissionsList({
  backendId,
  rules,
  workspaceNameById,
  onRemove,
  showBackendLabel = false,
}: {
  backendId?: AgentBackendId;
  rules: RememberedAgentPermissionRule[];
  workspaceNameById: Map<string, string>;
  onRemove: (id: string) => void;
  showBackendLabel?: boolean;
}) {
  const sorted = useMemo(
    () => [...rules].sort((a, b) => b.updatedAt - a.updatedAt),
    [rules]
  );

  if (sorted.length === 0) {
    if (!backendId) {
      return null;
    }
    return (
      <p className="font-sans text-[12px] text-[var(--text-disabled)]">
        No remembered permissions for {HARNESS_LABELS[backendId]} yet.
      </p>
    );
  }

  return (
    <ul className="max-h-[min(280px,40vh)] divide-y divide-[var(--border-subtle)] overflow-y-auto overscroll-contain">
      {sorted.map((rule) => {
        const wsLabel = workspaceNameById.get(rule.workspaceId) ?? rule.workspaceId.slice(0, 8);
        const harnessLabel =
          HARNESS_LABELS[rule.backendId as AgentBackendId] ?? rule.backendId;
        const choice =
          rule.optionKind === "allow_always"
            ? "Always allow"
            : rule.optionKind === "reject_always"
              ? "Always reject"
              : rule.decision === "allow"
                ? "Allow"
                : "Reject";
        return (
          <li
            key={rule.id}
            className="flex flex-wrap items-start justify-between gap-[10px] py-[10px] first:pt-0"
          >
            <div className="min-w-0 flex-1">
              <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
                {rule.toolLabel}
              </p>
              <p className="mt-[4px] font-mono text-[11px] text-[var(--text-secondary)]">
                {rule.toolKey}
              </p>
              <p className="mt-[6px] flex flex-wrap items-center gap-[6px] font-sans text-[11px] text-[var(--text-secondary)]">
                {showBackendLabel ? <span className={tagClass}>{harnessLabel}</span> : null}
                <span className={tagClass}>{wsLabel}</span>
                <span
                  className={`${tagClass} ${
                    rule.decision === "allow"
                      ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                      : "border-rose-500/40 text-rose-700 dark:text-rose-300"
                  }`}
                >
                  {choice}
                </span>
              </p>
            </div>
            <button type="button" className={rowButtonClass} onClick={() => onRemove(rule.id)}>
              Remove
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function HarnessDetailView({
  backendId,
  agents,
  rememberedForHarness,
  workspaceNameById,
  onPatchAgents,
  onOpenModels,
}: {
  backendId: AgentBackendId;
  agents: AgentsSettingsState;
  rememberedForHarness: RememberedAgentPermissionRule[];
  workspaceNameById: Map<string, string>;
  onPatchAgents: (patch: Partial<AgentsSettingsState>) => void;
  onOpenModels: () => void;
}) {
  const removeRemembered = useCallback(
    (id: string) => {
      onPatchAgents({
        rememberedPermissions: agents.rememberedPermissions.filter((rule) => rule.id !== id),
      });
    },
    [agents.rememberedPermissions, onPatchAgents]
  );

  const clearHarnessRemembered = useCallback(() => {
    onPatchAgents({
      rememberedPermissions: agents.rememberedPermissions.filter(
        (rule) => rule.backendId !== backendId
      ),
    });
  }, [agents.rememberedPermissions, backendId, onPatchAgents]);

  return (
    <>
      <div className="mb-[16px] flex items-center gap-[10px] px-[2px]">
        <AgentBackendIcon backendId={backendId} className="size-[20px] shrink-0" strokeWidth={1.5} />
        <h1 className="min-w-0 font-sans text-[17px] font-semibold tracking-tight text-[var(--text-primary)]">
          {HARNESS_LABELS[backendId]}
        </h1>
      </div>

      <div className="flex flex-col gap-[28px]">
        <HarnessSpecificSettings backendId={backendId} />
        <HarnessDetailBlock>
          <div className="mb-[10px] flex flex-wrap items-center justify-between gap-[8px]">
            <div className="min-w-0">
              <SettingsSubsectionHeading>Remembered tool permissions</SettingsSubsectionHeading>
              <p className="font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
                “Always allow” / “always reject” from permission cards for this harness only.
              </p>
            </div>
            <button
              type="button"
              className={`${rowButtonClass} disabled:cursor-not-allowed disabled:opacity-45`}
              disabled={rememberedForHarness.length === 0}
              onClick={clearHarnessRemembered}
            >
              Clear harness rules
            </button>
          </div>
          <HarnessRememberedPermissionsList
            backendId={backendId}
            rules={rememberedForHarness}
            workspaceNameById={workspaceNameById}
            onRemove={removeRemembered}
          />
        </HarnessDetailBlock>
        <HarnessDetailBlock>
          <ModelsSettingsLink onOpen={onOpenModels} />
        </HarnessDetailBlock>
      </div>
    </>
  );
}

function HarnessListView({
  agents,
  rememberedByHarness,
  workspaceNameById,
  modLabel,
  onPatchAgents,
  onOpenHarness,
}: {
  agents: AgentsSettingsState;
  rememberedByHarness: Map<AgentBackendId, RememberedAgentPermissionRule[]>;
  workspaceNameById: Map<string, string>;
  modLabel: string;
  onPatchAgents: (patch: Partial<AgentsSettingsState>) => void;
  onOpenHarness: (backendId: AgentBackendId) => void;
}) {
  const sortedRemembered = useMemo(
    () => [...agents.rememberedPermissions].sort((a, b) => b.updatedAt - a.updatedAt),
    [agents.rememberedPermissions]
  );

  return (
    <>
      <SettingsSection title="Chat composer">
        <SettingsRow
          title={`Submit with ${modLabel} + Enter`}
          description={`When enabled, ${modLabel} + Enter submits chat and Enter inserts a newline.`}
          trailing={
            <ToggleSwitch
              checked={agents.submitCtrlEnter}
              onChange={(value) => onPatchAgents({ submitCtrlEnter: value })}
              size="md"
              variant="green"
            />
          }
          border={false}
        />
        <SettingsRow
          title={`Steer with ${modLabel} + Enter`}
          description="When enabled, modified Enter queues the message as steering guidance after the current response and tool calls settle."
          trailing={
            <ToggleSwitch
              checked={agents.steerCtrlEnter}
              onChange={(value) => onPatchAgents({ steerCtrlEnter: value })}
              size="md"
              variant="green"
            />
          }
          border={false}
        />
      </SettingsSection>

      <SettingsSection title="Tool permissions (all harnesses)">
        <SettingsRow
          title="Auto-approve all permission prompts"
          description="When enabled, the server answers every tool permission prompt with Allow immediately. Per-harness remembered rules still win when they match."
          trailing={
            <ToggleSwitch
              checked={agents.autoAcceptAllAgentPermissions}
              onChange={(value) => onPatchAgents({ autoAcceptAllAgentPermissions: value })}
              size="md"
              variant="green"
            />
          }
          border={false}
        />
        <HarnessListInset>
          <div className="mb-[10px] flex flex-wrap items-center justify-between gap-[8px]">
            <div>
              <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
                Remembered decisions (all harnesses)
              </p>
              <p className="mt-[2px] max-w-[560px] font-sans text-[11px] leading-snug text-[var(--text-secondary)]">
                “Always allow” and “always reject” choices from permission cards, per workspace and
                backend.
              </p>
            </div>
            <button
              type="button"
              className={`${rowButtonClass} disabled:cursor-not-allowed disabled:opacity-45`}
              disabled={agents.rememberedPermissions.length === 0}
              onClick={() => onPatchAgents({ rememberedPermissions: [] })}
            >
              Clear all
            </button>
          </div>
          {sortedRemembered.length === 0 ? (
            <p className="font-sans text-[12px] text-[var(--text-disabled)]">
              No remembered permissions yet.
            </p>
          ) : (
            <HarnessRememberedPermissionsList
              rules={sortedRemembered}
              workspaceNameById={workspaceNameById}
              showBackendLabel
              onRemove={(id) =>
                onPatchAgents({
                  rememberedPermissions: agents.rememberedPermissions.filter(
                    (rule) => rule.id !== id
                  ),
                })
              }
            />
          )}
        </HarnessListInset>
      </SettingsSection>

      <SettingsSection title="Harnesses">
        {HARNESS_ORDER.map((backendId, index) => {
          const remembered = rememberedByHarness.get(backendId) ?? [];
          return (
            <button
              key={backendId}
              type="button"
              className={`flex min-h-[56px] w-full items-center justify-between gap-[12px] px-[16px] py-[12px] text-left transition-colors hover:bg-[var(--accent-bg)] ${
                index < HARNESS_ORDER.length - 1 ? "border-b border-[var(--border-subtle)]" : ""
              }`}
              onClick={() => onOpenHarness(backendId)}
            >
              <div className="flex min-w-0 items-center gap-[10px]">
                <AgentBackendIcon
                  backendId={backendId}
                  className="size-[18px] shrink-0"
                  strokeWidth={1.5}
                />
                <div className="min-w-0">
                  <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
                    {HARNESS_LABELS[backendId]}
                  </p>
                  <p className="mt-[2px] truncate font-sans text-[11px] text-[var(--text-secondary)]">
                    {HARNESS_DESCRIPTIONS[backendId]}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-[8px]">
                {remembered.length > 0 ? (
                  <span className="rounded-[var(--radius-tab)] bg-[var(--bg-main)] px-[6px] py-[1px] font-mono text-[11px] text-[var(--text-secondary)]">
                    {remembered.length} rule{remembered.length === 1 ? "" : "s"}
                  </span>
                ) : null}
                <ChevronRight className="size-[14px] text-[var(--text-secondary)]" strokeWidth={1.5} />
              </div>
            </button>
          );
        })}
      </SettingsSection>
    </>
  );
}

export function AgentsHarnessSettingsPanel() {
  const { settings, updateSettings } = useGlobalSettings();
  const { workspaces } = useWorkspace();
  const { activeHarnessId, openHarness, openAgentsList, openModelsSettings } =
    useAgentsHarnessNavigation();
  const agents = settings.agents;
  const modLabel = useMemo(() => primaryModifierLabel(detectShortcutPlatform()), []);

  const workspaceNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const workspace of workspaces) {
      map.set(workspace.id, workspace.name);
    }
    return map;
  }, [workspaces]);

  const rememberedByHarness = useMemo(() => {
    const map = new Map<AgentBackendId, RememberedAgentPermissionRule[]>();
    for (const backendId of HARNESS_ORDER) {
      map.set(backendId, []);
    }
    for (const rule of agents.rememberedPermissions) {
      const list = map.get(rule.backendId as AgentBackendId);
      if (list) {
        list.push(rule);
      }
    }
    return map;
  }, [agents.rememberedPermissions]);

  const patchAgents = useCallback(
    (patch: Partial<AgentsSettingsState>) => {
      updateSettings((current) => ({
        ...current,
        agents: {
          ...current.agents,
          ...patch,
        },
      }));
    },
    [updateSettings]
  );

  return (
    <>
      {activeHarnessId ? (
        <SettingsBreadcrumbs
          segments={[
            { label: "Agents", onClick: openAgentsList },
            { label: HARNESS_LABELS[activeHarnessId] },
          ]}
        />
      ) : (
        <SettingsBreadcrumbs segments={[{ label: "Agents" }]} />
      )}
      {activeHarnessId ? (
        <HarnessDetailView
          backendId={activeHarnessId}
          agents={agents}
          rememberedForHarness={rememberedByHarness.get(activeHarnessId) ?? []}
          workspaceNameById={workspaceNameById}
          onPatchAgents={patchAgents}
          onOpenModels={openModelsSettings}
        />
      ) : (
        <HarnessListView
          agents={agents}
          rememberedByHarness={rememberedByHarness}
          workspaceNameById={workspaceNameById}
          modLabel={modLabel}
          onPatchAgents={patchAgents}
          onOpenHarness={openHarness}
        />
      )}
    </>
  );
}
