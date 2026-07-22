"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  Github,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import {
  PageIntro,
  SettingsFieldLabel,
  SettingsRow,
  SettingsSection,
  SettingsSubsectionHeading,
  rowButtonClass,
  settingsSelectTriggerClass,
  tagClass,
} from "./settings-ui";
import { HARNESS_LABELS, HARNESS_ORDER } from "./agent-harness-settings";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import {
  cancelCloudAgentTask,
  completeCloudAgentTask,
  createCloudAgentTask,
  deleteCloudAgentConnection,
  deleteCloudAgentTask,
  dispatchCloudAgentTask,
  fetchCloudAgentSettings,
  fetchCloudAgentTaskArtifacts,
  fetchCloudAgentTasks,
  fetchWorkspaces,
  patchCloudAgentSettings,
  postCloudAgentTaskUpdate,
  saveCloudAgentConnectionToken,
  saveCloudAgentOAuthApp,
  saveCloudAgentWebhookSecret,
  startCloudAgentOAuth,
  steerCloudAgentTask,
} from "@/lib/server-api";
import type {
  CloudAgentEndpoints,
  CloudAgentExecutionMode,
  CloudAgentProviderId,
  CloudAgentRoutingRule,
  CloudAgentSettingsPublic,
  CloudAgentTaskArtifact,
  CloudAgentTaskRecord,
  CloudAgentTaskStatus,
} from "@/lib/server-api";
import type { WorkspaceRecord } from "@cesium/core";
import type { AgentBackendId } from "@/lib/agent-types";

const PROVIDERS: Array<{
  id: CloudAgentProviderId;
  label: string;
  tokenHint: string;
  description: string;
}> = [
  {
    id: "linear",
    label: "Linear",
    tokenHint: "lin_api_…",
    description:
      "Assign issues to your Cloud Agent. Assignments arrive via webhook and are routed to a workspace.",
  },
  {
    id: "github",
    label: "GitHub",
    tokenHint: "ghp_… or gho_…",
    description:
      "Issue assignments and comments dispatch tasks; the agent works on branches and can open PRs.",
  },
  {
    id: "slack",
    label: "Slack",
    tokenHint: "xoxb-…",
    description:
      "Mention the app in a channel to offload a task; replies land back in the thread.",
  },
];

const STATUS_LABELS: Record<CloudAgentTaskStatus, string> = {
  inbox: "Inbox",
  dispatching: "Dispatching",
  running: "Running",
  awaiting_review: "Awaiting review",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_COLORS: Record<CloudAgentTaskStatus, string> = {
  inbox: "text-[var(--text-secondary)]",
  dispatching: "text-amber-400",
  running: "text-blue-400",
  awaiting_review: "text-purple-400",
  completed: "text-emerald-400",
  failed: "text-red-400",
  cancelled: "text-[var(--text-disabled)]",
};

const fieldInputClass =
  "box-border h-[30px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] font-mono text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]";

function CopyableValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-[8px]">
      <code className="min-w-0 flex-1 truncate rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[4px] font-mono text-[11px] text-[var(--text-secondary)]">
        {value}
      </code>
      <button
        type="button"
        className={rowButtonClass}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
      >
        {copied ? (
          <Check className="size-[13px] text-emerald-400" strokeWidth={2} aria-hidden />
        ) : (
          <Copy className="size-[13px]" strokeWidth={1.5} aria-hidden />
        )}
      </button>
    </div>
  );
}

