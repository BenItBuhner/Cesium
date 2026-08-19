"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  FlaskConical,
  Focus,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  GitPullRequestClosed,
  LoaderCircle,
  PanelRight,
  Play,
  Rocket,
  ScrollText,
  Sparkles,
  Terminal,
  Wand2,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  isQuickActionVisibleInContext,
  type QuickActionDefinition,
  type QuickActionRunResult,
  type WorkspaceInsights,
} from "@cesium/core";
import {
  deriveComposerBuiltinPills,
  formatDiffPillLabel,
  listRunningSubagentWorkItems,
  resolveComposerPillsVisibility,
  withComposerPillsVisibility,
  type ComposerBackgroundWorkItem,
  type ComposerPillsVisibility,
} from "@/lib/composer-pills";
import type { AgentConversationStatus } from "@/lib/agent-types";
import { isAgentCesiumTurnActive } from "@/lib/agent-chat";
import { useConversationEvents } from "@/components/chat/AgentConversationsContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useWorkspaceInsights, requestWorkspaceInsightsRefresh } from "@/hooks/useWorkspaceInsights";
import { runQuickAction, useQuickActionsConfig } from "@/lib/quick-actions";
import { executeQuickActionUiCommand } from "@/lib/quick-action-ui";
import { useIDECommandRunner } from "@/components/ide/IDECommandContext";
import { ComposerActionPillsMenu } from "./ComposerActionPillsMenu";

/**
 * Curated icon set for action pills. Custom actions reference these by name;
 * unknown names fall back to Zap.
 */
const PILL_ICONS: Record<string, LucideIcon> = {
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  FlaskConical,
  Focus,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  GitPullRequestClosed,
  PanelRight,
  Play,
  Rocket,
  ScrollText,
  Sparkles,
  Terminal,
  Wand2,
  Wrench,
  Zap,
};

export const QUICK_ACTION_PILL_ICON_NAMES = Object.keys(PILL_ICONS);

/** Resolve a quick action's icon name to its Lucide component (Zap fallback). */
export function quickActionPillIcon(name: string | undefined): LucideIcon {
  return (name && PILL_ICONS[name]) || Zap;
}

const pillBaseClass =
  "flex max-w-[260px] shrink-0 items-center gap-[5px] rounded-full border border-[var(--border-card)] bg-[var(--bg-card)] px-[9px] py-[3px] font-sans text-[11px] leading-[16px] text-[var(--text-secondary)] transition-colors";
const pillInteractiveClass =
  "hover:border-[var(--border-subtle)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60";

type ActionRunState =
  | { phase: "running" }
  | { phase: "confirm" }
  | { phase: "done"; result: QuickActionRunResult }
  | { phase: "error"; message: string; result?: QuickActionRunResult };

type ComposerActionPillsProps = {
  conversationId?: string | null;
  conversationStatus?: AgentConversationStatus;
  shellInsetClass?: string;
};

function StatPopover({
  onClose,
  title,
  children,
}: {
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="absolute bottom-[calc(100%+7px)] left-0 z-50 max-h-[320px] w-[min(420px,calc(100vw-24px))] overflow-auto rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[12px] shadow-[var(--palette-shadow)]"
    >
      <div className="mb-[8px] flex items-center justify-between gap-[10px]">
        <div className="font-sans text-[12px] font-semibold text-[var(--text-primary)]">
          {title}
        </div>
        <button
          type="button"
          className="rounded-[6px] px-[6px] py-[2px] font-sans text-[11px] text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      {children}
    </div>
  );
}

function DiffPopoverContent({ insights }: { insights: WorkspaceInsights }) {
  return (
    <ul className="space-y-[3px]" aria-label="Changed files">
      {insights.diff.files.map((file) => (
        <li key={file.path} className="flex items-center justify-between gap-[10px]">
          <span
            className={`min-w-0 truncate font-mono text-[11px] ${
              file.conflicted ? "text-[var(--status-error)]" : "text-[var(--text-secondary)]"
            }`}
            title={file.path}
          >
            {file.path}
            {file.untracked ? " (new)" : ""}
          </span>
          <span className="flex shrink-0 items-center gap-[6px] font-mono text-[11px] tabular-nums">
            {file.binary ? (
              <span className="text-[var(--text-disabled)]">binary</span>
            ) : (
              <>
                <span className="text-[var(--status-success,#4ade80)]">+{file.added}</span>
                <span className="text-[var(--status-error)]">−{file.removed}</span>
              </>
            )}
          </span>
        </li>
      ))}
      {insights.diff.truncated ? (
        <li className="pt-[4px] font-sans text-[10.5px] text-[var(--text-disabled)]">
          List truncated — showing the largest {insights.diff.files.length} files.
        </li>
      ) : null}
    </ul>
  );
}

