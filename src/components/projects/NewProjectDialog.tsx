"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { FolderGit2, LoaderCircle, Network, Plus, X } from "lucide-react";
import { PROJECT_HOME_ENGINE_ID, type ProjectEngineListing } from "@cesium/core";
import {
  dialogBackdropClass,
  dialogFooterClass,
  dialogInputClass,
  dialogInputErrorClass,
  dialogLayerClass,
  dialogMessageClass,
  dialogPanelClass,
  dialogPrimaryButtonClass,
  dialogSecondaryButtonClass,
  dialogTitleClass,
} from "@/components/dialogs/workbench-dialog-ui";
import { BACK_INTENT_PRIORITY, useBackHandler } from "@/components/mobile/BackIntentContext";
import {
  createProject,
  listProjectEngineDetails,
  type ProjectRepoRequest,
} from "@/lib/server-api";
import { useProjects } from "./ProjectsProvider";

type RepoChoice = ProjectRepoRequest & { key: string; label: string; engineLabel: string };

const fieldLabelClass = "mt-[14px] block font-sans text-[11.5px] font-medium text-[var(--text-secondary)]";
const selectClass = `${dialogInputClass} mt-0 appearance-auto`;

export function NewProjectDialogHost() {
  const { newProjectOpen, setNewProjectOpen } = useProjects();
  if (!newProjectOpen) {
    return null;
  }
  return <NewProjectDialog onClose={() => setNewProjectOpen(false)} />;
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const { refresh, openProject } = useProjects();
  const titleId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState("");
  const [engines, setEngines] = useState<ProjectEngineListing[] | null>(null);
  const [enginesError, setEnginesError] = useState<string | null>(null);
  const [engineId, setEngineId] = useState(PROJECT_HOME_ENGINE_ID);
  const [workspaceId, setWorkspaceId] = useState("");
  const [typedPath, setTypedPath] = useState("");
  const [repos, setRepos] = useState<RepoChoice[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useBackHandler(true, BACK_INTENT_PRIORITY.overlay, () => {
    onClose();
    return true;
  });

  useEffect(() => {
    nameRef.current?.focus();
    let cancelled = false;
    listProjectEngineDetails()
      .then((listing) => {
        if (!cancelled) setEngines(listing);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setEnginesError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, submitting]);

  const engine = useMemo(
    () => engines?.find((entry) => entry.id === engineId) ?? null,
    [engineId, engines]
  );
  const engineOptions = useMemo(
    () =>
      engines?.map(({ id, label, online }) => ({ id, label, online })) ?? [
        { id: PROJECT_HOME_ENGINE_ID, label: "This engine", online: true },
      ],
    [engines]
  );
  const availableWorkspaces = useMemo(
    () =>
      (engine?.workspaces ?? []).filter(
        (workspace) => !repos.some((repo) => repo.engineId === engineId && repo.workspaceId === workspace.id)
      ),
    [engine, engineId, repos]
  );
  const homeModel = useMemo(
    () =>
      engines
        ?.find((entry) => entry.id === PROJECT_HOME_ENGINE_ID)
        ?.harnesses.find((harness) => harness.id === "cesium-agent")?.defaultModelId ?? "",
    [engines]
  );

  const addRepo = useCallback(() => {
    if (!engine) {
      return;
    }
    const path = typedPath.trim();
    if (path) {
      setRepos((current) => [
        ...current,
        {
          key: `${engine.id}:path:${path}`,
          engineId: engine.id,
          root: path,
          label: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
          engineLabel: engine.label,
        },
      ]);
      setTypedPath("");
      return;
    }
    const workspace = engine.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) {
      return;
    }
    setRepos((current) => [
      ...current,
      {
        key: `${engine.id}:${workspace.id}`,
        engineId: engine.id,
        workspaceId: workspace.id,
        label: workspace.name,
        engineLabel: engine.label,
      },
    ]);
    setWorkspaceId("");
  }, [engine, typedPath, workspaceId]);

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!name.trim()) {
        setError("Give the Project a name.");
        nameRef.current?.focus();
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const snapshot = await createProject({
          name: name.trim(),
          repos: repos.map(({ engineId: repoEngine, workspaceId: repoWorkspace, root }) => ({
            engineId: repoEngine,
            workspaceId: repoWorkspace ?? null,
            root: root ?? null,
          })),
          prompt: prompt.trim() || null,
          modelId: modelId.trim() || null,
        });
        await refresh();
        onClose();
        await openProject({
          id: snapshot.id,
          name: snapshot.name,
          orchestratorConversationId: snapshot.orchestrator.conversationId,
          orchestratorWorkspaceId: snapshot.orchestrator.workspaceId,
          orchestratorStatus: snapshot.orchestrator.status,
          createdAt: snapshot.createdAt,
          updatedAt: snapshot.updatedAt,
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        setSubmitting(false);
      }
    },
    [modelId, name, onClose, openProject, prompt, refresh, repos]
  );

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className={`${dialogLayerClass} flex items-end justify-center p-[10px] sm:items-center sm:p-[16px]`}
      role="presentation"
      data-ide-palette
    >
      <div
        className={dialogBackdropClass}
        aria-hidden
        onPointerDown={(event) => {
          event.preventDefault();
          if (!submitting) onClose();
        }}
      />
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(event) => void submit(event)}
        noValidate
        className={`${dialogPanelClass} flex max-h-[min(720px,calc(100dvh-20px))] w-full max-w-[520px] flex-col`}
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-[16px] pb-[14px] pt-[16px]">
          <div className="flex items-start gap-[10px]">
            <div className="mt-[1px] flex size-[28px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] border border-[var(--border-card)] text-[var(--accent)]">
              <Network className="size-[15px]" strokeWidth={1.8} aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className={dialogTitleClass}>
                New Project
              </h2>
              <p className={dialogMessageClass}>
                One orchestrator chat plans the work and runs agents for you, across these
                repositories and any engine you pair.
              </p>
            </div>
          </div>

          <label className={fieldLabelClass} htmlFor={`${titleId}-name`}>
            Name
          </label>
          <input
            ref={nameRef}
            id={`${titleId}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Checkout redesign"
            autoComplete="off"
            className={`${dialogInputClass} mt-[6px]`}
          />

          <span className={fieldLabelClass}>Repositories</span>
          {repos.length > 0 ? (
            <ul className="mt-[6px] flex flex-col gap-[4px]">
              {repos.map((repo) => (
                <li
                  key={repo.key}
                  className="flex min-w-0 items-center gap-[8px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[8px] py-[5px]"
                >
                  <FolderGit2 className="size-[13px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.6} aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-[var(--text-primary)]">
                    {repo.label}
                  </span>
                  <span className="shrink-0 rounded-[4px] bg-[var(--accent-bg)] px-[6px] py-[1px] font-sans text-[10.5px] text-[var(--text-secondary)]">
                    {repo.engineLabel}
                  </span>
                  <button
                    type="button"
                    onClick={() => setRepos((current) => current.filter((entry) => entry.key !== repo.key))}
                    className="flex size-[18px] shrink-0 items-center justify-center rounded-[4px] text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
                    aria-label={`Remove ${repo.label}`}
                  >
                    <X className="size-[12px]" strokeWidth={1.8} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-[4px] font-sans text-[11.5px] text-[var(--text-disabled)]">
              Optional. Agents can only work in repositories bound here; you can add more later.
            </p>
          )}
          <div className="mt-[6px] grid grid-cols-1 gap-[6px] sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)_auto]">
            <select
              aria-label="Engine"
              value={engineId}
              onChange={(event) => {
                setEngineId(event.target.value);
                setWorkspaceId("");
              }}
              className={selectClass}
              disabled={!engines}
            >
              {engineOptions.map((entry) => (
                <option key={entry.id} value={entry.id} disabled={!entry.online}>
                  {entry.label}
                  {entry.online ? "" : " (offline)"}
                </option>
              ))}
            </select>
            <select
              aria-label="Workspace"
              value={workspaceId}
              onChange={(event) => {
                setWorkspaceId(event.target.value);
                setTypedPath("");
              }}
              className={selectClass}
              disabled={!engine || availableWorkspaces.length === 0}
            >
              <option value="">
                {engines == null
                  ? "Loading workspaces…"
                  : availableWorkspaces.length === 0
                    ? "No other workspaces"
                    : "Choose a workspace"}
              </option>
              {availableWorkspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id} title={workspace.root}>
                  {workspace.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={addRepo}
              disabled={!engine || (!workspaceId && !typedPath.trim())}
              className={dialogSecondaryButtonClass}
            >
              <Plus className="size-[13px]" strokeWidth={1.8} aria-hidden />
              Add
            </button>
          </div>
          <input
            aria-label="Repository path"
            value={typedPath}
            onChange={(event) => {
              setTypedPath(event.target.value);
              if (event.target.value) setWorkspaceId("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addRepo();
              }
            }}
            placeholder={`Or an absolute path on ${engine?.label ?? "this engine"}`}
            autoComplete="off"
            spellCheck={false}
            className={`${dialogInputClass} mt-[6px] font-mono text-[12px]`}
          />
          {enginesError ? <p className={dialogInputErrorClass}>{enginesError}</p> : null}

          <label className={fieldLabelClass} htmlFor={`${titleId}-prompt`}>
            First message to the orchestrator
          </label>
          <textarea
            id={`${titleId}-prompt`}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={4}
            placeholder="What should this Project get done? The orchestrator starts planning right away."
            className={`${dialogInputClass} mt-[6px] resize-y leading-[1.45]`}
          />

          <label className={fieldLabelClass} htmlFor={`${titleId}-model`}>
            Orchestrator model
          </label>
          <input
            id={`${titleId}-model`}
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            placeholder={homeModel ? `Default: ${homeModel}` : "Cesium Agent default"}
            autoComplete="off"
            spellCheck={false}
            className={`${dialogInputClass} mt-[6px] font-mono text-[12px]`}
          />
          {error ? (
            <p role="alert" className={dialogInputErrorClass}>
              {error}
            </p>
          ) : null}
        </div>
        <div className={dialogFooterClass}>
          <button type="button" onClick={onClose} disabled={submitting} className={dialogSecondaryButtonClass}>
            Cancel
          </button>
          <button type="submit" disabled={submitting} className={dialogPrimaryButtonClass}>
            {submitting ? <LoaderCircle className="size-[13px] animate-spin" aria-hidden /> : null}
            Create Project
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