function ProviderConnectionCard({
  provider,
  settings,
  webhookUrl,
  busy,
  onSaveToken,
  onSaveWebhookSecret,
  onSaveOAuthApp,
  onStartOAuth,
  onDisconnect,
}: {
  provider: (typeof PROVIDERS)[number];
  settings: CloudAgentSettingsPublic;
  webhookUrl?: string;
  busy: boolean;
  onSaveToken: (token: string, webhookSecret: string) => Promise<void>;
  onSaveWebhookSecret: (secret: string) => Promise<void>;
  onSaveOAuthApp: (clientId: string, clientSecret: string) => Promise<void>;
  onStartOAuth: () => Promise<void>;
  onDisconnect: () => Promise<void>;
}) {
  const connection = settings.connections.find((entry) => entry.providerId === provider.id);
  const oauthApp = settings.oauthApps.find((entry) => entry.providerId === provider.id);
  const [token, setToken] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [clientId, setClientId] = useState(oauthApp?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [showOAuthApp, setShowOAuthApp] = useState(false);

  return (
    <div className="border-b border-[var(--border-subtle)] px-[16px] py-[14px] last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-[10px]">
        <div className="flex min-w-0 items-center gap-[10px]">
          {provider.id === "github" ? (
            <Github className="size-[16px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.5} aria-hidden />
          ) : (
            <MessageSquare className="size-[16px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.5} aria-hidden />
          )}
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-[8px] font-sans text-[13px] font-medium text-[var(--text-primary)]">
              {provider.label}
              {connection ? (
                <span className={`${tagClass} !text-emerald-400`}>
                  Connected · {connection.method === "oauth" ? "OAuth" : "Token"} ·{" "}
                  {connection.accountLabel ?? `…${connection.tokenLastFour}`}
                </span>
              ) : (
                <span className={tagClass}>Not connected</span>
              )}
            </p>
            <p className="mt-[3px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
              {provider.description}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-[8px]">
          <button
            type="button"
            className={rowButtonClass}
            disabled={busy}
            onClick={() => void onStartOAuth()}
            title={
              oauthApp
                ? `Start ${provider.label} OAuth in a popup`
                : "Requires OAuth app credentials below (or use a token)"
            }
          >
            Connect with OAuth
          </button>
          {connection ? (
            <button
              type="button"
              className={`${rowButtonClass} !text-red-400`}
              disabled={busy}
              onClick={() => void onDisconnect()}
            >
              <Unplug className="size-[13px]" strokeWidth={1.5} aria-hidden />
              Disconnect
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-[10px] grid gap-[8px] md:grid-cols-2">
        <div className="flex flex-col gap-[4px]">
          <SettingsFieldLabel>Personal access token</SettingsFieldLabel>
          <div className="flex items-center gap-[8px]">
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={provider.tokenHint}
              className={fieldInputClass}
              aria-label={`${provider.label} access token`}
            />
            <button
              type="button"
              className={rowButtonClass}
              disabled={busy || !token.trim()}
              onClick={() => {
                void onSaveToken(token.trim(), webhookSecret.trim()).then(() => {
                  setToken("");
                  setWebhookSecret("");
                });
              }}
            >
              Save
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-[4px]">
          <SettingsFieldLabel>
            {provider.id === "slack" ? "Signing secret" : "Webhook secret"}
            {connection?.webhookSecretConfigured ? " (configured)" : ""}
          </SettingsFieldLabel>
          <div className="flex items-center gap-[8px]">
            <input
              type="password"
              value={webhookSecret}
              onChange={(event) => setWebhookSecret(event.target.value)}
              placeholder="Used to verify inbound webhooks"
              className={fieldInputClass}
              aria-label={`${provider.label} webhook secret`}
            />
            {connection ? (
              <button
                type="button"
                className={rowButtonClass}
                disabled={busy || !webhookSecret.trim()}
                onClick={() => {
                  void onSaveWebhookSecret(webhookSecret.trim()).then(() => setWebhookSecret(""));
                }}
              >
                Save
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {webhookUrl ? (
        <div className="mt-[8px] flex flex-col gap-[4px]">
          <SettingsFieldLabel>Webhook endpoint (register this in {provider.label})</SettingsFieldLabel>
          <CopyableValue value={webhookUrl} label={`${provider.label} webhook URL`} />
        </div>
      ) : null}

      <button
        type="button"
        className="mt-[8px] font-sans text-[11px] text-[var(--text-secondary)] underline-offset-2 hover:underline"
        onClick={() => setShowOAuthApp((open) => !open)}
      >
        {showOAuthApp ? "Hide OAuth app credentials" : "OAuth app credentials…"}
      </button>
      {showOAuthApp ? (
        <div className="mt-[6px] grid gap-[8px] md:grid-cols-2">
          <div className="flex flex-col gap-[4px]">
            <SettingsFieldLabel>Client ID{oauthApp ? " (saved)" : ""}</SettingsFieldLabel>
            <input
              type="text"
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              placeholder="OAuth client id"
              className={fieldInputClass}
              aria-label={`${provider.label} OAuth client id`}
            />
          </div>
          <div className="flex flex-col gap-[4px]">
            <SettingsFieldLabel>Client secret</SettingsFieldLabel>
            <div className="flex items-center gap-[8px]">
              <input
                type="password"
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                placeholder={oauthApp?.clientSecretConfigured ? "••••••••" : "OAuth client secret"}
                className={fieldInputClass}
                aria-label={`${provider.label} OAuth client secret`}
              />
              <button
                type="button"
                className={rowButtonClass}
                disabled={busy || !clientId.trim() || !clientSecret.trim()}
                onClick={() => {
                  void onSaveOAuthApp(clientId.trim(), clientSecret.trim()).then(() =>
                    setClientSecret("")
                  );
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TaskCard({
  task,
  workspacesById,
  busy,
  onDispatch,
  onSteer,
  onCancel,
  onComplete,
  onDelete,
  onPostUpdate,
}: {
  task: CloudAgentTaskRecord;
  workspacesById: Map<string, WorkspaceRecord>;
  busy: boolean;
  onDispatch: () => Promise<void>;
  onSteer: (text: string) => Promise<void>;
  onCancel: () => Promise<void>;
  onComplete: () => Promise<void>;
  onDelete: () => Promise<void>;
  onPostUpdate: () => Promise<void>;
}) {
  const [steerText, setSteerText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [artifacts, setArtifacts] = useState<CloudAgentTaskArtifact[] | null>(null);
  const workspaceName = task.workspaceId
    ? workspacesById.get(task.workspaceId)?.name ?? task.workspaceId
    : "Unrouted";
  const canSteer =
    Boolean(task.conversationId) &&
    (task.status === "running" || task.status === "awaiting_review");
  const canPostUpdate = task.source.providerId !== "manual";

  useEffect(() => {
    if (!expanded) {
      return;
    }
    let alive = true;
    void fetchCloudAgentTaskArtifacts(task.id)
      .then((result) => {
        if (alive) setArtifacts(result.artifacts);
      })
      .catch(() => {
        if (alive) setArtifacts([]);
      });
    return () => {
      alive = false;
    };
  }, [expanded, task.id, task.updatedAt]);

  return (
    <div className="border-b border-[var(--border-subtle)] px-[16px] py-[12px] last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-[8px]">
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          className="flex min-w-0 flex-1 flex-col items-start text-left"
        >
          <span className="flex w-full min-w-0 flex-wrap items-center gap-[8px]">
            <span className="min-w-0 truncate font-sans text-[13px] font-medium text-[var(--text-primary)]">
              {task.title}
            </span>
            <span className={`${tagClass} ${STATUS_COLORS[task.status]}`}>
              {STATUS_LABELS[task.status]}
            </span>
            {task.unverified ? (
              <span className={`${tagClass} !text-amber-400`}>unverified</span>
            ) : null}
          </span>
          <span className="mt-[3px] font-sans text-[11px] text-[var(--text-secondary)]">
            {task.source.providerId} · {workspaceName}
            {task.backendId ? ` · ${HARNESS_LABELS[task.backendId] ?? task.backendId}` : ""}
            {task.modelId ? ` · ${task.modelId}` : ""}
            {task.branch ? ` · ${task.branch}` : ""}
          </span>
        </button>
        <div className="flex shrink-0 flex-wrap items-center gap-[6px]">
          {task.status === "inbox" || task.status === "failed" ? (
            <button
              type="button"
              className={rowButtonClass}
              disabled={busy}
              onClick={() => void onDispatch()}
            >
              <Send className="size-[13px]" strokeWidth={1.5} aria-hidden />
              Dispatch
            </button>
          ) : null}
          {task.status === "running" || task.status === "dispatching" ? (
            <button
              type="button"
              className={rowButtonClass}
              disabled={busy}
              onClick={() => void onCancel()}
            >
              <X className="size-[13px]" strokeWidth={1.5} aria-hidden />
              Cancel
            </button>
          ) : null}
          {task.status === "awaiting_review" ? (
            <button
              type="button"
              className={rowButtonClass}
              disabled={busy}
              onClick={() => void onComplete()}
            >
              <Check className="size-[13px]" strokeWidth={1.5} aria-hidden />
              Complete
            </button>
          ) : null}
          {canPostUpdate && (task.status === "awaiting_review" || task.status === "completed") ? (
            <button
              type="button"
              className={rowButtonClass}
              disabled={busy}
              onClick={() => void onPostUpdate()}
              title="Post a progress comment (with artifact list) back to the source"
            >
              Post update
            </button>
          ) : null}
          <button
            type="button"
            className={`${rowButtonClass} !text-red-400`}
            disabled={busy}
            onClick={() => void onDelete()}
            aria-label="Delete task"
            title="Delete task"
          >
            <Trash2 className="size-[13px]" strokeWidth={1.5} aria-hidden />
          </button>
        </div>
      </div>

      {canSteer ? (
        <div className="mt-[8px] flex items-center gap-[8px]">
          <input
            type="text"
            value={steerText}
            onChange={(event) => setSteerText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && steerText.trim()) {
                void onSteer(steerText.trim()).then(() => setSteerText(""));
              }
            }}
            placeholder="Steer the agent: refine, redirect, or ask for a demo video…"
            className={fieldInputClass}
            aria-label="Steer this task"
          />
          <button
            type="button"
            className={rowButtonClass}
            disabled={busy || !steerText.trim()}
            onClick={() => void onSteer(steerText.trim()).then(() => setSteerText(""))}
          >
            Steer
          </button>
        </div>
      ) : null}

      {expanded ? (
        <div className="mt-[10px] flex flex-col gap-[8px]">
          {task.lastError ? (
            <p className="font-sans text-[11px] text-red-400">{task.lastError}</p>
          ) : null}
          {artifacts && artifacts.length > 0 ? (
            <div>
              <SettingsFieldLabel>Demonstration artifacts</SettingsFieldLabel>
              <ul className="mt-[4px] flex flex-col gap-[2px]">
                {artifacts.map((artifact) => (
                  <li key={artifact.name} className="font-mono text-[11px] text-[var(--text-secondary)]">
                    {artifact.name} · {(artifact.size / 1024).toFixed(1)} KB
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div>
            <SettingsFieldLabel>Timeline</SettingsFieldLabel>
            <ul className="mt-[4px] flex flex-col gap-[2px]">
              {task.timeline.length === 0 ? (
                <li className="font-sans text-[11px] text-[var(--text-disabled)]">No events yet.</li>
              ) : (
                [...task.timeline].reverse().map((entry, index) => (
                  <li key={`${entry.at}-${index}`} className="font-sans text-[11px] text-[var(--text-secondary)]">
                    <span className="text-[var(--text-disabled)]">
                      {new Date(entry.at).toLocaleTimeString()}
                    </span>{" "}
                    · {entry.message}
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function CloudAgentsSettingsPanel() {
  const [settings, setSettings] = useState<CloudAgentSettingsPublic | null>(null);
  const [endpoints, setEndpoints] = useState<CloudAgentEndpoints | null>(null);
  const [tasks, setTasks] = useState<CloudAgentTaskRecord[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [newRuleProvider, setNewRuleProvider] = useState<CloudAgentProviderId | "any">("any");
  const [newRuleMatch, setNewRuleMatch] = useState("");
  const [newRuleWorkspaceId, setNewRuleWorkspaceId] = useState("");

  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskPrompt, setNewTaskPrompt] = useState("");
  const [newTaskWorkspaceId, setNewTaskWorkspaceId] = useState("");

  const workspacesById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces]
  );
  const selectableWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.kind !== "standalone-chat"),
    [workspaces]
  );

  const refresh = useCallback(async () => {
    const [settingsResult, tasksResult, workspacesResult] = await Promise.all([
      fetchCloudAgentSettings(),
      fetchCloudAgentTasks(),
      fetchWorkspaces().catch(() => null),
    ]);
    setSettings(settingsResult.settings);
    setEndpoints(settingsResult.endpoints);
    setTasks(tasksResult.tasks);
    if (workspacesResult) {
      setWorkspaces(workspacesResult.workspaces);
    }
  }, []);

  useEffect(() => {
    void refresh().catch((refreshError) => {
      setError(refreshError instanceof Error ? refreshError.message : "Failed to load Cloud Agents.");
    });
  }, [refresh]);

  // Live-ish task list while agents run.
  useEffect(() => {
    const hasActive = tasks.some(
      (task) => task.status === "running" || task.status === "dispatching"
    );
    if (!hasActive) {
      return;
    }
    const timer = window.setInterval(() => {
      void fetchCloudAgentTasks()
        .then((result) => setTasks(result.tasks))
        .catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [tasks]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "opencursor-cloud-agents-oauth") {
        void refresh();
        setMessage("Provider connected via OAuth.");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [refresh]);

  const runAction = useCallback(
    async (action: () => Promise<void>, successMessage?: string) => {
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        await action();
        if (successMessage) {
          setMessage(successMessage);
        }
      } catch (actionError) {
        setError(actionError instanceof Error ? actionError.message : "Action failed.");
      } finally {
        setBusy(false);
      }
    },
    []
  );

  if (!settings) {
    return (
      <div>
        <PageIntro title="Cloud Agents" />
        <p className="flex items-center gap-[8px] font-sans text-[13px] text-[var(--text-secondary)]">
          <Loader2 className="size-[14px] animate-spin" strokeWidth={1.5} aria-hidden />
          {error ?? "Loading Cloud Agents settings…"}
        </p>
      </div>
    );
  }

  return (
    <div>
      <PageIntro title="Cloud Agents" />
      <p className="-mt-[8px] mb-[16px] font-sans text-[13px] leading-relaxed text-[var(--text-secondary)]">
        Offload work from Linear, GitHub, and Slack to agents running in this Cesium server.
        Inbound assignments are filtered to the right workspace, run on your chosen harness and
        model, and can be steered turn-by-turn. Agents work on isolated branches by default and
        save demonstration media for sharing back to the source.
      </p>

      {message ? (
        <p className="mb-[12px] rounded-[var(--radius-tab)] border border-emerald-500/30 bg-emerald-500/10 px-[10px] py-[6px] font-sans text-[12px] text-emerald-400">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="mb-[12px] rounded-[var(--radius-tab)] border border-red-500/30 bg-red-500/10 px-[10px] py-[6px] font-sans text-[12px] text-red-400">
          {error}
        </p>
      ) : null}

      <SettingsSection title="Connections">
        {PROVIDERS.map((provider) => (
          <ProviderConnectionCard
            key={provider.id}
            provider={provider}
            settings={settings}
            webhookUrl={endpoints?.webhooks[provider.id]}
            busy={busy}
            onSaveToken={(accessToken, webhookSecret) =>
              runAction(async () => {
                const result = await saveCloudAgentConnectionToken({
                  providerId: provider.id,
                  accessToken,
                  ...(webhookSecret ? { webhookSecret } : {}),
                });
                setSettings(result.settings);
              }, `${provider.label} connected.`)
            }
            onSaveWebhookSecret={(webhookSecret) =>
              runAction(async () => {
                const result = await saveCloudAgentWebhookSecret({
                  providerId: provider.id,
                  webhookSecret,
                });
                setSettings(result.settings);
              }, `${provider.label} webhook secret saved.`)
            }
            onSaveOAuthApp={(clientId, clientSecret) =>
              runAction(async () => {
                const result = await saveCloudAgentOAuthApp({
                  providerId: provider.id,
                  clientId,
                  clientSecret,
                });
                setSettings(result.settings);
              }, `${provider.label} OAuth app saved.`)
            }
            onStartOAuth={() =>
              runAction(async () => {
                const result = await startCloudAgentOAuth(provider.id);
                window.open(result.authUrl, "_blank", "noopener,noreferrer,width=560,height=760");
                setMessage(
                  `Complete the ${provider.label} authorization in the popup, then return here.`
                );
              })
            }
            onDisconnect={() =>
              runAction(async () => {
                const result = await deleteCloudAgentConnection(provider.id);
                setSettings(result.settings);
              }, `${provider.label} disconnected.`)
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection title="Defaults">
        <SettingsRow
          title="Default agent harness"
          description="Harness used when a routing rule doesn't pick one."
          searchId="cloud-agents-default-harness"
          trailing={
            <select
              className={settingsSelectTriggerClass}
              value={settings.defaults.backendId}
              disabled={busy}
              aria-label="Default agent harness"
              onChange={(event) =>
                runAction(async () => {
                  const result = await patchCloudAgentSettings({
                    defaults: { backendId: event.target.value as AgentBackendId },
                  });
                  setSettings(result.settings);
                })
              }
            >
              {HARNESS_ORDER.map((backendId) => (
                <option key={backendId} value={backendId}>
                  {HARNESS_LABELS[backendId]}
                </option>
              ))}
            </select>
          }
        />
        <SettingsRow
          title="Default model"
          description="Optional model id override passed to the harness (e.g. openai/gpt-5.1 or glm-5.2)."
          searchId="cloud-agents-default-model"
          trailing={
            <input
              type="text"
              defaultValue={settings.defaults.modelId ?? ""}
              placeholder="Harness default"
              className={`${fieldInputClass} !w-[220px]`}
              aria-label="Default model id"
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (value === (settings.defaults.modelId ?? "")) {
                  return;
                }
                void runAction(async () => {
                  const result = await patchCloudAgentSettings({
                    defaults: { modelId: value || null },
                  });
                  setSettings(result.settings);
                });
              }}
            />
          }
        />
        <SettingsRow
          title="Execution mode"
          description="Isolated creates a dedicated git worktree branch per task so the main checkout stays untouched; local works directly in the workspace."
          searchId="cloud-agents-execution-mode"
          trailing={
            <select
              className={settingsSelectTriggerClass}
              value={settings.defaults.executionMode}
              disabled={busy}
              aria-label="Execution mode"
              onChange={(event) =>
                runAction(async () => {
                  const result = await patchCloudAgentSettings({
                    defaults: {
                      executionMode: event.target.value as CloudAgentExecutionMode,
                    },
                  });
                  setSettings(result.settings);
                })
              }
            >
              <option value="isolated">Isolated (worktree branch)</option>
              <option value="local">Local (workspace checkout)</option>
            </select>
          }
        />
        <SettingsRow
          title="Auto-dispatch assignments"
          description="Start the agent immediately when a webhook assignment arrives, instead of waiting in the inbox."
          searchId="cloud-agents-auto-dispatch"
          trailing={
            <ToggleSwitch
              checked={settings.defaults.autoDispatch}
              onChange={(next) =>
                void runAction(async () => {
                  const result = await patchCloudAgentSettings({
                    defaults: { autoDispatch: next },
                  });
                  setSettings(result.settings);
                })
              }
            />
          }
        />
        <SettingsRow
          title="Fallback workspace"
          description="Workspace used when no routing rule matches an assignment."
          searchId="cloud-agents-fallback-workspace"
          trailing={
            <select
              className={settingsSelectTriggerClass}
              value={settings.defaults.workspaceId ?? ""}
              disabled={busy}
              aria-label="Fallback workspace"
              onChange={(event) =>
                runAction(async () => {
                  const result = await patchCloudAgentSettings({
                    defaults: { workspaceId: event.target.value || null },
                  });
                  setSettings(result.settings);
                })
              }
            >
              <option value="">Profile default</option>
              {selectableWorkspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Workspace routing">
        <div className="px-[16px] py-[12px]">
          <p className="mb-[10px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
            First matching rule wins. The match text is compared against the assignment&apos;s
            repository, Linear team/project, Slack channel, and labels.
          </p>
          {settings.routingRules.length > 0 ? (
            <ul className="mb-[10px] flex flex-col gap-[6px]">
              {settings.routingRules.map((rule) => (
                <li key={rule.id} className="flex flex-wrap items-center gap-[8px]">
                  <span className={tagClass}>{rule.providerId}</span>
                  <span className="font-mono text-[11px] text-[var(--text-secondary)]">
                    {rule.match || "(everything)"}
                  </span>
                  <span className="font-sans text-[11px] text-[var(--text-disabled)]">→</span>
                  <span className="font-sans text-[12px] text-[var(--text-primary)]">
                    {workspacesById.get(rule.workspaceId)?.name ?? rule.workspaceId}
                  </span>
                  {rule.backendId ? (
                    <span className={tagClass}>{HARNESS_LABELS[rule.backendId] ?? rule.backendId}</span>
                  ) : null}
                  <button
                    type="button"
                    className={`${rowButtonClass} !px-[8px] !py-[3px] !text-red-400`}
                    disabled={busy}
                    aria-label="Remove routing rule"
                    onClick={() =>
                      void runAction(async () => {
                        const result = await patchCloudAgentSettings({
                          routingRules: settings.routingRules.filter(
                            (candidate) => candidate.id !== rule.id
                          ),
                        });
                        setSettings(result.settings);
                      })
                    }
                  >
                    <Trash2 className="size-[12px]" strokeWidth={1.5} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-[10px] font-sans text-[12px] text-[var(--text-disabled)]">
              No routing rules yet — assignments go to the fallback workspace.
            </p>
          )}
          <div className="flex flex-wrap items-end gap-[8px]">
            <div className="flex flex-col gap-[4px]">
              <SettingsFieldLabel>Provider</SettingsFieldLabel>
              <select
                className={settingsSelectTriggerClass}
                value={newRuleProvider}
                aria-label="Rule provider"
                onChange={(event) =>
                  setNewRuleProvider(event.target.value as CloudAgentProviderId | "any")
                }
              >
                <option value="any">Any</option>
                <option value="linear">Linear</option>
                <option value="github">GitHub</option>
                <option value="slack">Slack</option>
              </select>
            </div>
            <div className="flex min-w-[160px] flex-1 flex-col gap-[4px]">
              <SettingsFieldLabel>Match (repo, team, project, channel, label)</SettingsFieldLabel>
              <input
                type="text"
                value={newRuleMatch}
                onChange={(event) => setNewRuleMatch(event.target.value)}
                placeholder="e.g. owner/repo or OSP"
                className={fieldInputClass}
                aria-label="Rule match text"
              />
            </div>
            <div className="flex flex-col gap-[4px]">
              <SettingsFieldLabel>Workspace</SettingsFieldLabel>
              <select
                className={settingsSelectTriggerClass}
                value={newRuleWorkspaceId}
                aria-label="Rule workspace"
                onChange={(event) => setNewRuleWorkspaceId(event.target.value)}
              >
                <option value="">Choose…</option>
                {selectableWorkspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className={rowButtonClass}
              disabled={busy || !newRuleWorkspaceId}
              onClick={() =>
                void runAction(async () => {
                  const rule: CloudAgentRoutingRule = {
                    id: `rule-${Date.now().toString(36)}`,
                    providerId: newRuleProvider,
                    match: newRuleMatch.trim(),
                    workspaceId: newRuleWorkspaceId,
                  };
                  const result = await patchCloudAgentSettings({
                    routingRules: [...settings.routingRules, rule],
                  });
                  setSettings(result.settings);
                  setNewRuleMatch("");
                  setNewRuleWorkspaceId("");
                }, "Routing rule added.")
              }
            >
              <Plus className="size-[13px]" strokeWidth={1.5} aria-hidden />
              Add rule
            </button>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Tasks"
        action={
          <button
            type="button"
            className={rowButtonClass}
            disabled={busy}
            onClick={() => void refresh().catch(() => undefined)}
          >
            <RefreshCw className="size-[13px]" strokeWidth={1.5} aria-hidden />
            Refresh
          </button>
        }
      >
        <div className="border-b border-[var(--border-subtle)] px-[16px] py-[12px]">
          <SettingsSubsectionHeading>New manual task</SettingsSubsectionHeading>
          <div className="flex flex-wrap items-end gap-[8px]">
            <div className="flex min-w-[160px] flex-1 flex-col gap-[4px]">
              <SettingsFieldLabel>Title</SettingsFieldLabel>
              <input
                type="text"
                value={newTaskTitle}
                onChange={(event) => setNewTaskTitle(event.target.value)}
                placeholder="What should the agent do?"
                className={fieldInputClass}
                aria-label="New task title"
              />
            </div>
            <div className="flex min-w-[200px] flex-[2] flex-col gap-[4px]">
              <SettingsFieldLabel>Instructions (optional)</SettingsFieldLabel>
              <input
                type="text"
                value={newTaskPrompt}
                onChange={(event) => setNewTaskPrompt(event.target.value)}
                placeholder="Details, constraints, links…"
                className={fieldInputClass}
                aria-label="New task instructions"
              />
            </div>
            <div className="flex flex-col gap-[4px]">
              <SettingsFieldLabel>Workspace</SettingsFieldLabel>
              <select
                className={settingsSelectTriggerClass}
                value={newTaskWorkspaceId}
                aria-label="New task workspace"
                onChange={(event) => setNewTaskWorkspaceId(event.target.value)}
              >
                <option value="">Routed / fallback</option>
                {selectableWorkspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className={rowButtonClass}
              disabled={busy || !newTaskTitle.trim()}
              onClick={() =>
                void runAction(async () => {
                  await createCloudAgentTask({
                    title: newTaskTitle.trim(),
                    prompt: newTaskPrompt.trim(),
                    ...(newTaskWorkspaceId ? { workspaceId: newTaskWorkspaceId } : {}),
                  });
                  setNewTaskTitle("");
                  setNewTaskPrompt("");
                  await refresh();
                }, "Task created in the inbox.")
              }
            >
              <Plus className="size-[13px]" strokeWidth={1.5} aria-hidden />
              Create
            </button>
          </div>
        </div>
        {tasks.length === 0 ? (
          <p className="px-[16px] py-[14px] font-sans text-[12px] text-[var(--text-disabled)]">
            No Cloud Agent tasks yet. Assign an issue, mention the Slack app, or create one above.
          </p>
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              workspacesById={workspacesById}
              busy={busy}
              onDispatch={() =>
                runAction(async () => {
                  await dispatchCloudAgentTask(task.id);
                  await refresh();
                }, "Task dispatched.")
              }
              onSteer={(text) =>
                runAction(async () => {
                  await steerCloudAgentTask(task.id, text);
                  await refresh();
                }, "Steering message sent.")
              }
              onCancel={() =>
                runAction(async () => {
                  await cancelCloudAgentTask(task.id);
                  await refresh();
                })
              }
              onComplete={() =>
                runAction(async () => {
                  await completeCloudAgentTask(task.id);
                  await refresh();
                })
              }
              onDelete={() =>
                runAction(async () => {
                  await deleteCloudAgentTask(task.id);
                  await refresh();
                })
              }
              onPostUpdate={() =>
                runAction(async () => {
                  await postCloudAgentTaskUpdate(task.id, { includeArtifacts: true });
                  await refresh();
                }, "Update posted to the source.")
              }
            />
          ))
        )}
      </SettingsSection>

      {endpoints ? (
        <SettingsSection title="Endpoints">
          <div className="flex flex-col gap-[10px] px-[16px] py-[12px]">
            <div className="flex flex-col gap-[4px]">
              <SettingsFieldLabel>OAuth callback URL (register in your OAuth apps)</SettingsFieldLabel>
              <CopyableValue value={endpoints.oauthCallbackUrl} label="OAuth callback URL" />
            </div>
          </div>
        </SettingsSection>
      ) : null}
    </div>
  );
}