function WorkItemRow({ title }: { title: string }) {
  return (
    <li className="flex items-center gap-[6px]">
      <LoaderCircle className="size-[11px] shrink-0 animate-spin text-[var(--accent)]" strokeWidth={2} aria-hidden />
      <span className="min-w-0 truncate">{title}</span>
    </li>
  );
}

function WorkPopoverContent({
  insights,
  currentConversationId,
  extraItems,
}: {
  insights: WorkspaceInsights;
  currentConversationId?: string | null;
  extraItems: ComposerBackgroundWorkItem[];
}) {
  const { work } = insights;
  const currentId = currentConversationId?.trim() || null;
  const otherConversations = work.runningConversationTitles
    .map((title, index) => ({
      id: work.runningConversationIds?.[index] ?? `conversation-${index}`,
      title,
    }))
    .filter((item) => item.id !== currentId);
  const extraIds = new Set(extraItems.map((item) => item.id));
  const uniqueExtraItems = extraItems.filter(
    (item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index
  );
  const conversationItems = otherConversations.filter((item) => !extraIds.has(item.id));
  return (
    <div className="space-y-[6px] font-sans text-[11.5px] text-[var(--text-secondary)]">
      {conversationItems.length > 0 || uniqueExtraItems.length > 0 ? (
        <ul className="space-y-[2px]" aria-label="Background work">
          {conversationItems.map((item) => (
            <WorkItemRow key={item.id} title={item.title} />
          ))}
          {uniqueExtraItems.map((item) => (
            <WorkItemRow key={item.id} title={item.title} />
          ))}
        </ul>
      ) : null}
      {work.runningCloudTasks > 0 ? (
        <div>
          {work.runningCloudTasks} cloud task{work.runningCloudTasks === 1 ? "" : "s"} running
        </div>
      ) : null}
      {work.aliveTerminals > 0 ? (
        <div>
          {work.aliveTerminals} terminal session{work.aliveTerminals === 1 ? "" : "s"} alive
        </div>
      ) : null}
    </div>
  );
}

function RunResultPopoverContent({ state }: { state: ActionRunState }) {
  if (state.phase !== "done" && state.phase !== "error") {
    return null;
  }
  const result = state.phase === "done" ? state.result : state.result ?? null;
  const message = state.phase === "error" ? state.message : null;
  const outputTail = (value: string | undefined): string | null => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return null;
    }
    const lines = trimmed.split(/\r?\n/);
    return lines.slice(-14).join("\n");
  };
  const stdout = outputTail(result?.stdout);
  const stderr = outputTail(result?.stderr);
  return (
    <div className="space-y-[8px]">
      {message ? (
        <div className="font-sans text-[11.5px] text-[var(--status-error)]">{message}</div>
      ) : null}
      {result?.kind === "prompt" ? (
        <div className="font-sans text-[11.5px] text-[var(--text-secondary)]">
          {result.queued
            ? "Prompt queued — it will run when the current turn finishes."
            : "Prompt sent to the conversation."}
        </div>
      ) : null}
      {result?.kind === "command" && result.exitCode != null ? (
        <div className="font-sans text-[11px] text-[var(--text-secondary)]">
          Exit code {result.exitCode}
          {result.durationMs != null ? ` · ${(result.durationMs / 1000).toFixed(1)}s` : ""}
        </div>
      ) : null}
      {stdout ? (
        <pre className="max-h-[160px] overflow-auto whitespace-pre-wrap rounded-[8px] bg-[var(--bg-main)] p-[8px] font-mono text-[10.5px] leading-[15px] text-[var(--text-secondary)]">
          {stdout}
        </pre>
      ) : null}
      {stderr ? (
        <pre className="max-h-[120px] overflow-auto whitespace-pre-wrap rounded-[8px] bg-[var(--bg-main)] p-[8px] font-mono text-[10.5px] leading-[15px] text-[var(--status-error)]">
          {stderr}
        </pre>
      ) : null}
    </div>
  );
}

