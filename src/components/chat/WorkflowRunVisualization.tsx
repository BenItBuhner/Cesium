"use client";

import {
  Activity,
  AlertTriangle,
  Clock,
  Coins,
  GitBranch,
  ListTree,
  Pause,
  Play,
  ScrollText,
  Square,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  WorkflowRunSnapshot,
  WorkflowRunSnapshotAgent,
} from "@/lib/types";
import { controlWorkflowRun, getWorkflowRun } from "@/lib/server-api";

type WorkflowView = "phases" | "timeline" | "logs";
type WorkflowControlAction = "pause" | "resume" | "stop";

const ACTIVE_STATUSES = new Set(["pending", "compiling", "running", "paused"]);
const POLLING_STATUSES = new Set(["pending", "compiling", "running"]);
const TERMINAL_AGENT_STATUSES = new Set(["completed", "failed", "cached", "skipped"]);
const controlButtonClass =
  "inline-flex items-center gap-[5px] rounded-[7px] border border-[var(--border-card)] bg-[var(--bg-card)] px-[8px] py-[5px] text-[9px] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--workflow-accent)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-45";

const statusTone: Record<WorkflowRunSnapshot["status"], string> = {
  pending: "border-slate-400/30 bg-slate-400/10 text-slate-300",
  compiling: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  running: "border-violet-400/35 bg-violet-400/12 text-violet-200",
  paused: "border-amber-400/35 bg-amber-400/12 text-amber-200",
  completed: "border-emerald-400/35 bg-emerald-400/12 text-emerald-200",
  failed: "border-rose-400/35 bg-rose-400/12 text-rose-200",
  cancelled: "border-orange-400/35 bg-orange-400/12 text-orange-200",
};

const agentDot: Record<WorkflowRunSnapshotAgent["status"], string> = {
  queued: "bg-slate-400",
  running: "bg-violet-400 shadow-[0_0_10px_rgba(167,139,250,.7)]",
  completed: "bg-emerald-400",
  failed: "bg-rose-400",
  cached: "bg-cyan-400",
  skipped: "bg-amber-400",
};

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function agentDuration(agent: WorkflowRunSnapshotAgent, now: number): number {
  if (agent.startedAt == null) return 0;
  return Math.max(0, (agent.completedAt ?? now) - agent.startedAt);
}

function phaseStatus(
  title: string,
  currentPhase: string | null,
  agents: WorkflowRunSnapshotAgent[],
  runStatus: WorkflowRunSnapshot["status"],
  summary?: WorkflowRunSnapshot["phases"][number]
): "pending" | "running" | "completed" | "failed" | "cancelled" {
  const counts = summary?.statusCounts;
  const failed = counts?.failed ?? agents.filter((agent) => agent.status === "failed").length;
  const skipped = counts?.skipped ?? agents.filter((agent) => agent.status === "skipped").length;
  if (failed > 0 || (runStatus === "failed" && skipped > 0)) return "failed";
  const agentCount = summary?.agentCount ?? agents.length;
  const terminal =
    counts != null
      ? counts.completed + counts.failed + counts.cached
      : agents.filter(
          (agent) =>
            agent.status === "completed" ||
            agent.status === "failed" ||
            agent.status === "cached"
        ).length;
  if (runStatus === "cancelled" && skipped > 0) {
    return "cancelled";
  }
  if (agentCount > 0 && terminal >= agentCount && skipped === 0) {
    return "completed";
  }
  if (
    runStatus === "running" &&
    (title === currentPhase ||
      (counts?.running ?? agents.filter((agent) => agent.status === "running").length) > 0)
  ) {
    return "running";
  }
  return "pending";
}

