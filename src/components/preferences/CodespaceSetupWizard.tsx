"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  explainGithubLinkMismatch,
  useClerkGithubLink,
} from "@/hooks/useClerkGithubLink";
import {
  Check,
  ExternalLink,
  Github,
  Loader2,
  Lock,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { setStoredSessionToken } from "@cesium/client";
import { useCloudContext, type CloudGithubCodespace } from "@/contexts/CloudContext";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { loginToEngine } from "@/lib/onboarding/engine-api";
import {
  buildCodespaceMeta,
  categorizeCodespaceState,
  generateEngineCredentials,
  pickExistingEngineAuth,
  type CodespaceDevice,
  type GithubMachineInfo,
  type GithubRepoInfo,
} from "@/lib/github-codespaces";
import { probeEngineHealthy } from "@/hooks/useGithubCodespaces";
import { formatGithubConnectError } from "@/lib/github-clerk-errors";

/**
 * GitHub Codespace setup wizard.
 *
 * Walks connect GitHub -> pick repo -> machine/options -> provision:
 * commit (or PR) the Cesium devcontainer, push engine credentials as
 * repo-scoped Codespaces secrets, create the codespace, wait for the engine
 * to come up on the public forwarded port, sign in, and register the device
 * both locally and on the account (durable one-codespace-per-repo pairing).
 *
 * Also serves the recreate flow: pass `recreateDevice` and the repo/config
 * steps are prefilled from the stored pairing.
 */

type WizardStep = "github" | "repo" | "config" | "provision" | "done";

type ProvisionPhase =
  | "devcontainer"
  | "pr-wait"
  | "secrets"
  | "create"
  | "waiting-codespace"
  | "waiting-engine"
  | "signing-in"
  | "saving";

const PROVISION_LABELS: Record<ProvisionPhase, string> = {
  devcontainer: "Writing the Cesium devcontainer to the repository…",
  "pr-wait": "Waiting for the setup pull request to be merged…",
  secrets: "Storing engine credentials as Codespaces secrets…",
  create: "Creating the codespace…",
  "waiting-codespace": "Waiting for the codespace to start…",
  "waiting-engine": "Waiting for the Cesium engine to come online (first boot installs the engine - this can take several minutes)…",
  "signing-in": "Signing in to the engine…",
  saving: "Registering the device on your account…",
};

const IDLE_TIMEOUT_OPTIONS = [30, 60, 120, 240] as const;

/**
 * Upper bound for a single status poll. Convex action calls have no client
 * timeout; a call that never settles (socket blip mid-request, throttled
 * background tab) would otherwise freeze the wizard on the spinner forever
 * without ever reaching the phase deadline.
 */
const POLL_CALL_TIMEOUT_MS = 45_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

const inputClass =
  "w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[6px] font-sans text-[12px] text-[var(--text-primary)] outline-none";
const primaryButtonClass =
  "inline-flex items-center justify-center gap-[6px] rounded-[var(--radius-tab)] bg-[var(--accent)] px-[12px] py-[6px] font-sans text-[12px] text-[var(--bg-panel)] disabled:opacity-50";
const secondaryButtonClass =
  "inline-flex items-center justify-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] px-[12px] py-[6px] font-sans text-[12px] text-[var(--text-primary)] hover:bg-[var(--accent-bg)] disabled:opacity-50";

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function formatMachine(machine: GithubMachineInfo): string {
  const memoryGb = Math.round(machine.memoryInBytes / 1024 ** 3);
  const storageGb = Math.round(machine.storageInBytes / 1024 ** 3);
  return `${machine.displayName} - ${machine.cpus} cores, ${memoryGb} GB RAM, ${storageGb} GB storage`;
}

export type CodespaceSetupWizardProps = {
  open: boolean;
  onClose: () => void;
  /** Receives the local server id once the codespace engine is connected. */
  onConnected: (localServerId: string) => void;
  /** Existing paired devices (used to reuse account-wide engine credentials). */
  devices: CodespaceDevice[];
  /** Prefills repo + machine for the deleted-codespace recreate flow. */
  recreateDevice?: CodespaceDevice | null;
};

export function CodespaceSetupWizard(props: CodespaceSetupWizardProps) {
  const cloud = useCloudContext();
  if (!props.open) {
    return null;
  }
  if (!cloud.github) {
    return (
      <WizardShell onClose={props.onClose} title="GitHub Codespaces">
        <p className="font-sans text-[12.5px] leading-snug text-[var(--text-secondary)]">
          {cloud.mode === "clerk"
            ? "Sign in to your Cesium account first - the GitHub connection is managed through it so any signed-in device can use your codespaces."
            : "GitHub Codespaces need a Cesium cloud identity (a signed-in account, or a device-sync deployment). Enable cloud sync first."}
        </p>
      </WizardShell>
    );
  }
  return <CodespaceSetupWizardInner {...props} />;
}

/**
 * Clerk-only connect CTA. Mounted only in Clerk cloud mode (useUser needs a
 * ClerkProvider); device-key deployments configure CESIUM_GITHUB_TOKEN
 * instead and never render this.
 */
function ClerkGithubConnectCta({
  onError,
}: {
  onError: (message: string) => void;
}) {
  const { user, linkState, connectGithub, formatError } = useClerkGithubLink();
  const [linkPending, setLinkPending] = useState(false);
  const mismatch = explainGithubLinkMismatch(linkState);

  const startConnect = useCallback(async () => {
    setLinkPending(true);
    try {
      await connectGithub();
    } catch (err) {
      setLinkPending(false);
      onError(formatError(err));
    }
  }, [connectGithub, formatError, onError]);

  return (
    <>
      {mismatch ? (
        <p className="font-sans text-[11.5px] leading-snug text-[var(--text-secondary)]">
          {mismatch}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => void startConnect()}
        disabled={linkPending || !user}
        className={primaryButtonClass}
      >
        {linkPending ? (
          <Loader2 className="size-[13px] animate-spin" strokeWidth={2} aria-hidden />
        ) : (
          <Github className="size-[13px]" strokeWidth={1.7} aria-hidden />
        )}
        {linkState.kind === "linked" ? "Re-authorize GitHub" : "Connect GitHub"}
      </button>
      <p className="font-sans text-[11px] leading-snug text-[var(--text-disabled)]">
        You will be sent to GitHub to authorize Cesium (repo and codespace
        access), then return here - reopen this wizard to continue. GitHub
        must be enabled as an SSO connection in Clerk with a GitHub OAuth
        App that includes the repo and codespace scopes.
      </p>
    </>
  );
}

function WizardShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-[10200] flex items-center justify-center bg-black/45 p-[12px]"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-ide-input-sink
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex max-h-[88dvh] w-[min(600px,100%)] flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--border-card)] px-[16px] py-[10px]">
          <span className="inline-flex items-center gap-[8px] font-sans text-[13.5px] font-semibold text-[var(--text-primary)]">
            <Github className="size-[15px]" strokeWidth={1.7} aria-hidden />
            {title}
          </span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-[26px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
          >
            <X className="size-[14px]" strokeWidth={1.7} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[16px] py-[14px]">
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}