export function ComposerActionPills({
  conversationId = null,
  conversationStatus,
  shellInsetClass = "mx-0 @min-[481px]:mx-[10px]",
}: ComposerActionPillsProps) {
  const { activeWorkspaceId, workspaceSession, updateWorkspaceSession } = useWorkspace();
  const { effectiveActions, loaded } = useQuickActionsConfig();
  const runCommandRunner = useIDECommandRunner();
  const conversationEvents = useConversationEvents(conversationId);

  const conversationRunning =
    conversationStatus != null && isAgentCesiumTurnActive(conversationStatus);

  const visibility = resolveComposerPillsVisibility(workspaceSession.chat, conversationId);
  const anyPillsEnabled =
    visibility.diff || visibility.conflicts || visibility.sync || visibility.work || visibility.actions;

  const { insights } = useWorkspaceInsights({
    workspaceId: activeWorkspaceId,
    conversationStatus,
    enabled: anyPillsEnabled,
  });

  const liveSubagents = useMemo(
    () =>
      conversationId ? listRunningSubagentWorkItems(conversationEvents) : [],
    [conversationId, conversationEvents]
  );

  const builtin = deriveComposerBuiltinPills(visibility, insights, {
    currentConversationId: conversationId,
    currentConversationRunning: conversationRunning,
    extraWorkCount: liveSubagents.length,
  });

  const visibleActions = useMemo(() => {
    if (!visibility.actions || !loaded) {
      return [] as QuickActionDefinition[];
    }
    return effectiveActions.filter(
      (action) =>
        action.showPill &&
        isQuickActionVisibleInContext(action, {
          insights,
          conversationRunning,
          hasConversation: conversationId != null,
        })
    );
  }, [
    conversationId,
    conversationRunning,
    effectiveActions,
    insights,
    loaded,
    visibility.actions,
  ]);

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [openPopover, setOpenPopover] = useState<
    | { kind: "diff" }
    | { kind: "conflicts" }
    | { kind: "work" }
    | { kind: "result"; actionId: string }
    | null
  >(null);
  const [runStates, setRunStates] = useState<Record<string, ActionRunState>>({});
  const confirmTimersRef = useRef<Record<string, number>>({});

  useEffect(() => {
    setOpenPopover(null);
    setRunStates({});
  }, [conversationId]);

  const setVisibility = useCallback(
    (next: ComposerPillsVisibility) => {
      updateWorkspaceSession((current) => ({
        ...current,
        chat: withComposerPillsVisibility(current.chat, conversationId, next),
      }));
    },
    [conversationId, updateWorkspaceSession]
  );

  const handleContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY });
  }, []);

  const openActionsSettings = useCallback(() => {
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: { ...current.settingsView, activeNav: "actions" },
      layout: { ...current.layout, shellView: "settings", priorShellView: "agent" },
    }));
  }, [updateWorkspaceSession]);

  const setRunState = useCallback((actionId: string, state: ActionRunState | null) => {
    setRunStates((current) => {
      const next = { ...current };
      if (state == null) {
        delete next[actionId];
      } else {
        next[actionId] = state;
      }
      return next;
    });
  }, []);

  const executeAction = useCallback(
    async (action: QuickActionDefinition) => {
      if (action.kind === "ui") {
        executeQuickActionUiCommand(action.uiCommand ?? "", {
          runIdeCommand: runCommandRunner,
          openActionsSettings,
          updateWorkspaceSession,
        });
        return;
      }
      setRunState(action.id, { phase: "running" });
      try {
        const response = await runQuickAction(action.id, {
          ...(action.kind === "prompt" && conversationId ? { conversationId } : {}),
        });
        const result = response.result;
        if (result.ok) {
          setRunState(action.id, { phase: "done", result });
          if (result.kind === "command" && (result.stdout?.trim() || result.stderr?.trim())) {
            setOpenPopover({ kind: "result", actionId: action.id });
          }
          window.setTimeout(() => {
            setRunState(action.id, null);
            setOpenPopover((current) =>
              current?.kind === "result" && current.actionId === action.id ? null : current
            );
          }, 6000);
        } else {
          setRunState(action.id, {
            phase: "error",
            message: result.error ?? "Action failed.",
            result,
          });
          setOpenPopover({ kind: "result", actionId: action.id });
        }
      } catch (error) {
        setRunState(action.id, {
          phase: "error",
          message: error instanceof Error ? error.message : "Action failed.",
        });
        setOpenPopover({ kind: "result", actionId: action.id });
      } finally {
        requestWorkspaceInsightsRefresh();
      }
    },
    [conversationId, openActionsSettings, runCommandRunner, setRunState, updateWorkspaceSession]
  );

  const handleActionClick = useCallback(
    (action: QuickActionDefinition) => {
      const current = runStates[action.id];
      if (current?.phase === "running") {
        return;
      }
      if (current?.phase === "error" || current?.phase === "done") {
        setOpenPopover((open) =>
          open?.kind === "result" && open.actionId === action.id
            ? null
            : { kind: "result", actionId: action.id }
        );
        return;
      }
      if (action.confirm && current?.phase !== "confirm") {
        setRunState(action.id, { phase: "confirm" });
        const timer = window.setTimeout(() => {
          setRunState(action.id, null);
        }, 5000);
        confirmTimersRef.current[action.id] = timer;
        return;
      }
      if (current?.phase === "confirm") {
        window.clearTimeout(confirmTimersRef.current[action.id]);
        delete confirmTimersRef.current[action.id];
      }
      void executeAction(action);
    },
    [executeAction, runStates, setRunState]
  );

  const cancelConfirm = useCallback(
    (actionId: string) => {
      window.clearTimeout(confirmTimersRef.current[actionId]);
      delete confirmTimersRef.current[actionId];
      setRunState(actionId, null);
    },
    [setRunState]
  );

  const menuEl = (
    <ComposerActionPillsMenu
      open={menu != null}
      x={menu?.x ?? 0}
      y={menu?.y ?? 0}
      visibility={visibility}
      onVisibilityChange={setVisibility}
      onClose={() => setMenu(null)}
      onOpenSettings={() => {
        setMenu(null);
        openActionsSettings();
      }}
    />
  );

  const hasContent =
    builtin.showDiff || builtin.showConflicts || builtin.showSync || builtin.showWork ||
    visibleActions.length > 0;

  if (!hasContent) {
    return menu != null ? menuEl : null;
  }

  const conflictCount = insights?.merge.conflictedFiles.length ?? 0;

  return (
    <>
      <div
        className={`${shellInsetClass} flex flex-wrap items-center gap-[6px] pb-[6px]`}
        aria-label="Composer action pills"
        onContextMenu={handleContextMenu}
      >
        {builtin.showConflicts && insights ? (
          <div className="relative">
            <button
              type="button"
              onClick={() =>
                setOpenPopover((open) => (open?.kind === "conflicts" ? null : { kind: "conflicts" }))
              }
              className={`${pillBaseClass} ${pillInteractiveClass} ${
                builtin.conflictsResolved
                  ? "!border-[color-mix(in_srgb,var(--status-success,#4ade80)_35%,transparent)]"
                  : "!border-[color-mix(in_srgb,var(--status-error)_45%,transparent)]"
              }`}
              title={
                builtin.conflictsResolved
                  ? "All merge conflicts resolved — ready to continue"
                  : `${conflictCount} conflicted file${conflictCount === 1 ? "" : "s"}`
              }
            >
              {builtin.conflictsResolved ? (
                <Check className="size-[11px] shrink-0 text-[var(--status-success,#4ade80)]" strokeWidth={2.2} aria-hidden />
              ) : (
                <GitMerge className="size-[11px] shrink-0 text-[var(--status-error)]" strokeWidth={1.8} aria-hidden />
              )}
              <span className="truncate">
                {builtin.conflictsResolved
                  ? "Fixed merge conflicts"
                  : `${conflictCount} merge conflict${conflictCount === 1 ? "" : "s"}`}
              </span>
            </button>
            {openPopover?.kind === "conflicts" ? (
              <StatPopover
                title={builtin.conflictsResolved ? "Merge conflicts resolved" : "Conflicted files"}
                onClose={() => setOpenPopover(null)}
              >
                {builtin.conflictsResolved ? (
                  <div className="font-sans text-[11.5px] text-[var(--text-secondary)]">
                    A {insights.merge.state === "rebasing" ? "rebase" : insights.merge.state === "cherry-picking" ? "cherry-pick" : "merge"} is in
                    progress and every conflict has been resolved. Commit or continue to finish.
                  </div>
                ) : (
                  <ul className="space-y-[3px]" aria-label="Conflicted files">
                    {insights.merge.conflictedFiles.map((file) => (
                      <li key={file} className="truncate font-mono text-[11px] text-[var(--status-error)]" title={file}>
                        {file}
                      </li>
                    ))}
                  </ul>
                )}
              </StatPopover>
            ) : null}
          </div>
        ) : null}

        {builtin.showDiff && insights ? (
          <div className="relative">
            <button
              type="button"
              onClick={() =>
                setOpenPopover((open) => (open?.kind === "diff" ? null : { kind: "diff" }))
              }
              className={`${pillBaseClass} ${pillInteractiveClass}`}
              title="Uncommitted changes — click for the per-file breakdown"
            >
              <span className="font-mono tabular-nums text-[var(--status-success,#4ade80)]">
                +{insights.diff.totalAdded}
              </span>
              <span className="font-mono tabular-nums text-[var(--status-error)]">
                −{insights.diff.totalRemoved}
              </span>
              <span className="truncate text-[var(--text-disabled)]">
                {insights.diff.fileCount} file{insights.diff.fileCount === 1 ? "" : "s"}
              </span>
            </button>
            {openPopover?.kind === "diff" ? (
              <StatPopover title={formatDiffPillLabel(insights)} onClose={() => setOpenPopover(null)}>
                <DiffPopoverContent insights={insights} />
              </StatPopover>
            ) : null}
          </div>
        ) : null}

        {builtin.showSync && insights ? (
          <span
            className={pillBaseClass}
            title={`${insights.ahead} commit${insights.ahead === 1 ? "" : "s"} ahead, ${insights.behind} behind upstream`}
          >
            <span className="font-mono tabular-nums">
              {insights.ahead > 0 ? `↑${insights.ahead}` : ""}
              {insights.ahead > 0 && insights.behind > 0 ? " " : ""}
              {insights.behind > 0 ? `↓${insights.behind}` : ""}
            </span>
            <span className="truncate text-[var(--text-disabled)]">upstream</span>
          </span>
        ) : null}

        {builtin.showWork && insights ? (
          <div className="relative">
            <button
              type="button"
              onClick={() =>
                setOpenPopover((open) => (open?.kind === "work" ? null : { kind: "work" }))
              }
              className={`${pillBaseClass} ${pillInteractiveClass}`}
              title="Background work in this workspace"
            >
              <LoaderCircle className="size-[11px] shrink-0 animate-spin text-[var(--accent)]" strokeWidth={2} aria-hidden />
              <span className="truncate">
                {builtin.workCount} task{builtin.workCount === 1 ? "" : "s"} working
              </span>
            </button>
            {openPopover?.kind === "work" ? (
              <StatPopover title="Background work" onClose={() => setOpenPopover(null)}>
                <WorkPopoverContent
                  insights={insights}
                  currentConversationId={conversationId}
                  extraItems={liveSubagents}
                />
              </StatPopover>
            ) : null}
          </div>
        ) : null}

        {visibleActions.map((action) => {
          const Icon = quickActionPillIcon(action.icon);
          const runState = runStates[action.id];
          const isRunning = runState?.phase === "running";
          const isConfirm = runState?.phase === "confirm";
          const isError = runState?.phase === "error";
          const isDone = runState?.phase === "done";
          return (
            <div key={action.id} className="relative">
              <span className="flex items-center">
                <button
                  type="button"
                  onClick={() => handleActionClick(action)}
                  disabled={isRunning}
                  className={`${pillBaseClass} ${pillInteractiveClass} ${
                    isError
                      ? "!border-[color-mix(in_srgb,var(--status-error)_45%,transparent)]"
                      : isConfirm
                        ? "!border-[color-mix(in_srgb,var(--accent)_45%,transparent)]"
                        : ""
                  }`}
                  title={
                    action.kind === "command"
                      ? action.command
                      : action.kind === "prompt"
                        ? action.prompt
                        : action.label
                  }
                >
                  {isRunning ? (
                    <LoaderCircle className="size-[11px] shrink-0 animate-spin text-[var(--accent)]" strokeWidth={2} aria-hidden />
                  ) : isDone ? (
                    <Check className="size-[11px] shrink-0 text-[var(--status-success,#4ade80)]" strokeWidth={2.2} aria-hidden />
                  ) : isError ? (
                    <X className="size-[11px] shrink-0 text-[var(--status-error)]" strokeWidth={2.2} aria-hidden />
                  ) : (
                    <Icon className="size-[11px] shrink-0 opacity-80" strokeWidth={1.8} aria-hidden />
                  )}
                  <span className="truncate">
                    {isConfirm ? `Run ${action.label}?` : action.label}
                  </span>
                </button>
                {isConfirm ? (
                  <button
                    type="button"
                    onClick={() => cancelConfirm(action.id)}
                    className="ml-[3px] flex size-[18px] shrink-0 items-center justify-center rounded-full text-[var(--text-disabled)] hover:text-[var(--text-primary)]"
                    aria-label={`Cancel ${action.label}`}
                  >
                    <X className="size-[10px]" strokeWidth={2.2} aria-hidden />
                  </button>
                ) : null}
              </span>
              {openPopover?.kind === "result" && openPopover.actionId === action.id && runState ? (
                <StatPopover
                  title={action.label}
                  onClose={() => setOpenPopover(null)}
                >
                  <RunResultPopoverContent state={runState} />
                </StatPopover>
              ) : null}
            </div>
          );
        })}
      </div>
      {menuEl}
    </>
  );
}