export function WorkflowRunVisualization({
  snapshot,
  conversationId,
}: {
  snapshot: WorkflowRunSnapshot;
  conversationId?: string | null;
}) {
  const [run, setRun] = useState(snapshot);
  const [active, setActive] = useState(ACTIVE_STATUSES.has(snapshot.status));
  const [view, setView] = useState<WorkflowView>("phases");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [controlBusy, setControlBusy] = useState<WorkflowControlAction | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (snapshot.updatedAt >= run.updatedAt) {
      setRun(snapshot);
    }
  }, [run.updatedAt, snapshot]);

  const refresh = useCallback(async () => {
    if (!conversationId) return;
    try {
      const response = await getWorkflowRun(conversationId, run.runId);
      setRun(response.workflow);
      setActive(response.active);
    } catch {
      // Stored chat snapshots remain useful if a transient refresh fails.
    }
  }, [conversationId, run.runId]);

  useEffect(() => {
    void refresh();
    if (!POLLING_STATUSES.has(run.status)) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [refresh, run.status]);

  const control = useCallback(
    async (action: WorkflowControlAction) => {
      if (!conversationId || controlBusy) return;
      setControlBusy(action);
      setControlError(null);
      try {
        const response = await controlWorkflowRun(conversationId, run.runId, action);
        setRun(response.workflow);
        setActive(action !== "stop");
        window.setTimeout(() => void refresh(), 350);
      } catch (error) {
        setControlError(error instanceof Error ? error.message : String(error));
      } finally {
        setControlBusy(null);
      }
    },
    [conversationId, controlBusy, refresh, run.runId]
  );

  const selectedAgent =
    run.agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const elapsed = (run.completedAt ?? now) - run.createdAt;
  const budgetPercent =
    run.tokenBudget && run.tokenBudget > 0
      ? Math.min(100, (run.tokensUsed / run.tokenBudget) * 100)
      : 0;
  const largeWorkflow = run.agentsUsed > 25 || run.tokensUsed > 1_500_000;
  const terminalAgents =
    run.agentStatusCounts.completed +
    run.agentStatusCounts.failed +
    run.agentStatusCounts.cached +
    run.agentStatusCounts.skipped;
  const phaseLabel =
    run.status === "completed"
      ? "Complete"
      : run.status === "failed"
        ? "Failed"
        : run.status === "cancelled"
          ? "Stopped"
          : run.currentPhase ?? "Waiting";

  const phases = useMemo(() => {
    const declared = run.phases.map((phase) => phase.title);
    const discovered = run.agents
      .map((agent) => agent.phase)
      .filter((phase): phase is string => Boolean(phase));
    const titles = [...new Set([...declared, ...discovered])];
    if (run.agents.some((agent) => !agent.phase)) titles.push("Unassigned");
    return titles.map((title) => {
      const agents = run.agents.filter((agent) =>
        title === "Unassigned" ? !agent.phase : agent.phase === title
      );
      const phase = run.phases.find((candidate) => candidate.title === title);
      return {
        title,
        detail: phase?.detail,
        model: phase?.model,
        agents,
        agentCount: phase?.agentCount ?? agents.length,
        status: phaseStatus(title, run.currentPhase, agents, run.status, phase),
        tokens:
          phase?.tokensUsed ??
          agents.reduce((total, agent) => total + agent.tokensUsed, 0),
      };
    });
  }, [run.agents, run.currentPhase, run.phases, run.status]);

  const timelineStart = Math.min(
    run.createdAt,
    ...run.agents.flatMap((agent) => (agent.startedAt == null ? [] : [agent.startedAt]))
  );
  const timelineEnd = Math.max(
    timelineStart + 1,
    run.completedAt ?? now,
    ...run.agents.flatMap((agent) => (agent.completedAt == null ? [] : [agent.completedAt]))
  );
  const timelineSpan = Math.max(1, timelineEnd - timelineStart);

  return (
    <section className="overflow-hidden rounded-[14px] border border-[color-mix(in_srgb,var(--workflow-accent)_32%,var(--border-card))] bg-[linear-gradient(145deg,color-mix(in_srgb,var(--workflow-accent-bg)_68%,var(--bg-card)),var(--bg-card)_62%)] shadow-[0_18px_55px_rgba(0,0,0,.16)]">
      <div className="border-b border-[color-mix(in_srgb,var(--workflow-accent)_20%,var(--border-subtle))] px-[14px] py-[12px]">
        <div className="flex flex-wrap items-start justify-between gap-[10px]">
          <div className="flex min-w-0 items-start gap-[10px]">
            <span className="mt-[1px] flex size-[30px] shrink-0 items-center justify-center rounded-[9px] bg-[var(--workflow-accent-bg)] text-[var(--workflow-accent)]">
              <GitBranch className="size-[16px]" strokeWidth={1.8} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-[7px]">
                <h3 className="truncate font-sans text-[13px] font-semibold text-[var(--text-primary)]">
                  {run.name}
                </h3>
                <span className={`rounded-full border px-[7px] py-[1px] text-[9px] font-semibold uppercase tracking-[0.1em] ${statusTone[run.status]}`}>
                  {run.status}
                </span>
                {largeWorkflow ? (
                  <span className="inline-flex items-center gap-[4px] rounded-full border border-amber-400/30 bg-amber-400/10 px-[7px] py-[1px] text-[9px] font-semibold uppercase tracking-[0.08em] text-amber-200">
                    <AlertTriangle className="size-[10px]" />
                    Large workflow
                  </span>
                ) : null}
              </div>
              {run.description ? (
                <p className="mt-[3px] line-clamp-2 font-sans text-[11px] leading-relaxed text-[var(--text-secondary)]">
                  {run.description}
                </p>
              ) : null}
            </div>
          </div>
          {conversationId && ACTIVE_STATUSES.has(run.status) ? (
            <div className="flex items-center gap-[5px]">
              {run.status === "paused" ? (
                <button className={controlButtonClass} disabled={Boolean(controlBusy) || !active} onClick={() => void control("resume")}>
                  <Play className="size-[12px]" /> Resume
                </button>
              ) : (
                <button className={controlButtonClass} disabled={Boolean(controlBusy) || !active} onClick={() => void control("pause")}>
                  <Pause className="size-[12px]" /> Pause
                </button>
              )}
              <button className={`${controlButtonClass} hover:border-rose-400/50 hover:text-rose-200`} disabled={Boolean(controlBusy) || !active} onClick={() => void control("stop")}>
                <Square className="size-[11px]" /> Stop
              </button>
            </div>
          ) : null}
        </div>

        <div className="mt-[12px] grid grid-cols-2 gap-[6px] sm:grid-cols-4">
          {[
            { icon: Activity, label: "Phase", value: phaseLabel },
            { icon: Users, label: "Agents", value: `${terminalAgents}/${run.agentsUsed}` },
            { icon: Coins, label: "Tokens", value: compactNumber(run.tokensUsed) },
            { icon: Clock, label: "Elapsed", value: formatDuration(elapsed) },
          ].map(({ icon: Icon, label, value }) => (
            <div key={label} className="rounded-[9px] border border-[color-mix(in_srgb,var(--border-card)_72%,transparent)] bg-[color-mix(in_srgb,var(--bg-card)_74%,transparent)] px-[9px] py-[7px]">
              <div className="flex items-center gap-[5px] text-[9px] uppercase tracking-[0.1em] text-[var(--text-secondary)]">
                <Icon className="size-[10px]" /> {label}
              </div>
              <div className="mt-[3px] truncate font-mono text-[11px] text-[var(--text-primary)]">{value}</div>
            </div>
          ))}
        </div>

        <div className="mt-[10px]">
          <div className="flex items-center justify-between gap-[8px] font-mono text-[9px] text-[var(--text-secondary)]">
            <span>{compactNumber(run.tokensUsed)} used</span>
            <span>{run.tokenBudget ? `${compactNumber(Math.max(0, run.tokenBudget - run.tokensUsed))} remaining` : "unrestricted"}</span>
          </div>
          <div className="mt-[4px] h-[5px] overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--border-card)_62%,transparent)]">
            <div className="h-full rounded-full bg-[linear-gradient(90deg,var(--workflow-accent),#67e8f9)] transition-[width] duration-500" style={{ width: `${budgetPercent}%` }} />
          </div>
        </div>
        {controlError ? <p className="mt-[7px] text-[10px] text-rose-300">{controlError}</p> : null}
      </div>

      <div className="flex items-center gap-[4px] border-b border-[var(--border-subtle)] px-[10px] py-[7px]">
        {([
          ["phases", ListTree, "Phases"],
          ["timeline", Activity, "Timeline"],
          ["logs", ScrollText, "Logs"],
        ] as const).map(([id, Icon, label]) => (
          <button key={id} aria-pressed={view === id} onClick={() => setView(id)} className={`inline-flex items-center gap-[5px] rounded-[7px] px-[8px] py-[4px] text-[10px] transition-colors ${view === id ? "bg-[var(--workflow-accent-bg)] text-[var(--workflow-accent)]" : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"}`}>
            <Icon className="size-[11px]" /> {label}
          </button>
        ))}
        <span className="ml-auto font-mono text-[9px] text-[var(--text-secondary)]">
          {run.agentsTruncated ? `latest ${run.agents.length} of ${run.agentRecordsTotal}` : `${run.agentRecordsTotal} records`}
        </span>
      </div>

      <div className="max-h-[430px] overflow-auto p-[10px]">
        {view === "phases" ? (
          <div className={`grid gap-[9px] ${selectedAgent ? "lg:grid-cols-[minmax(0,1.3fr)_minmax(210px,.7fr)]" : ""}`}>
            <div className="space-y-[8px]">
              {phases.length === 0 ? <p className="py-[18px] text-center text-[11px] text-[var(--text-secondary)]">Waiting for the workflow to enter its first phase.</p> : phases.map((phase, index) => (
                <div key={phase.title} className="relative rounded-[10px] border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-card)_80%,transparent)] px-[10px] py-[9px]">
                  <div className="flex items-start gap-[8px]">
                    <div className="flex flex-col items-center">
                      <span role="img" aria-label={`${phase.title} phase ${phase.status}`} className={`mt-[2px] size-[8px] rounded-full ${phase.status === "running" ? "bg-violet-400 shadow-[0_0_10px_rgba(167,139,250,.75)]" : phase.status === "completed" ? "bg-emerald-400" : phase.status === "failed" ? "bg-rose-400" : phase.status === "cancelled" ? "bg-amber-400" : "bg-slate-500"}`} />
                      {index < phases.length - 1 ? <span className="mt-[3px] h-[22px] w-px bg-[var(--border-subtle)]" /> : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-[7px]">
                        <span className="font-sans text-[11px] font-medium text-[var(--text-primary)]">{phase.title}</span>
                        <span className="font-mono text-[9px] text-[var(--text-secondary)]">{phase.agentCount} agents · {compactNumber(phase.tokens)} tok</span>
                        {phase.model ? <span className="rounded bg-[var(--bg-hover)] px-[5px] py-[1px] font-mono text-[8px] text-[var(--text-secondary)]">{phase.model}</span> : null}
                      </div>
                      {phase.detail ? <p className="mt-[2px] text-[10px] text-[var(--text-secondary)]">{phase.detail}</p> : null}
                      <div className="mt-[7px] grid gap-[4px] sm:grid-cols-2">
                        {phase.agents.map((agent) => (
                          <button key={`${agent.id}-${agent.label}`} onClick={() => setSelectedAgentId(agent.id)} className={`flex min-w-0 items-center gap-[6px] rounded-[7px] border px-[7px] py-[5px] text-left transition-colors ${selectedAgentId === agent.id ? "border-[var(--workflow-accent)] bg-[var(--workflow-accent-bg)]" : "border-transparent bg-[var(--bg-primary)] hover:border-[var(--border-card)]"}`}>
                            <span role="img" aria-label={`${agent.status} agent`} className={`size-[6px] shrink-0 rounded-full ${agentDot[agent.status]}`} />
                            <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--text-primary)]">{agent.label}</span>
                            <span className="shrink-0 font-mono text-[8px] text-[var(--text-secondary)]">{compactNumber(agent.tokensUsed)}</span>
                          </button>
                        ))}
                      </div>
                      {phase.agentCount > phase.agents.length ? (
                        <p className="mt-[5px] font-mono text-[8px] text-[var(--text-secondary)]">
                          Showing {phase.agents.length} recent agents of {phase.agentCount}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {selectedAgent ? (
              <aside className="rounded-[10px] border border-[color-mix(in_srgb,var(--workflow-accent)_24%,var(--border-card))] bg-[var(--bg-card)] p-[10px]">
                <div className="flex items-center gap-[7px]">
                  <span role="img" aria-label={`${selectedAgent.status} agent`} className={`size-[7px] rounded-full ${agentDot[selectedAgent.status]}`} />
                  <h4 className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[var(--text-primary)]">{selectedAgent.label}</h4>
                  <button onClick={() => setSelectedAgentId(null)} className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Close</button>
                </div>
                <div className="mt-[8px] grid grid-cols-2 gap-[5px] font-mono text-[9px] text-[var(--text-secondary)]">
                  <span>{compactNumber(selectedAgent.tokensUsed)} tokens</span>
                  <span>{formatDuration(agentDuration(selectedAgent, now))}</span>
                </div>
                {selectedAgent.promptPreview ? <div className="mt-[9px]"><p className="text-[8px] uppercase tracking-[0.1em] text-[var(--text-secondary)]">Prompt</p><p className="mt-[3px] whitespace-pre-wrap text-[10px] leading-relaxed text-[var(--text-primary)]">{selectedAgent.promptPreview}</p></div> : null}
                {selectedAgent.resultPreview ? <div className="mt-[9px]"><p className="text-[8px] uppercase tracking-[0.1em] text-emerald-300">Result</p><pre className="mt-[3px] whitespace-pre-wrap font-mono text-[9px] leading-relaxed text-[var(--text-primary)]">{selectedAgent.resultPreview}</pre></div> : null}
                {selectedAgent.errorPreview ? <p className="mt-[9px] text-[10px] text-rose-300">{selectedAgent.errorPreview}</p> : null}
              </aside>
            ) : null}
          </div>
        ) : view === "timeline" ? (
          <div className="space-y-[5px]">
            {run.agents.map((agent) => {
              const queued = agent.startedAt == null;
              const start = agent.startedAt ?? timelineStart;
              const end = queued ? start + 1 : agent.completedAt ?? now;
              const left = Math.max(0, ((start - timelineStart) / timelineSpan) * 100);
              const width = Math.max(1.5, ((end - start) / timelineSpan) * 100);
              const barTone =
                agent.status === "queued"
                  ? "bg-slate-500"
                  : agent.status === "running"
                    ? "bg-violet-400"
                    : agent.status === "failed"
                      ? "bg-rose-400"
                      : agent.status === "cached"
                        ? "bg-cyan-400"
                        : agent.status === "skipped"
                          ? "bg-amber-400"
                          : "bg-emerald-400";
              return (
                <button key={`${agent.id}-${agent.label}`} onClick={() => { setSelectedAgentId(agent.id); setView("phases"); }} className="grid w-full grid-cols-[110px_minmax(0,1fr)_52px] items-center gap-[8px] rounded-[7px] px-[6px] py-[5px] text-left hover:bg-[var(--bg-hover)]">
                  <span className="truncate text-[9px] text-[var(--text-primary)]">{agent.label}</span>
                  <span role="img" aria-label={`${agent.label}: ${agent.status}, ${formatDuration(agentDuration(agent, now))}`} className="relative h-[7px] rounded-full bg-[var(--bg-primary)]"><span className={`absolute h-full rounded-full ${barTone}`} style={{ left: `${left}%`, width: `${Math.min(100 - left, width)}%` }} /></span>
                  <span className="text-right font-mono text-[8px] text-[var(--text-secondary)]">{formatDuration(agentDuration(agent, now))}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="space-y-[6px]">
            {run.recentLogs.length === 0 ? <p className="py-[18px] text-center text-[11px] text-[var(--text-secondary)]">No workflow narration yet.</p> : run.recentLogs.map((log, index) => (
              <div key={`${log.at}-${index}`} className="flex gap-[8px] rounded-[7px] bg-[var(--bg-primary)] px-[8px] py-[6px]">
                <span className="shrink-0 font-mono text-[8px] text-[var(--text-secondary)]">{new Date(log.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                <div className="min-w-0"><p className="text-[10px] text-[var(--text-primary)]">{log.message}</p>{log.phase ? <p className="mt-[1px] text-[8px] text-[var(--workflow-accent)]">{log.phase}</p> : null}</div>
              </div>
            ))}
          </div>
        )}
        {run.errorPreview ? <div className="mt-[9px] rounded-[8px] border border-rose-400/25 bg-rose-400/8 px-[9px] py-[7px] text-[10px] text-rose-200">{run.errorPreview}</div> : null}
        {run.returnPreview ? <div className="mt-[9px] rounded-[8px] border border-emerald-400/20 bg-emerald-400/7 px-[9px] py-[7px]"><p className="text-[8px] uppercase tracking-[0.1em] text-emerald-300">Return value</p><pre className="mt-[3px] max-h-[130px] overflow-auto whitespace-pre-wrap font-mono text-[9px] leading-relaxed text-[var(--text-primary)]">{run.returnPreview}</pre></div> : null}
      </div>
    </section>
  );
}