function CodespaceSetupWizardInner({
  onClose,
  onConnected,
  devices,
  recreateDevice = null,
}: CodespaceSetupWizardProps) {
  const cloud = useCloudContext();
  const github = cloud.github;
  const { saveServer, removeServer } = useServerConnections();

  const [step, setStep] = useState<WizardStep>("github");
  const [connection, setConnection] = useState<{
    connected: boolean;
    login: string | null;
    error: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [repos, setRepos] = useState<GithubRepoInfo[] | null>(null);
  const [repoFilter, setRepoFilter] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<GithubRepoInfo | null>(null);

  const [machines, setMachines] = useState<GithubMachineInfo[] | null>(null);
  const [selectedMachine, setSelectedMachine] = useState<string | null>(null);
  const [idleTimeout, setIdleTimeout] = useState<number>(30);
  const [commitMode, setCommitMode] = useState<"commit" | "pr">("commit");
  const [extraSecrets, setExtraSecrets] = useState<
    Array<{ name: string; value: string }>
  >([]);

  const [provisionPhase, setProvisionPhase] = useState<ProvisionPhase>("devcontainer");
  // Live detail for the long polling phases: GitHub's raw codespace state,
  // the codespace name, and how long we have been waiting.
  const [provisionDetail, setProvisionDetail] = useState<{
    codespaceName: string;
    githubState: string | null;
    webUrl: string | null;
    startedAt: number;
  } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (step !== "provision" || !provisionDetail) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [provisionDetail, step]);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [checkingPr, setCheckingPr] = useState(false);
  const [connectedServerId, setConnectedServerId] = useState<string | null>(null);

  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // One credential pair per account: Codespaces user secrets are shared
  // across repos, so a second pairing must reuse the first pairing's values.
  const engineAuthRef = useRef(
    recreateDevice?.engineAuth ??
      pickExistingEngineAuth(devices) ??
      generateEngineCredentials()
  );

  const loadMachines = useCallback(
    async (repoFullName: string) => {
      if (!github) return;
      setMachines(null);
      try {
        const rows = await github.listMachines(repoFullName);
        if (cancelledRef.current) return;
        setMachines(rows);
        setSelectedMachine((current) => current ?? rows[0]?.name ?? null);
      } catch (err) {
        if (cancelledRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [github]
  );

  // Boot: resolve the GitHub connection, then jump to the right step.
  useEffect(() => {
    if (!github) return;
    let disposed = false;
    void (async () => {
      try {
        const status = await github.connectionStatus();
        if (disposed || cancelledRef.current) return;
        setConnection(status);
        if (!status.connected) {
          setStep("github");
          return;
        }
        if (recreateDevice) {
          setSelectedRepo({
            id: recreateDevice.repositoryId,
            fullName: recreateDevice.repoFullName,
            private: true,
            defaultBranch: "",
            pushedAt: null,
            description: null,
          });
          setSelectedMachine(recreateDevice.machine);
          setStep("config");
          void loadMachines(recreateDevice.repoFullName);
          return;
        }
        setStep("repo");
        const rows = await github.listRepos();
        if (disposed || cancelledRef.current) return;
        setRepos(rows);
      } catch (err) {
        if (disposed || cancelledRef.current) return;
        setConnection({
          connected: false,
          login: null,
          error: formatGithubConnectError(err),
        });
        setStep("github");
      }
    })();
    return () => {
      disposed = true;
    };
  }, [github, loadMachines, recreateDevice]);

  const finishProvision = useCallback(
    async (codespace: CloudGithubCodespace, engineBaseUrl: string) => {
      if (!github || !selectedRepo) return;
      const auth = engineAuthRef.current;

      setProvisionPhase("waiting-codespace");
      let current = codespace;
      const waitStartedAt = Date.now();
      setProvisionDetail({
        codespaceName: current.name,
        githubState: current.state,
        webUrl: current.webUrl,
        startedAt: waitStartedAt,
      });
      const codespaceDeadline = Date.now() + 10 * 60_000;
      while (categorizeCodespaceState(current.state) !== "running") {
        const category = categorizeCodespaceState(current.state);
        if (category === "gone") {
          throw new Error("The codespace was deleted while provisioning.");
        }
        if (category === "failed") {
          throw new Error(`GitHub reports the codespace as ${current.state}.`);
        }
        if (Date.now() > codespaceDeadline) {
          throw new Error(
            `Timed out waiting for the codespace to start (GitHub still reports "${current.state}" for ${current.name}). Check its creation log at github.com/codespaces.`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        if (cancelledRef.current) return;
        const next = await withTimeout(
          github.getCodespace(current.name),
          POLL_CALL_TIMEOUT_MS,
          `GitHub status check for ${current.name} did not answer within ${POLL_CALL_TIMEOUT_MS / 1000}s. Check your connection and retry from the device list.`
        );
        if (!next) {
          throw new Error("The codespace disappeared while provisioning.");
        }
        current = next;
        setProvisionDetail({
          codespaceName: current.name,
          githubState: current.state,
          webUrl: current.webUrl,
          startedAt: waitStartedAt,
        });
      }

      setProvisionPhase("waiting-engine");
      setProvisionDetail({
        codespaceName: current.name,
        githubState: current.state,
        webUrl: current.webUrl,
        startedAt: Date.now(),
      });
      const engineDeadline = Date.now() + 15 * 60_000;
      while (!(await probeEngineHealthy(engineBaseUrl))) {
        if (cancelledRef.current) return;
        if (Date.now() > engineDeadline) {
          throw new Error(
            "The codespace is running, but the Cesium engine never came online. Check /workspaces/.cesium/logs inside the codespace."
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }

      setProvisionPhase("signing-in");
      const { token } = await loginToEngine(engineBaseUrl, auth.username, auth.password);
      setStoredSessionToken(token, null, engineBaseUrl);

      setProvisionPhase("saving");
      const saved = saveServer({ label: selectedRepo.fullName, baseUrl: engineBaseUrl });
      await cloud.actions?.saveServer({
        name: selectedRepo.fullName,
        baseUrl: engineBaseUrl,
        kind: "codespace",
        sessionToken: token,
        markConnected: true,
        codespace: buildCodespaceMeta({
          repoFullName: selectedRepo.fullName,
          repositoryId: selectedRepo.id,
          codespace: current,
          devcontainerPath: ".devcontainer/cesium/devcontainer.json",
          engineAuth: auth,
        }),
      });

      // Recreate flow: retire the dead codespace and its stale local entry.
      if (recreateDevice && recreateDevice.codespaceName !== current.name) {
        void github.deleteCodespace(recreateDevice.codespaceName).catch(() => undefined);
        if (
          recreateDevice.localServerId &&
          recreateDevice.baseUrl !== engineBaseUrl
        ) {
          removeServer(recreateDevice.localServerId);
        }
      }

      setConnectedServerId(saved.id);
      setStep("done");
      onConnected(saved.id);
    },
    [cloud.actions, github, onConnected, recreateDevice, removeServer, saveServer, selectedRepo]
  );

  const continueAfterDevcontainer = useCallback(async () => {
    if (!github || !selectedRepo) return;
    const auth = engineAuthRef.current;

    setProvisionPhase("secrets");
    const validExtras = extraSecrets
      .map((secret) => ({ name: secret.name.trim().toUpperCase(), value: secret.value }))
      .filter((secret) => secret.name && secret.value);
    await github.setupCodespaceSecrets({
      repositoryId: selectedRepo.id,
      engineUsername: auth.username,
      enginePassword: auth.password,
      ...(validExtras.length > 0 ? { extraSecrets: validExtras } : {}),
    });
    if (cancelledRef.current) return;

    setProvisionPhase("create");
    const created = await github.createCodespace({
      repoFullName: selectedRepo.fullName,
      ...(selectedMachine ? { machine: selectedMachine } : {}),
      idleTimeoutMinutes: idleTimeout,
    });
    if (cancelledRef.current) return;
    await finishProvision(created.codespace, created.engineBaseUrl);
  }, [extraSecrets, finishProvision, github, idleTimeout, selectedMachine, selectedRepo]);

  const startProvision = useCallback(async () => {
    if (!github || !selectedRepo) return;
    setStep("provision");
    setError(null);
    setPrUrl(null);
    try {
      setProvisionPhase("devcontainer");
      const result = await github.ensureDevcontainer({
        repoFullName: selectedRepo.fullName,
        mode: commitMode,
      });
      if (cancelledRef.current) return;
      if (result.status === "pr-open") {
        setPrUrl(result.prUrl);
        setProvisionPhase("pr-wait");
        return;
      }
      await continueAfterDevcontainer();
    } catch (err) {
      if (cancelledRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [commitMode, continueAfterDevcontainer, github, selectedRepo]);

  const recheckPr = useCallback(async () => {
    if (!github || !selectedRepo) return;
    setCheckingPr(true);
    setError(null);
    try {
      const result = await github.ensureDevcontainer({
        repoFullName: selectedRepo.fullName,
        mode: "pr",
      });
      if (cancelledRef.current) return;
      if (result.status === "ready") {
        setPrUrl(null);
        await continueAfterDevcontainer();
        return;
      }
      setPrUrl(result.prUrl);
      setError("The pull request has not been merged yet.");
    } catch (err) {
      if (cancelledRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingPr(false);
    }
  }, [continueAfterDevcontainer, github, selectedRepo]);

  const filteredRepos = useMemo(() => {
    if (!repos) return null;
    const query = repoFilter.trim().toLowerCase();
    if (!query) return repos;
    return repos.filter((repo) => repo.fullName.toLowerCase().includes(query));
  }, [repoFilter, repos]);

  const title = recreateDevice
    ? `Recreate Codespace - ${recreateDevice.repoFullName}`
    : "Set up a GitHub Codespace";

  return (
    <WizardShell title={title} onClose={onClose}>
      <div className="flex flex-col gap-[12px]">
        {step === "github" ? (
          <>
            <p className="font-sans text-[12.5px] leading-snug text-[var(--text-secondary)]">
              Cesium runs its engine inside a GitHub Codespace paired to a
              repository - no server of your own required. Connect your GitHub
              account to this Cesium account to get started.
            </p>
            {connection === null ? (
              <span className="inline-flex items-center gap-[6px] font-sans text-[12px] text-[var(--text-secondary)]">
                <Loader2 className="size-[13px] animate-spin" strokeWidth={2} aria-hidden />
                Checking your GitHub connection…
              </span>
            ) : connection.connected ? (
              <span className="inline-flex items-center gap-[6px] font-sans text-[12px] text-[var(--text-primary)]">
                <Check className="size-[13px]" strokeWidth={2} aria-hidden />
                Connected as {connection.login}
              </span>
            ) : (
              <>
                {connection.error ? (
                  <p className="font-sans text-[11.5px] text-[var(--goal-accent)]">
                    {connection.error}
                  </p>
                ) : null}
                {cloud.mode === "clerk" ? (
                  <ClerkGithubConnectCta onError={setError} />
                ) : (
                  <p className="font-sans text-[11.5px] leading-snug text-[var(--text-secondary)]">
                    This deployment uses device sync: set a{" "}
                    <code className="font-mono text-[10.5px]">CESIUM_GITHUB_TOKEN</code>{" "}
                    env var on the Convex deployment (a GitHub token with{" "}
                    <code className="font-mono text-[10.5px]">repo</code> and{" "}
                    <code className="font-mono text-[10.5px]">codespace</code>{" "}
                    scopes), then reopen this wizard.
                  </p>
                )}
              </>
            )}
          </>
        ) : null}

        {step === "repo" ? (
          <>
            <p className="font-sans text-[12.5px] leading-snug text-[var(--text-secondary)]">
              Pick the repository to pair. Each repository gets one durable
              codespace that keeps its engine, agent installs, and work state.
            </p>
            <input
              type="text"
              value={repoFilter}
              onChange={(event) => setRepoFilter(event.target.value)}
              placeholder="Filter repositories…"
              className={inputClass}
              autoFocus
            />
            {filteredRepos === null ? (
              <span className="inline-flex items-center gap-[6px] font-sans text-[12px] text-[var(--text-secondary)]">
                <Loader2 className="size-[13px] animate-spin" strokeWidth={2} aria-hidden />
                Loading repositories…
              </span>
            ) : (
              <div className="flex max-h-[300px] flex-col gap-[2px] overflow-y-auto overscroll-contain rounded-[var(--radius-tab)] border border-[var(--border-card)] p-[4px]">
                {filteredRepos.length === 0 ? (
                  <p className="px-[8px] py-[6px] font-sans text-[12px] text-[var(--text-disabled)]">
                    No repositories match.
                  </p>
                ) : (
                  filteredRepos.map((repo) => {
                    const paired = devices.some(
                      (device) => device.repoFullName === repo.fullName
                    );
                    return (
                      <button
                        key={repo.id}
                        type="button"
                        onClick={() => {
                          setSelectedRepo(repo);
                          setStep("config");
                          void loadMachines(repo.fullName);
                        }}
                        className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left hover:bg-[var(--accent-bg)]"
                      >
                        {repo.private ? (
                          <Lock
                            className="size-[12px] shrink-0 text-[var(--text-secondary)]"
                            strokeWidth={1.7}
                            aria-hidden
                          />
                        ) : (
                          <Github
                            className="size-[12px] shrink-0 text-[var(--text-secondary)]"
                            strokeWidth={1.7}
                            aria-hidden
                          />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-sans text-[12.5px] text-[var(--text-primary)]">
                            {repo.fullName}
                          </span>
                          {repo.description ? (
                            <span className="block truncate font-sans text-[11px] text-[var(--text-secondary)]">
                              {repo.description}
                            </span>
                          ) : null}
                        </span>
                        {paired ? (
                          <span className="shrink-0 rounded-full bg-[var(--accent-bg)] px-[6px] py-[1px] font-sans text-[10px] text-[var(--text-secondary)]">
                            paired
                          </span>
                        ) : null}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </>
        ) : null}

        {step === "config" && selectedRepo ? (
          <>
            <p className="font-sans text-[12.5px] leading-snug text-[var(--text-primary)]">
              {selectedRepo.fullName}
            </p>
            <label className="flex flex-col gap-[4px] font-sans text-[11.5px] text-[var(--text-secondary)]">
              Machine type
              {machines === null ? (
                <span className="inline-flex items-center gap-[6px] py-[4px] text-[12px]">
                  <Loader2 className="size-[13px] animate-spin" strokeWidth={2} aria-hidden />
                  Loading machine types…
                </span>
              ) : (
                <select
                  value={selectedMachine ?? ""}
                  onChange={(event) => setSelectedMachine(event.target.value || null)}
                  className={inputClass}
                >
                  {machines.map((machine) => (
                    <option key={machine.name} value={machine.name}>
                      {formatMachine(machine)}
                    </option>
                  ))}
                </select>
              )}
            </label>
            <label className="flex flex-col gap-[4px] font-sans text-[11.5px] text-[var(--text-secondary)]">
              Stop after idle
              <select
                value={idleTimeout}
                onChange={(event) => setIdleTimeout(Number(event.target.value))}
                className={inputClass}
              >
                {IDLE_TIMEOUT_OPTIONS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes >= 60 ? `${minutes / 60} hour${minutes > 60 ? "s" : ""}` : `${minutes} minutes`}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="flex flex-col gap-[6px]">
              <legend className="font-sans text-[11.5px] text-[var(--text-secondary)]">
                Cesium needs to add <code className="font-mono text-[10.5px]">.devcontainer/cesium/</code> to the repository
              </legend>
              <label className="flex items-start gap-[8px] font-sans text-[12px] text-[var(--text-primary)]">
                <input
                  type="radio"
                  name="codespace-commit-mode"
                  checked={commitMode === "commit"}
                  onChange={() => setCommitMode("commit")}
                  className="mt-[2px]"
                />
                <span>
                  Commit directly to {selectedRepo.defaultBranch ? `\u201C${selectedRepo.defaultBranch}\u201D` : "the default branch"}
                  <span className="block font-sans text-[10.5px] text-[var(--text-disabled)]">
                    Fastest - one commit with the devcontainer and bootstrap script.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-[8px] font-sans text-[12px] text-[var(--text-primary)]">
                <input
                  type="radio"
                  name="codespace-commit-mode"
                  checked={commitMode === "pr"}
                  onChange={() => setCommitMode("pr")}
                  className="mt-[2px]"
                />
                <span>
                  Open a pull request for review
                  <span className="block font-sans text-[10.5px] text-[var(--text-disabled)]">
                    Setup pauses until the PR is merged.
                  </span>
                </span>
              </label>
            </fieldset>
            <div className="flex flex-col gap-[6px]">
              <p className="font-sans text-[11.5px] text-[var(--text-secondary)]">
                Optional: API keys for agents inside the codespace (stored as
                repo-scoped GitHub Codespaces secrets, e.g.{" "}
                <code className="font-mono text-[10.5px]">OPENAI_API_KEY</code>)
              </p>
              {extraSecrets.map((secret, index) => (
                <div key={index} className="flex items-center gap-[6px]">
                  <input
                    type="text"
                    value={secret.name}
                    onChange={(event) =>
                      setExtraSecrets((current) =>
                        current.map((row, rowIndex) =>
                          rowIndex === index ? { ...row, name: event.target.value } : row
                        )
                      )
                    }
                    placeholder="SECRET_NAME"
                    className={`${inputClass} font-mono uppercase`}
                  />
                  <input
                    type="password"
                    value={secret.value}
                    onChange={(event) =>
                      setExtraSecrets((current) =>
                        current.map((row, rowIndex) =>
                          rowIndex === index ? { ...row, value: event.target.value } : row
                        )
                      )
                    }
                    placeholder="Value"
                    className={inputClass}
                  />
                  <button
                    type="button"
                    aria-label="Remove secret"
                    onClick={() =>
                      setExtraSecrets((current) =>
                        current.filter((_, rowIndex) => rowIndex !== index)
                      )
                    }
                    className="flex size-[26px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] hover:bg-[var(--accent-bg)]"
                  >
                    <Trash2 className="size-[12px]" strokeWidth={1.7} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setExtraSecrets((current) => [...current, { name: "", value: "" }])
                }
                className="inline-flex items-center gap-[6px] self-start font-sans text-[11.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <Plus className="size-[12px]" strokeWidth={1.7} aria-hidden />
                Add a key
              </button>
            </div>
            <p className="font-sans text-[10.5px] leading-snug text-[var(--text-disabled)]">
              Codespaces usage is billed to your GitHub account (personal
              accounts include free monthly core-hours). The engine port is
              published publicly and protected by the engine password Cesium
              generates and stores on your account.
            </p>
            <div className="flex items-center justify-between">
              {recreateDevice ? (
                <span />
              ) : (
                <button
                  type="button"
                  onClick={() => setStep("repo")}
                  className={secondaryButtonClass}
                >
                  Back
                </button>
              )}
              <button
                type="button"
                onClick={() => void startProvision()}
                disabled={!selectedMachine && machines !== null && machines.length > 0}
                className={primaryButtonClass}
              >
                {recreateDevice ? "Recreate codespace" : "Create codespace"}
              </button>
            </div>
          </>
        ) : null}

        {step === "provision" ? (
          <>
            {provisionPhase === "pr-wait" ? (
              <>
                <p className="font-sans text-[12.5px] leading-snug text-[var(--text-secondary)]">
                  A pull request with the Cesium devcontainer is open. Merge it
                  on GitHub, then continue.
                </p>
                {prUrl ? (
                  <a
                    href={prUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-[6px] font-sans text-[12px] text-[var(--accent)] underline"
                  >
                    <ExternalLink className="size-[12px]" strokeWidth={1.7} aria-hidden />
                    Open the pull request
                  </a>
                ) : null}
                <button
                  type="button"
                  onClick={() => void recheckPr()}
                  disabled={checkingPr}
                  className={primaryButtonClass}
                >
                  {checkingPr ? (
                    <Loader2 className="size-[13px] animate-spin" strokeWidth={2} aria-hidden />
                  ) : null}
                  I merged it - continue
                </button>
              </>
            ) : (
              <span className="inline-flex items-start gap-[8px] font-sans text-[12.5px] leading-snug text-[var(--text-primary)]">
                <Loader2
                  className="mt-[2px] size-[13px] shrink-0 animate-spin"
                  strokeWidth={2}
                  aria-hidden
                />
                <span className="flex flex-col gap-[4px]">
                  {PROVISION_LABELS[provisionPhase]}
                  {provisionDetail &&
                  (provisionPhase === "waiting-codespace" ||
                    provisionPhase === "waiting-engine") ? (
                    <span className="font-sans text-[11px] leading-snug text-[var(--text-secondary)]">
                      GitHub state:{" "}
                      <span className="font-mono text-[10.5px] text-[var(--text-primary)]">
                        {provisionDetail.githubState ?? "unknown"}
                      </span>
                      {" · "}
                      {formatElapsed(now - provisionDetail.startedAt)} elapsed
                      {" · "}
                      <span className="font-mono text-[10.5px]">{provisionDetail.codespaceName}</span>
                      {provisionDetail.webUrl ? (
                        <>
                          {" · "}
                          <a
                            href={provisionDetail.webUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[var(--accent)] underline"
                          >
                            open on GitHub
                          </a>
                        </>
                      ) : null}
                    </span>
                  ) : null}
                </span>
              </span>
            )}
            {error && provisionPhase !== "pr-wait" ? (
              <div className="flex flex-col gap-[8px]">
                <p className="font-sans text-[11.5px] text-[var(--goal-accent)]">{error}</p>
                <button
                  type="button"
                  onClick={() => setStep("config")}
                  className={secondaryButtonClass}
                >
                  Back to options
                </button>
              </div>
            ) : null}
            {error && provisionPhase === "pr-wait" ? (
              <p className="font-sans text-[11.5px] text-[var(--goal-accent)]">{error}</p>
            ) : null}
          </>
        ) : null}

        {step === "done" ? (
          <>
            <span className="inline-flex items-center gap-[8px] font-sans text-[13px] text-[var(--text-primary)]">
              <Check className="size-[14px]" strokeWidth={2} aria-hidden />
              Codespace connected{selectedRepo ? ` - ${selectedRepo.fullName}` : ""}
            </span>
            <p className="font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
              The device is registered on your account and selected. It will
              wake automatically whenever you pick it in the device list.
            </p>
            <button
              type="button"
              onClick={onClose}
              className={primaryButtonClass}
              autoFocus
            >
              Done
            </button>
          </>
        ) : null}

        {step !== "provision" && step !== "done" && error ? (
          <p className="font-sans text-[11.5px] text-[var(--goal-accent)]">{error}</p>
        ) : null}
        {connectedServerId === null &&
        step === "provision" &&
        provisionPhase !== "pr-wait" &&
        !error ? (
          <p className="font-sans text-[10.5px] leading-snug text-[var(--text-disabled)]">
            First-time provisioning installs the engine inside the codespace and
            can take several minutes. Leave this dialog open until it finishes -
            closing it cancels setup (the codespace itself keeps building and can
            be connected later from the device list).
          </p>
        ) : null}
      </div>
    </WizardShell>
  );
}
