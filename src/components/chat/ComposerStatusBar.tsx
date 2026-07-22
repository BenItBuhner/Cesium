"use client";

import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { Flame, GitBranch } from "lucide-react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  normalizeComposerStatusBarVisibility,
  resolveComposerBranchLabel,
  resolveComposerRepoLabel,
} from "@/lib/composer-status-bar";
import type { AgentBackendId, AgentContextUsageSnapshot } from "@/lib/agent-types";
import type { GoalProgressSnapshotStatus, GoalProgressStatus } from "@/lib/agent-chat";
import { ContextUsageRing } from "./ContextUsageRing";
import { ComposerStatusBarMenu } from "./ComposerStatusBarMenu";

const COMPOSER_STATUS_BAR_GAP_CLASS = "mt-[4px] mb-[8px]";

function goalProgressBar(progress: number): string {
  const value = Math.max(0, Math.min(100, Math.round(progress)));
  const filled = Math.round(value / 10);
  return `[${"#".repeat(filled)}${"-".repeat(10 - filled)}]`;
}

function formatGoalRuntime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function goalSummarySections(markdown: string | null): Array<{ title: string; bullets: string[] }> {
  const sections: Array<{ title: string; bullets: string[] }> = [];
  let current: { title: string; bullets: string[] } | null = null;
  for (const raw of (markdown ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("## ")) {
      current = { title: line.slice(3).trim(), bullets: [] };
      sections.push(current);
      continue;
    }
    if (current && line.startsWith("- ")) {
      current.bullets.push(line.slice(2).trim());
    }
  }
  return sections;
}

