"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, FolderGit2, KeyRound, Link2, LoaderCircle, Plus, Trash2, X } from "lucide-react";
import {
  PROJECT_HOME_ENGINE_ID,
  sameProjectEngineUrl,
  type ProjectEngineListing,
  type ProjectPeerTokenSummary,
  type ProjectSnapshot,
} from "@cesium/core";
import { useWorkbenchDialogs } from "@/components/dialogs/WorkbenchDialogProvider";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { formatAgentRailRelativeTime } from "@/lib/agent-rail-status";
import {
  addProjectRepo,
  listProjectEngineListings,
  listProjectPeerTokens,
  mintProjectPeerToken,
  pairProjectEngine,
  patchProject,
  removeProjectEngine,
  removeProjectRepo,
  revokeProjectPeerToken,
  toServerRequestContext,
} from "@/lib/server-api";
import {
  projectButtonClass,
  projectDangerButtonClass,
  projectErrorMessage,
  projectErrorTextClass,
  projectHintTextClass,
  projectIconButtonClass,
  projectInputClass,
  projectPrimaryButtonClass,
  projectSectionLabelClass,
  projectSelectClass,
} from "./project-ui";
import { useProjects } from "./ProjectsProvider";

const rowClass =
  "flex min-w-0 items-center gap-[8px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[8px] py-[6px]";

