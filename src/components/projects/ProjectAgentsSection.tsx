"use client";

import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import {
  ExternalLink,
  FileText,
  LoaderCircle,
  MessageSquarePlus,
  Pencil,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  PROJECT_HOME_ENGINE_ID,
  isProjectChildRemote,
  normalizeProjectAgentName,
  projectChildBucketLabel,
  projectDeliveryLabel,
  sameProjectEngineUrl,
  sortProjectChildren,
  type ProjectChildSummary,
  type ProjectEngineListing,
  type ProjectEngineSummary,
  type ProjectSnapshot,
} from "@cesium/core";
import { useWorkbenchDialogs } from "@/components/dialogs/WorkbenchDialogProvider";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { formatAgentRailRelativeTime } from "@/lib/agent-rail-status";
import {
  createProjectAgent,
  deleteProjectAgent,
  fetchProjectAgentTranscript,
  listProjectEngineListings,
  messageProjectAgent,
  patchProjectAgent,
  stopProjectAgent,
} from "@/lib/server-api";
import {
  ProjectEngineBadge,
  ProjectStatusDot,
  projectButtonClass,
  projectDangerButtonClass,
  projectErrorMessage,
  projectErrorTextClass,
  projectHintTextClass,
  projectInputClass,
  projectPrimaryButtonClass,
  projectSectionLabelClass,
  projectSelectClass,
} from "./project-ui";
import { useProjects } from "./ProjectsProvider";

const TRANSCRIPT_TURN_CHOICES = [1, 3, 10] as const;