function GoalSummaryHistoryCard({
  item,
  latest = false,
}: {
  item: GoalProgressSnapshotStatus;
  latest?: boolean;
}) {
  const sections = goalSummarySections(item.summary);
  return (
    <div className={latest ? "" : "border-t border-[var(--border-subtle)] pt-[10px]"}>
      <div className="flex items-center justify-between gap-[12px]">
        <div className="min-w-0 truncate font-sans text-[12px] font-semibold text-[var(--text-primary)]">
          {latest ? "Latest State" : item.headline ?? "Previous State"}
        </div>
        <div className="shrink-0 font-mono text-[11px] text-[var(--accent)]">
          {item.progressPercent}% {goalProgressBar(item.progressPercent)}
        </div>
      </div>
      <div className="mt-[3px] font-sans text-[10px] text-[var(--text-disabled)]">
        {new Date(item.updatedAt).toLocaleString()}
      </div>
      {sections.length > 0 ? (
        <div className="mt-[8px] space-y-[7px]">
          {sections.map((section) => (
            <div key={`${item.toolCallId}-${section.title}`}>
              <div className="font-sans text-[11px] font-semibold text-[var(--text-secondary)]">
                {section.title}
              </div>
              <ul className="mt-[3px] space-y-[2px] font-sans text-[11px] leading-[15px] text-[var(--text-secondary)]">
                {section.bullets.map((bullet, index) => (
                  <li key={index}>- {bullet}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : item.summary ? (
        <div className="mt-[8px] whitespace-pre-wrap font-sans text-[11px] leading-[15px] text-[var(--text-secondary)]">
          {item.summary}
        </div>
      ) : null}
    </div>
  );
}

interface ComposerStatusBarProps {
  backendId: AgentBackendId;
  shellInsetClass?: string;
  usage?: AgentContextUsageSnapshot | null;
  contextLoading?: boolean;
  contextBreakdownOpen?: boolean;
  onContextBreakdownOpenChange?: (open: boolean) => void;
  goalProgress?: GoalProgressStatus | null;
}

export function ComposerStatusBar({
  backendId,
  shellInsetClass = "mx-0 @min-[481px]:mx-[10px]",
  usage = null,
  contextLoading = false,
  contextBreakdownOpen = false,
  onContextBreakdownOpenChange,
  goalProgress = null,
}: ComposerStatusBarProps) {
  const { gitStatus, workspaceInfo, workspaceSession, updateWorkspaceSession, workspaces, activeWorkspaceId } =
    useWorkspace();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [goalSummaryOpen, setGoalSummaryOpen] = useState(false);

  const visibility = normalizeComposerStatusBarVisibility(
    workspaceSession.chat.composerStatusBarVisibility
  );

  const workspaceName =
    workspaceInfo?.name ??
    workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.name ??
    null;

  const repoLabel = resolveComposerRepoLabel({ gitStatus, workspaceName });
  const branchLabel = resolveComposerBranchLabel(gitStatus);

  const setVisibility = useCallback(
    (next: typeof visibility) => {
      updateWorkspaceSession((current) => ({
        ...current,
        chat: {
          ...current.chat,
          composerStatusBarVisibility: next,
        },
      }));
    },
    [updateWorkspaceSession]
  );

  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY });
      setGoalSummaryOpen(false);
      onContextBreakdownOpenChange?.(false);
    },
    [onContextBreakdownOpenChange]
  );

  const showRepo = visibility.repo;
  const showBranch = visibility.branch && branchLabel != null;
  const showGoal = visibility.goal && goalProgress != null;
  const showContext = visibility.context;
  const contextSupported = usage?.supported ?? backendId === "cesium-agent";
  const contextPercent = usage?.percentFull ?? 0;
  const [runtimeNow, setRuntimeNow] = useState(() => Date.now());
  const runtimeActiveSince = goalProgress?.runtimeActiveSince ?? null;
  useEffect(() => {
    if (runtimeActiveSince == null) {
      return;
    }
    setRuntimeNow(Date.now());
    const id = window.setInterval(() => setRuntimeNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [runtimeActiveSince]);
  const goalRuntimeSeconds =
    goalProgress?.runtimeSeconds == null
      ? null
      : goalProgress.runtimeSeconds +
        (runtimeActiveSince == null
          ? 0
          : Math.max(0, Math.floor((runtimeNow - runtimeActiveSince) / 1000)));
  const burnHistory = useMemo(
    () => goalProgress?.history ?? (goalProgress ? [goalProgress] : []),
    [goalProgress]
  );
  const burnHistoryNewestFirst = useMemo(
    () => [...burnHistory].reverse(),
    [burnHistory]
  );

  const leftSegments = useMemo(() => {
    const parts: string[] = [];
    if (showRepo) {
      parts.push(repoLabel);
    }
    return parts;
  }, [repoLabel, showRepo]);

  const menuEl = (
    <ComposerStatusBarMenu
      open={menu != null}
      x={menu?.x ?? 0}
      y={menu?.y ?? 0}
      visibility={visibility}
      onVisibilityChange={setVisibility}
      onClose={() => setMenu(null)}
    />
  );

  if (!showRepo && !showBranch && !showGoal && !showContext) {
    return (
      <>
        <div
          className={`${shellInsetClass} relative h-0`}
          aria-label="Composer status bar"
        >
          <div
            className="absolute left-0 right-0 top-[-10px] z-30 h-[10px]"
            onContextMenu={handleContextMenu}
          />
        </div>
        {menuEl}
      </>
    );
  }

  return (
    <>
      <div
        className={`${shellInsetClass} ${COMPOSER_STATUS_BAR_GAP_CLASS} flex min-h-[22px] items-center justify-between gap-[12px] px-[2px] font-sans text-[11px] font-normal leading-none text-[var(--text-secondary)]`}
        onContextMenu={handleContextMenu}
      >
        <div className="flex min-w-0 items-center gap-[10px]">
          {showRepo ? (
            <span className="truncate text-[var(--text-secondary)]">{leftSegments[0]}</span>
          ) : null}
          {showBranch && branchLabel ? (
            <span className="flex min-w-0 items-center gap-[5px] truncate">
              <GitBranch className="size-[12px] shrink-0 opacity-80" strokeWidth={1.5} aria-hidden />
              <span className="truncate">{branchLabel}</span>
            </span>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-[8px]">
          {showGoal && goalProgress ? (
            <div className="relative">
              <button
                type="button"
                className="flex max-w-[310px] items-center gap-[6px] truncate rounded-[6px] bg-[var(--accent-bg)] px-[6px] py-[2px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                title={[
                  `Goal progress: ${goalProgress.progressPercent}%`,
                  goalRuntimeSeconds != null
                    ? `Runtime: ${formatGoalRuntime(goalRuntimeSeconds)}${runtimeActiveSince != null ? " and running" : ""}`
                    : null,
                  goalProgress.headline,
                  goalProgress.summary,
                  burnHistory.length > 1 ? `${burnHistory.length} recorded summaries` : null,
                ].filter(Boolean).join("\n\n")}
                aria-expanded={goalSummaryOpen}
                onClick={() => setGoalSummaryOpen((open) => !open)}
              >
                <Flame className="size-[12px] shrink-0 text-[var(--accent)]" strokeWidth={1.7} aria-hidden />
                <span
                  className="relative h-[5px] w-[58px] shrink-0 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--accent)_18%,transparent)]"
                  aria-hidden
                >
                  <span
                    className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent)]"
                    style={{ width: `${Math.max(0, Math.min(100, goalProgress.progressPercent))}%` }}
                  />
                </span>
                <span className="shrink-0 tabular-nums">{goalProgress.progressPercent}%</span>
                {goalRuntimeSeconds != null ? (
                  <span className="shrink-0 tabular-nums text-[var(--text-disabled)]">
                    {formatGoalRuntime(goalRuntimeSeconds)}
                  </span>
                ) : null}
                {goalProgress.headline ? (
                  <span className="truncate">{goalProgress.headline}</span>
                ) : null}
              </button>
              {goalSummaryOpen ? (
                <div className="absolute bottom-[calc(100%+7px)] right-0 z-50 max-h-[360px] w-[min(440px,calc(100vw-24px))] overflow-auto rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[12px] shadow-[0_18px_50px_rgba(0,0,0,0.35)]">
                  <div className="mb-[10px] flex items-center justify-between gap-[12px]">
                    <div>
                      <div className="font-sans text-[12px] font-semibold text-[var(--text-primary)]">
                        Goal State Summaries
                      </div>
                      <div className="mt-[2px] font-sans text-[11px] text-[var(--text-secondary)]">
                        {burnHistory.length} recorded {burnHistory.length === 1 ? "summary" : "summaries"}
                        {goalRuntimeSeconds != null
                          ? ` · ${formatGoalRuntime(goalRuntimeSeconds)} tracked runtime`
                          : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="rounded-[6px] px-[6px] py-[3px] font-sans text-[11px] text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
                      onClick={() => setGoalSummaryOpen(false)}
                    >
                      Close
                    </button>
                  </div>
                  <div className="space-y-[10px]">
                    {burnHistoryNewestFirst.map((item, index) => (
                      <GoalSummaryHistoryCard
                        key={item.toolCallId}
                        item={item}
                        latest={index === 0}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {showContext ? (
            contextSupported ? (
              <button
                type="button"
                onClick={() => onContextBreakdownOpenChange?.(!contextBreakdownOpen)}
                className="flex shrink-0 items-center gap-[6px] rounded-[6px] px-[4px] py-[2px] text-[var(--text-secondary)] transition-colors hover:bg-[color-mix(in_srgb,var(--bg-card-hover)_65%,transparent)] hover:text-[var(--text-primary)]"
                aria-label={
                  contextLoading
                    ? "Loading context usage"
                    : `Context ${contextPercent}% full. Click for breakdown.`
                }
                aria-expanded={contextBreakdownOpen}
              >
                <ContextUsageRing
                  percent={contextPercent}
                  loading={contextLoading && !usage}
                />
                <span className="tabular-nums">
                  {contextLoading && !usage ? "…" : `${contextPercent}%`}
                </span>
              </button>
            ) : (
              <span
                className="shrink-0 tabular-nums text-[var(--text-disabled)]"
                title="Context usage not available for this agent"
              >
                —
              </span>
            )
          ) : null}
        </div>
      </div>

      {menuEl}
    </>
  );
}