function useEngineListings(projectId: string, revision: number) {
  const [engines, setEngines] = useState<ProjectEngineListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    listProjectEngineListings(projectId)
      .then((listing) => {
        if (!cancelled) {
          setEngines(listing);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(projectErrorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, revision]);
  return { engines, error };
}

export function ProjectSetupSection({ snapshot }: { snapshot: ProjectSnapshot }) {
  const [revision, setRevision] = useState(0);
  const bump = useCallback(() => setRevision((current) => current + 1), []);
  const { engines, error } = useEngineListings(snapshot.id, revision);
  return (
    <div className="flex flex-col gap-[20px] px-[16px] py-[12px]">
      <RepositoriesBlock snapshot={snapshot} engines={engines} onChanged={bump} />
      <DefaultsBlock snapshot={snapshot} engines={engines} />
      <EnginesBlock snapshot={snapshot} onChanged={bump} />
      <PeerTokensBlock />
      {error ? <p className={projectErrorTextClass}>{error}</p> : null}
    </div>
  );
}

function RepositoriesBlock({
  snapshot,
  engines,
  onChanged,
}: {
  snapshot: ProjectSnapshot;
  engines: ProjectEngineListing[] | null;
  onChanged: () => void;
}) {
  const dialogs = useWorkbenchDialogs();
  const { refreshProject } = useProjects();
  const [engineId, setEngineId] = useState(PROJECT_HOME_ENGINE_ID);
  const [workspaceId, setWorkspaceId] = useState("");
  const [path, setPath] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const engine = engines?.find((entry) => entry.id === engineId) ?? null;
  const unbound = (engine?.workspaces ?? []).filter(
    (workspace) =>
      !snapshot.repos.some((repo) => repo.engineId === engineId && repo.workspaceId === workspace.id)
  );
  const engineLabel = (id: string) =>
    snapshot.engines.find((entry) => entry.id === id)?.label ?? id;

  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await action();
      await refreshProject(snapshot.id);
      onChanged();
    } catch (caught) {
      setError(projectErrorMessage(caught));
    } finally {
      setPending(false);
    }
  };

  const add = () =>
    run(async () => {
      const root = path.trim();
      await addProjectRepo(
        snapshot.id,
        root ? { engineId, root } : { engineId, workspaceId }
      );
      setPath("");
      setWorkspaceId("");
    });

  const remove = async (repoId: string, name: string) => {
    const confirmed = await dialogs.confirm({
      title: `Remove ${name} from this Project?`,
      message: "New agents can no longer be placed there. Agents already working in it keep running.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (confirmed) {
      await run(() => removeProjectRepo(snapshot.id, repoId));
    }
  };

  return (
    <section className="flex flex-col gap-[6px]">
      <span className={projectSectionLabelClass}>Repositories</span>
      {snapshot.repos.length === 0 ? (
        <p className={projectHintTextClass}>
          None yet. Agents without a repository work in a scratch folder on their engine.
        </p>
      ) : (
        <ul className="flex flex-col gap-[4px]">
          {snapshot.repos.map((repo) => (
            <li key={repo.id} className={rowClass}>
              <FolderGit2 className="size-[13px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.6} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate font-sans text-[12.5px] text-[var(--text-primary)]">{repo.name}</p>
                <p className="truncate font-mono text-[10.5px] text-[var(--text-disabled)]" title={repo.root}>
                  {repo.root}
                </p>
              </div>
              <span className="shrink-0 rounded-[4px] bg-[var(--bg-card)] px-[6px] py-[1px] font-sans text-[10.5px] text-[var(--text-secondary)]">
                {engineLabel(repo.engineId)}
              </span>
              <button
                type="button"
                onClick={() => void remove(repo.id, repo.name)}
                disabled={pending}
                className={projectIconButtonClass}
                aria-label={`Remove ${repo.name}`}
                title="Remove"
              >
                <X className="size-[13px]" strokeWidth={1.8} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-1 gap-[6px] sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)_auto]">
        <select
          aria-label="Engine"
          value={engineId}
          onChange={(event) => {
            setEngineId(event.target.value);
            setWorkspaceId("");
          }}
          disabled={!engines}
          className={projectSelectClass}
        >
          {(engines ?? []).map((entry) => (
            <option key={entry.id} value={entry.id} disabled={!entry.online}>
              {entry.label}
              {entry.online ? "" : " (offline)"}
            </option>
          ))}
          {engines == null ? <option value={PROJECT_HOME_ENGINE_ID}>Loading engines…</option> : null}
        </select>
        <select
          aria-label="Workspace"
          value={workspaceId}
          onChange={(event) => {
            setWorkspaceId(event.target.value);
            setPath("");
          }}
          disabled={!engine || unbound.length === 0}
          className={projectSelectClass}
        >
          <option value="">{unbound.length === 0 ? "No other workspaces" : "Choose a workspace"}</option>
          {unbound.map((workspace) => (
            <option key={workspace.id} value={workspace.id} title={workspace.root}>
              {workspace.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void add()}
          disabled={pending || !engine || (!workspaceId && !path.trim())}
          className={projectButtonClass}
        >
          {pending ? (
            <LoaderCircle className="size-[12px] animate-spin" aria-hidden />
          ) : (
            <Plus className="size-[12px]" strokeWidth={1.8} aria-hidden />
          )}
          Add
        </button>
      </div>
      <input
        aria-label="Repository path"
        value={path}
        onChange={(event) => {
          setPath(event.target.value);
          if (event.target.value) setWorkspaceId("");
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && path.trim()) {
            event.preventDefault();
            void add();
          }
        }}
        placeholder={`Or an absolute path on ${engine?.label ?? "this engine"}`}
        autoComplete="off"
        spellCheck={false}
        className={`${projectInputClass} font-mono text-[12px]`}
      />
      {error ? <p className={projectErrorTextClass}>{error}</p> : null}
    </section>
  );
}

function DefaultsBlock({
  snapshot,
  engines,
}: {
  snapshot: ProjectSnapshot;
  engines: ProjectEngineListing[] | null;
}) {
  const { refreshProject } = useProjects();
  const saved = snapshot.settings;
  const [harness, setHarness] = useState(saved.defaultChildBackendId ?? "");
  const [model, setModel] = useState(saved.defaultChildModelId ?? "");
  const [maxActive, setMaxActive] = useState(String(saved.maxActiveChildren));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  useEffect(() => {
    setHarness(saved.defaultChildBackendId ?? "");
    setModel(saved.defaultChildModelId ?? "");
    setMaxActive(String(saved.maxActiveChildren));
  }, [saved.defaultChildBackendId, saved.defaultChildModelId, saved.maxActiveChildren]);

  const homeHarnesses = useMemo(
    () => engines?.find((entry) => entry.id === PROJECT_HOME_ENGINE_ID)?.harnesses ?? [],
    [engines]
  );
  const parsedMax = Number.parseInt(maxActive, 10);
  const dirty =
    harness !== (saved.defaultChildBackendId ?? "") ||
    model.trim() !== (saved.defaultChildModelId ?? "") ||
    (Number.isFinite(parsedMax) && parsedMax !== saved.maxActiveChildren);

  const save = async () => {
    setPending(true);
    setError(null);
    setSavedNotice(false);
    try {
      await patchProject(snapshot.id, {
        settings: {
          defaultChildBackendId: harness || null,
          defaultChildModelId: model.trim() || null,
          ...(Number.isFinite(parsedMax) ? { maxActiveChildren: parsedMax } : {}),
        },
      });
      await refreshProject(snapshot.id);
      setSavedNotice(true);
    } catch (caught) {
      setError(projectErrorMessage(caught));
    } finally {
      setPending(false);
    }
  };

  const fieldLabel = "font-sans text-[11.5px] font-medium text-[var(--text-secondary)]";

  return (
    <section className="flex flex-col gap-[6px]">
      <span className={projectSectionLabelClass}>Defaults for new agents</span>
      <div className="grid grid-cols-1 gap-[8px] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_110px]">
        <label className="flex flex-col gap-[4px]">
          <span className={fieldLabel}>Harness</span>
          <select
            value={harness}
            onChange={(event) => setHarness(event.target.value)}
            className={projectSelectClass}
          >
            <option value="">Automatic</option>
            {harness && !homeHarnesses.some((entry) => entry.id === harness) ? (
              <option value={harness}>{harness}</option>
            ) : null}
            {homeHarnesses.map((entry) => (
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
            placeholder="Harness default"
            autoComplete="off"
            spellCheck={false}
            className={`${projectInputClass} font-mono text-[12px]`}
          />
        </label>
        <label className="flex flex-col gap-[4px]">
          <span className={fieldLabel}>Max working</span>
          <input
            type="number"
            min={1}
            max={32}
            value={maxActive}
            onChange={(event) => setMaxActive(event.target.value)}
            className={`${projectInputClass} tabular-nums`}
          />
        </label>
      </div>
      <div className="flex items-center gap-[8px]">
        <p className={`${projectHintTextClass} flex-1`}>
          The orchestrator uses these unless it picks a harness or model itself. The model applies to
          agents on this engine.
        </p>
        {savedNotice && !dirty ? (
          <span className="inline-flex items-center gap-[4px] font-sans text-[11.5px] text-[var(--status-success)]">
            <Check className="size-[12px]" strokeWidth={2} aria-hidden />
            Saved
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || pending}
          className={projectPrimaryButtonClass}
        >
          {pending ? <LoaderCircle className="size-[12px] animate-spin" aria-hidden /> : null}
          Save
        </button>
      </div>
      {error ? <p className={projectErrorTextClass}>{error}</p> : null}
    </section>
  );
}

function EnginesBlock({ snapshot, onChanged }: { snapshot: ProjectSnapshot; onChanged: () => void }) {
  const dialogs = useWorkbenchDialogs();
  const { refreshProject } = useProjects();
  const { servers, activeServer } = useServerConnections();
  const [serverId, setServerId] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [manualUrl, setManualUrl] = useState("");
  const [manualToken, setManualToken] = useState("");
  const [manualLabel, setManualLabel] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pairable = servers.filter(
    (server) =>
      server.id !== activeServer.id &&
      !sameProjectEngineUrl(server.baseUrl, activeServer.baseUrl) &&
      !snapshot.engines.some((engine) => sameProjectEngineUrl(engine.baseUrl, server.baseUrl))
  );

  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await action();
      await refreshProject(snapshot.id);
      onChanged();
    } catch (caught) {
      setError(projectErrorMessage(caught));
    } finally {
      setPending(false);
    }
  };

  const pairSaved = () =>
    run(async () => {
      const server = pairable.find((entry) => entry.id === serverId);
      if (!server) {
        return;
      }
      const minted = await mintProjectPeerToken(`Projects on ${activeServer.label}`, {
        server: toServerRequestContext(server),
      });
      await pairProjectEngine({ baseUrl: server.baseUrl, token: minted.secret, label: server.label });
      setServerId("");
    });

  const pairManual = () =>
    run(async () => {
      await pairProjectEngine({
        baseUrl: manualUrl.trim(),
        token: manualToken.trim(),
        label: manualLabel.trim() || null,
      });
      setManualUrl("");
      setManualToken("");
      setManualLabel("");
      setManualOpen(false);
    });

  const remove = async (engineId: string, label: string) => {
    const confirmed = await dialogs.confirm({
      title: `Unpair ${label}?`,
      message:
        "Every Project on this engine stops using it. Remove its repositories and agents from all Projects first.",
      confirmLabel: "Unpair",
      tone: "danger",
    });
    if (confirmed) {
      await run(() => removeProjectEngine(engineId));
    }
  };

  return (
    <section className="flex flex-col gap-[6px]">
      <span className={projectSectionLabelClass}>Engines</span>
      <ul className="flex flex-col gap-[4px]">
        {snapshot.engines.map((engine) => (
          <li key={engine.id} className={rowClass}>
            <span
              className={`size-[7px] shrink-0 rounded-full ${
                engine.online ? "bg-[var(--status-success)]" : "bg-[var(--status-error)]"
              }`}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="truncate font-sans text-[12.5px] text-[var(--text-primary)]">
                {engine.label}
                <span className="ml-[6px] text-[11px] text-[var(--text-disabled)]">
                  {engine.kind === "home" ? "this engine" : engine.online ? "online" : "offline"}
                </span>
              </p>
              {engine.baseUrl || engine.error ? (
                <p
                  className={`truncate font-mono text-[10.5px] ${
                    engine.error ? "text-[var(--status-error)]" : "text-[var(--text-disabled)]"
                  }`}
                  title={engine.error ?? engine.baseUrl ?? undefined}
                >
                  {engine.error ?? engine.baseUrl}
                </p>
              ) : null}
            </div>
            {engine.lastSeenAt && engine.kind === "peer" ? (
              <span className="shrink-0 font-sans text-[10.5px] text-[var(--text-disabled)]">
                seen {formatAgentRailRelativeTime(engine.lastSeenAt)}
              </span>
            ) : null}
            {engine.kind === "peer" ? (
              <button
                type="button"
                onClick={() => void remove(engine.id, engine.label)}
                disabled={pending}
                className={projectIconButtonClass}
                aria-label={`Unpair ${engine.label}`}
                title="Unpair"
              >
                <Trash2 className="size-[12px]" strokeWidth={1.7} />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <p className={projectHintTextClass}>
        Pair another engine to run agents on it. It needs Projects turned on under Settings, Beta.
      </p>
      <div className="flex flex-wrap items-center gap-[6px]">
        <select
          aria-label="Saved engine"
          value={serverId}
          onChange={(event) => setServerId(event.target.value)}
          disabled={pairable.length === 0}
          className={`${projectSelectClass} w-auto min-w-[180px] flex-1`}
        >
          <option value="">
            {pairable.length === 0 ? "No other saved engines" : "Choose a saved engine"}
          </option>
          {pairable.map((server) => (
            <option key={server.id} value={server.id}>
              {server.label} · {server.baseUrl}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void pairSaved()}
          disabled={!serverId || pending}
          className={projectPrimaryButtonClass}
        >
          {pending ? (
            <LoaderCircle className="size-[12px] animate-spin" aria-hidden />
          ) : (
            <Link2 className="size-[12px]" strokeWidth={1.8} aria-hidden />
          )}
          Pair
        </button>
        <button
          type="button"
          onClick={() => setManualOpen((current) => !current)}
          className={projectButtonClass}
          aria-expanded={manualOpen}
        >
          Pair by URL
        </button>
      </div>
      {manualOpen ? (
        <div className="flex flex-col gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] p-[8px]">
          <input
            aria-label="Engine URL"
            value={manualUrl}
            onChange={(event) => setManualUrl(event.target.value)}
            placeholder="https://build-box.example:9100"
            autoComplete="off"
            spellCheck={false}
            className={`${projectInputClass} font-mono text-[12px]`}
          />
          <input
            aria-label="Peer token"
            value={manualToken}
            onChange={(event) => setManualToken(event.target.value)}
            placeholder="cpk_… (minted on that engine)"
            autoComplete="off"
            spellCheck={false}
            className={`${projectInputClass} font-mono text-[12px]`}
          />
          <div className="flex gap-[6px]">
            <input
              aria-label="Label"
              value={manualLabel}
              onChange={(event) => setManualLabel(event.target.value)}
              placeholder="Label (optional)"
              autoComplete="off"
              className={`${projectInputClass} flex-1`}
            />
            <button
              type="button"
              onClick={() => void pairManual()}
              disabled={!manualUrl.trim() || !manualToken.trim() || pending}
              className={projectPrimaryButtonClass}
            >
              Pair
            </button>
          </div>
        </div>
      ) : null}
      {error ? <p className={projectErrorTextClass}>{error}</p> : null}
    </section>
  );
}

function PeerTokensBlock() {
  const dialogs = useWorkbenchDialogs();
  const { activeServer } = useServerConnections();
  const { copy, feedback } = useCopyToClipboard();
  const [tokens, setTokens] = useState<ProjectPeerTokenSummary[] | null>(null);
  const [minted, setMinted] = useState<{ label: string; secret: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTokens(await listProjectPeerTokens());
    } catch (caught) {
      setError(projectErrorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mint = async () => {
    const label = await dialogs.prompt({
      title: "New peer token",
      message: "Another engine pairs with this one using the token, then runs Project agents here.",
      placeholder: "Laptop",
      confirmLabel: "Create token",
    });
    if (!label) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await mintProjectPeerToken(label);
      setMinted({ label: result.token.label, secret: result.secret });
      await load();
    } catch (caught) {
      setError(projectErrorMessage(caught));
    } finally {
      setPending(false);
    }
  };

  const revoke = async (token: ProjectPeerTokenSummary) => {
    const confirmed = await dialogs.confirm({
      title: `Revoke ${token.label}?`,
      message: "The engine using it can no longer start or drive agents here.",
      confirmLabel: "Revoke",
      tone: "danger",
    });
    if (!confirmed) {
      return;
    }
    try {
      await revokeProjectPeerToken(token.id);
      await load();
    } catch (caught) {
      setError(projectErrorMessage(caught));
    }
  };

  return (
    <section className="flex flex-col gap-[6px]">
      <div className="flex items-center gap-[8px]">
        <span className={`${projectSectionLabelClass} flex-1`}>Engines that can run agents here</span>
        <button type="button" onClick={() => void mint()} disabled={pending} className={projectButtonClass}>
          <KeyRound className="size-[12px]" strokeWidth={1.7} aria-hidden />
          New token
        </button>
      </div>
      {minted ? (
        <div className="flex flex-col gap-[6px] rounded-[var(--radius-tab)] border border-[color-mix(in_srgb,var(--accent)_45%,var(--border-card))] bg-[var(--accent-bg)] p-[8px]">
          <p className="font-sans text-[12px] text-[var(--text-primary)]">
            Token for {minted.label}. Copy it now; it is not shown again. Pair with this engine at{" "}
            <span className="font-mono">{activeServer.baseUrl}</span>.
          </p>
          <div className="flex items-center gap-[6px]">
            <code className="min-w-0 flex-1 truncate rounded-[4px] bg-[var(--bg-card)] px-[6px] py-[3px] font-mono text-[11.5px] text-[var(--text-primary)]">
              {minted.secret}
            </code>
            <button type="button" onClick={() => void copy(minted.secret)} className={projectButtonClass}>
              {feedback === "copied" ? (
                <Check className="size-[12px]" strokeWidth={2} aria-hidden />
              ) : (
                <Copy className="size-[12px]" strokeWidth={1.7} aria-hidden />
              )}
              {feedback === "copied" ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              onClick={() => setMinted(null)}
              className={projectIconButtonClass}
              aria-label="Hide token"
            >
              <X className="size-[13px]" strokeWidth={1.8} />
            </button>
          </div>
        </div>
      ) : null}
      {tokens == null ? (
        <p className={projectHintTextClass}>Loading tokens…</p>
      ) : tokens.length === 0 ? (
        <p className={projectHintTextClass}>No engine can run agents here yet.</p>
      ) : (
        <ul className="flex flex-col gap-[4px]">
          {tokens.map((token) => (
            <li key={token.id} className={rowClass}>
              <KeyRound className="size-[12px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.6} aria-hidden />
              <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-[var(--text-primary)]">
                {token.label}
              </span>
              <span className="shrink-0 font-sans text-[10.5px] text-[var(--text-disabled)]">
                {token.lastUsedAt
                  ? `used ${formatAgentRailRelativeTime(token.lastUsedAt)}`
                  : `created ${formatAgentRailRelativeTime(token.createdAt)}`}
              </span>
              <button
                type="button"
                onClick={() => void revoke(token)}
                className={projectDangerButtonClass}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {error ? <p className={projectErrorTextClass}>{error}</p> : null}
    </section>
  );
}