export function ProjectAgentsSection({ snapshot }: { snapshot: ProjectSnapshot }) {
  const [showDeleted, setShowDeleted] = useState(false);
  const [creating, setCreating] = useState(false);
  const deletedCount = snapshot.children.filter((child) => child.deletedAt != null).length;
  const children = useMemo(
    () =>
      sortProjectChildren(
        snapshot.children.filter((child) => showDeleted || child.deletedAt == null)
      ),
    [showDeleted, snapshot.children]
  );

  return (
    <div className="flex flex-col gap-[10px] px-[16px] py-[12px]">
      <div className="flex items-center gap-[10px]">
        <span className={`${projectSectionLabelClass} flex-1`}>Agents</span>
        {deletedCount > 0 ? (
          <label className="inline-flex cursor-pointer items-center gap-[5px] font-sans text-[11.5px] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={showDeleted}
              onChange={(event) => setShowDeleted(event.target.checked)}
              className="accent-[var(--accent)]"
            />
            Show deleted ({deletedCount})
          </label>
        ) : null}
        <button
          type="button"
          onClick={() => setCreating((current) => !current)}
          className={creating ? projectButtonClass : projectPrimaryButtonClass}
          aria-expanded={creating}
        >
          <Plus className="size-[13px]" strokeWidth={1.8} aria-hidden />
          New agent
        </button>
      </div>
      {creating ? <NewAgentForm snapshot={snapshot} onDone={() => setCreating(false)} /> : null}
      {children.length === 0 ? (
        <p className={`${projectHintTextClass} py-[8px]`}>
          No agents yet. Ask the orchestrator to split up the work, or start one here.
        </p>
      ) : (
        <ul className="flex flex-col gap-[8px]" data-testid="project-agent-list">
          {children.map((child) => (
            <ProjectAgentCard
              key={child.id}
              projectId={snapshot.id}
              child={child}
              engine={snapshot.engines.find((engine) => engine.id === child.engineId) ?? null}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ProjectAgentCard({
  projectId,
  child,
  engine,
}: {
  projectId: string;
  child: ProjectChildSummary;
  engine: ProjectEngineSummary | null;
}) {
  const dialogs = useWorkbenchDialogs();
  const { openChildConversation, refreshProject } = useProjects();
  const { servers } = useServerConnections();
  const [expanded, setExpanded] = useState<"message" | "transcript" | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const remote = isProjectChildRemote(child);
  const deleted = child.deletedAt != null;
  const busy = child.bucket === "working" || child.bucket === "needs_attention";
  const remoteServer = remote
    ? (servers.find((server) => sameProjectEngineUrl(server.baseUrl, engine?.baseUrl)) ?? null)
    : null;
  const openable = !deleted && (!remote || remoteServer != null);

  const act = async (id: string, action: () => Promise<string | null>) => {
    setPendingAction(id);
    setError(null);
    setNotice(null);
    try {
      const message = await action();
      if (message) setNotice(message);
      await refreshProject(projectId);
    } catch (caught) {
      setError(projectErrorMessage(caught));
    } finally {
      setPendingAction(null);
    }
  };

  const open = () =>
    void openChildConversation(
      projectId,
      child,
      remoteServer ? { id: remoteServer.id, label: remoteServer.label } : undefined
    );

  const stop = () =>
    act("stop", async () => {
      const result = await stopProjectAgent(projectId, child.id);
      return result.stopped ? "Stopped." : "It was not running.";
    });

  const rename = async () => {
    const name = await dialogs.prompt({
      title: "Rename agent",
      message: "Handles are lowercase letters, digits and dashes; the orchestrator uses them to address agents.",
      defaultValue: child.name,
      confirmLabel: "Rename",
      monospace: true,
      validate: (value) =>
        normalizeProjectAgentName(value) ? null : "Use at least one letter or digit.",
    });
    if (!name || normalizeProjectAgentName(name) === child.name) {
      return;
    }
    await act("rename", async () => {
      const renamed = await patchProjectAgent(projectId, child.id, { name });
      return `Renamed to ${renamed.name}.`;
    });
  };

  const remove = async () => {
    const confirmed = await dialogs.confirm({
      title: `Delete ${child.name}?`,
      message: "Stops the agent and deletes its conversation. It stays listed under deleted agents.",
      confirmLabel: "Delete agent",
      tone: "danger",
    });
    if (!confirmed) {
      return;
    }
    await act("delete", async () => {
      await deleteProjectAgent(projectId, child.id);
      setExpanded(null);
      return null;
    });
  };

  const model = child.modelName ?? child.modelId;
  const activity = child.updatedAt ?? child.createdAt;

  return (
    <li
      className={`rounded-[8px] border bg-[var(--bg-panel)] ${
        child.bucket === "needs_attention"
          ? "border-[color-mix(in_srgb,var(--status-warning)_55%,var(--border-card))]"
          : "border-[var(--border-card)]"
      } ${deleted ? "opacity-60" : ""}`}
      data-project-agent={child.name}
    >
      <div className="flex flex-col gap-[6px] px-[10px] py-[8px]">
        <div className="flex min-w-0 items-center gap-[7px]">
          <ProjectStatusDot bucket={child.bucket} />
          <span className="min-w-0 truncate font-mono text-[12.5px] font-medium text-[var(--text-primary)]">
            {child.name}
          </span>
          <span className="shrink-0 font-sans text-[11px] text-[var(--text-secondary)]">
            {projectChildBucketLabel(child.bucket)}
          </span>
          <span className="flex-1" />
          <ProjectEngineBadge label={child.engineLabel} remote={remote} />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-[8px] gap-y-[2px] font-sans text-[11px] text-[var(--text-secondary)]">
          <span>{child.backendId}</span>
          {model ? <code className="truncate font-mono text-[10.5px]">{model}</code> : null}
          <span>{child.repoName ?? "Scratch space"}</span>
          <span className="tabular-nums">
            {child.turnsCompleted} {child.turnsCompleted === 1 ? "turn" : "turns"}
          </span>
          {child.queued > 0 ? <span className="tabular-nums">{child.queued} queued</span> : null}
          <span>{formatAgentRailRelativeTime(activity)}</span>
          {child.createdBy === "user" ? <span>Started by you</span> : null}
        </div>
        {child.attention ? (
          <p className="flex items-start gap-[6px] rounded-[6px] bg-[color-mix(in_srgb,var(--status-warning)_12%,transparent)] px-[8px] py-[5px] font-sans text-[12px] text-[var(--text-primary)]">
            <TriangleAlert className="mt-[2px] size-[12px] shrink-0 text-[var(--status-warning)]" strokeWidth={1.8} aria-hidden />
            <span className="min-w-0">
              {child.attention.title}
              {openable ? " Open the agent to respond." : ""}
            </span>
          </p>
        ) : null}
        {child.lastError && child.bucket === "failed" ? (
          <p className={`${projectErrorTextClass} line-clamp-3`}>{child.lastError}</p>
        ) : child.lastReplyPreview ? (
          <p className="line-clamp-3 whitespace-pre-wrap break-words font-sans text-[12px] leading-[1.45] text-[var(--text-primary)]">
            {child.lastReplyPreview}
          </p>
        ) : null}
        {!deleted ? (
          <div className="flex flex-wrap items-center gap-[4px] pt-[2px]">
            <button
              type="button"
              onClick={open}
              disabled={!openable}
              className={projectButtonClass}
              title={
                openable
                  ? `Open ${child.name}'s conversation`
                  : `Add ${engine?.baseUrl ?? child.engineLabel} as an engine connection to open this agent`
              }
            >
              <ExternalLink className="size-[12px]" strokeWidth={1.7} aria-hidden />
              Open
            </button>
            <button
              type="button"
              onClick={() => setExpanded((current) => (current === "message" ? null : "message"))}
              className={projectButtonClass}
              aria-expanded={expanded === "message"}
            >
              <MessageSquarePlus className="size-[12px]" strokeWidth={1.7} aria-hidden />
              Message
            </button>
            <button
              type="button"
              onClick={() => setExpanded((current) => (current === "transcript" ? null : "transcript"))}
              className={projectButtonClass}
              aria-expanded={expanded === "transcript"}
            >
              <FileText className="size-[12px]" strokeWidth={1.7} aria-hidden />
              Transcript
            </button>
            {busy ? (
              <button
                type="button"
                onClick={() => void stop()}
                disabled={pendingAction != null}
                className={projectButtonClass}
              >
                {pendingAction === "stop" ? (
                  <LoaderCircle className="size-[12px] animate-spin" aria-hidden />
                ) : (
                  <Square className="size-[11px]" strokeWidth={1.9} aria-hidden />
                )}
                Stop
              </button>
            ) : null}
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => void rename()}
              disabled={pendingAction != null}
              className={projectButtonClass}
              aria-label={`Rename ${child.name}`}
              title="Rename"
            >
              <Pencil className="size-[12px]" strokeWidth={1.7} />
            </button>
            <button
              type="button"
              onClick={() => void remove()}
              disabled={pendingAction != null}
              className={projectDangerButtonClass}
              aria-label={`Delete ${child.name}`}
              title="Delete"
            >
              {pendingAction === "delete" ? (
                <LoaderCircle className="size-[12px] animate-spin" aria-hidden />
              ) : (
                <Trash2 className="size-[12px]" strokeWidth={1.7} />
              )}
            </button>
          </div>
        ) : null}
        {notice ? (
          <p className="font-sans text-[11.5px] text-[var(--status-success)]" role="status">
            {notice}
          </p>
        ) : null}
        {error ? <p className={projectErrorTextClass}>{error}</p> : null}
      </div>
      {expanded === "message" && !deleted ? (
        <AgentMessageComposer
          projectId={projectId}
          child={child}
          busy={busy}
          onDelivered={(label) => {
            setNotice(label);
            setError(null);
            void refreshProject(projectId);
          }}
        />
      ) : null}
      {expanded === "transcript" && !deleted ? (
        <AgentTranscript projectId={projectId} child={child} />
      ) : null}
    </li>
  );
}

function AgentMessageComposer({
  projectId,
  child,
  busy,
  onDelivered,
}: {
  projectId: string;
  child: ProjectChildSummary;
  busy: boolean;
  onDelivered: (label: string) => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState<"steer" | "queue" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async (delivery: "steer" | "queue") => {
    const body = text.trim();
    if (!body || sending) {
      return;
    }
    setSending(delivery);
    setError(null);
    try {
      const result = await messageProjectAgent(projectId, child.id, { text: body, delivery });
      setText("");
      onDelivered(projectDeliveryLabel(result.delivery));
    } catch (caught) {
      setError(projectErrorMessage(caught));
    } finally {
      setSending(null);
    }
  };

  return (
    <div className="flex flex-col gap-[6px] border-t border-[var(--border-subtle)] px-[10px] py-[8px]">
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send(busy ? "steer" : "queue");
          }
        }}
        rows={3}
        placeholder={`Message ${child.name}…`}
        aria-label={`Message ${child.name}`}
        className={`${projectInputClass} resize-y leading-[1.45]`}
        autoFocus
      />
      <div className="flex flex-wrap items-center gap-[6px]">
        <p className={`${projectHintTextClass} min-w-0 flex-1`}>
          {busy
            ? "Steer redirects the running turn; Queue waits for the next one."
            : "The agent is idle, so either option starts a turn now."}
        </p>
        <button
          type="button"
          onClick={() => void send("queue")}
          disabled={!text.trim() || sending != null}
          className={projectButtonClass}
        >
          {sending === "queue" ? <LoaderCircle className="size-[12px] animate-spin" aria-hidden /> : null}
          Queue
        </button>
        <button
          type="button"
          onClick={() => void send("steer")}
          disabled={!text.trim() || sending != null}
          className={projectPrimaryButtonClass}
        >
          {sending === "steer" ? <LoaderCircle className="size-[12px] animate-spin" aria-hidden /> : null}
          Steer
        </button>
      </div>
      {error ? <p className={projectErrorTextClass}>{error}</p> : null}
    </div>
  );
}

function AgentTranscript({ projectId, child }: { projectId: string; child: ProjectChildSummary }) {
  const [turns, setTurns] = useState<number>(3);
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchProjectAgentTranscript(projectId, child.id, turns);
      setText(result.transcript);
    } catch (caught) {
      setError(projectErrorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [child.id, projectId, turns]);

  useEffect(() => {
    void load();
  }, [load, child.turnsCompleted, child.bucket]);

  return (
    <div className="flex flex-col gap-[6px] border-t border-[var(--border-subtle)] px-[10px] py-[8px]">
      <div className="flex items-center gap-[6px]">
        <span className={`${projectSectionLabelClass} flex-1`}>Transcript</span>
        <select
          value={turns}
          onChange={(event) => setTurns(Number(event.target.value))}
          aria-label="Turns to show"
          className="rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[4px] py-[1px] font-sans text-[11px] text-[var(--text-primary)]"
        >
          {TRANSCRIPT_TURN_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              Last {choice} {choice === 1 ? "turn" : "turns"}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex size-[22px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
          aria-label="Refresh transcript"
        >
          <RefreshCw className={`size-[12px] ${loading ? "animate-spin" : ""}`} strokeWidth={1.7} />
        </button>
      </div>
      {error ? (
        <p className={projectErrorTextClass}>{error}</p>
      ) : text == null ? (
        <p className={projectHintTextClass}>Loading transcript…</p>
      ) : (
        <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-[6px] border border-[var(--border-subtle)] bg-[var(--bg-card)] px-[8px] py-[6px] font-mono text-[11.5px] leading-[1.5] text-[var(--text-primary)]">
          {text.trim() || "Nothing yet."}
        </pre>
      )}
    </div>
  );
}

type AgentPlacement = { value: string; label: string; engineId: string; repoId: string | null };

function NewAgentForm({ snapshot, onDone }: { snapshot: ProjectSnapshot; onDone: () => void }) {
  const formId = useId();
  const { refreshProject } = useProjects();
  const [engines, setEngines] = useState<ProjectEngineListing[] | null>(null);
  const [enginesError, setEnginesError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [placementValue, setPlacementValue] = useState(
    snapshot.repos[0] ? `repo:${snapshot.repos[0].id}` : `engine:${PROJECT_HOME_ENGINE_ID}`
  );
  const [harness, setHarness] = useState("");
  const [model, setModel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listProjectEngineListings(snapshot.id)
      .then((listing) => {
        if (!cancelled) setEngines(listing);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setEnginesError(projectErrorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot.id]);

  const placements = useMemo<AgentPlacement[]>(() => {
    const labelFor = (engineId: string) =>
      snapshot.engines.find((engine) => engine.id === engineId)?.label ?? engineId;
    return [
      ...snapshot.repos.map((repo) => ({
        value: `repo:${repo.id}`,
        label: `${repo.name} · ${labelFor(repo.engineId)}`,
        engineId: repo.engineId,
        repoId: repo.id,
      })),
      ...snapshot.engines
        .filter((engine) => engine.online)
        .map((engine) => ({
          value: `engine:${engine.id}`,
          label: `Scratch space · ${engine.label}`,
          engineId: engine.id,
          repoId: null,
        })),
    ];
  }, [snapshot.engines, snapshot.repos]);

  const placement = placements.find((entry) => entry.value === placementValue) ?? placements[0] ?? null;
  const harnesses = useMemo(
    () => engines?.find((engine) => engine.id === placement?.engineId)?.harnesses ?? [],
    [engines, placement?.engineId]
  );
  const defaultHarness = snapshot.settings.defaultChildBackendId;
  const selectedHarness = harnesses.find((entry) => entry.id === (harness || defaultHarness));

  useEffect(() => {
    if (harness && engines && !harnesses.some((entry) => entry.id === harness)) {
      setHarness("");
    }
  }, [engines, harness, harnesses]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!normalizeProjectAgentName(name)) {
      setError("Give the agent a handle (letters, digits and dashes).");
      return;
    }
    if (!instructions.trim()) {
      setError("Tell the agent what to do.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createProjectAgent(snapshot.id, {
        name,
        instructions: instructions.trim(),
        repo: placement?.repoId ?? null,
        engine: placement?.engineId ?? null,
        harness: harness || null,
        model: model.trim() || null,
      });
      await refreshProject(snapshot.id);
      onDone();
    } catch (caught) {
      setError(projectErrorMessage(caught));
      setSubmitting(false);
    }
  };

  const fieldLabel = "font-sans text-[11.5px] font-medium text-[var(--text-secondary)]";

  return (
    <form
      onSubmit={(event) => void submit(event)}
      noValidate
      className="flex flex-col gap-[8px] rounded-[8px] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[10px] py-[10px]"
      aria-label="New agent"
    >
      <div className="grid grid-cols-1 gap-[8px] sm:grid-cols-2">
        <label className="flex flex-col gap-[4px]">
          <span className={fieldLabel}>Handle</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="api-tests"
            autoComplete="off"
            spellCheck={false}
            className={`${projectInputClass} font-mono`}
            autoFocus
          />
        </label>
        <label className="flex flex-col gap-[4px]">
          <span className={fieldLabel}>Runs in</span>
          <select
            value={placement?.value ?? ""}
            onChange={(event) => setPlacementValue(event.target.value)}
            className={projectSelectClass}
          >
            {placements.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-[4px]">
          <span className={fieldLabel}>Harness</span>
          <select
            value={harness}
            onChange={(event) => setHarness(event.target.value)}
            className={projectSelectClass}
            disabled={!engines}
          >
            <option value="">
              {engines == null
                ? "Loading harnesses…"
                : `Project default${defaultHarness ? ` (${defaultHarness})` : ""}`}
            </option>
            {harnesses.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-[4px]">
          <span className={fieldLabel}>Model</span>
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={
              selectedHarness?.defaultModelId
                ? `Default: ${selectedHarness.defaultModelId}`
                : snapshot.settings.defaultChildModelId
                  ? `Default: ${snapshot.settings.defaultChildModelId}`
                  : "Harness default"
            }
            autoComplete="off"
            spellCheck={false}
            className={`${projectInputClass} font-mono text-[12px]`}
          />
        </label>
      </div>
      <label className={fieldLabel} htmlFor={`${formId}-instructions`}>
        Instructions
      </label>
      <textarea
        id={`${formId}-instructions`}
        value={instructions}
        onChange={(event) => setInstructions(event.target.value)}
        rows={4}
        placeholder="What should this agent do, and what should it report back?"
        className={`${projectInputClass} resize-y leading-[1.45]`}
      />
      {enginesError ? <p className={projectErrorTextClass}>{enginesError}</p> : null}
      {error ? (
        <p role="alert" className={projectErrorTextClass}>
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-[6px]">
        <button type="button" onClick={onDone} disabled={submitting} className={projectButtonClass}>
          Cancel
        </button>
        <button type="submit" disabled={submitting} className={projectPrimaryButtonClass}>
          {submitting ? <LoaderCircle className="size-[12px] animate-spin" aria-hidden /> : null}
          Start agent
        </button>
      </div>
    </form>
  );
}
