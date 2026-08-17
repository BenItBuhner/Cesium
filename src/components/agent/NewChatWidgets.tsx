"use client";

import {
  AudioLines,
  Check,
  Lightbulb,
  LoaderCircle,
  MessageSquare,
  PanelRight,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  isQuickActionVisibleInContext,
  type AgentRailConversationSummary,
  type QuickActionDefinition,
  type QuickActionRunResult,
} from "@cesium/core";
import { quickActionPillIcon } from "@/components/chat/ComposerActionPills";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { useIDECommandRunner } from "@/components/ide/IDECommandContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useWorkspaceInsights, requestWorkspaceInsightsRefresh } from "@/hooks/useWorkspaceInsights";
import type { NewChatWidgetId } from "@/lib/global-settings";
import {
  detectShortcutPlatform,
  getShortcutDisplayForCommand,
} from "@/lib/keyboard-shortcuts";
import { runQuickAction, useQuickActionsConfig } from "@/lib/quick-actions";
import { executeQuickActionUiCommand } from "@/lib/quick-action-ui";
import { isStandaloneChatWorkspace } from "@/lib/types";
import {
  getWorkspaceRailAppearance,
  WorkspaceFolderIcon,
} from "@/lib/workspace-rail-appearance";
import { useAgentShellState } from "./AgentShellStateContext";

export const NEW_CHAT_WIDGET_LABELS: Record<NewChatWidgetId, string> = {
  shortcuts: "Shortcuts",
  actions: "Actions",
  "recent-chats": "Recent chats",
  "recent-activity": "Recent activity",
};

export const NEW_CHAT_WIDGET_DESCRIPTIONS: Record<NewChatWidgetId, string> = {
  shortcuts: "Plan-mode, voice-agent, and editor-panel quick buttons.",
  actions:
    "Quick actions from Settings → Actions. Commands run in the selected workspace's path.",
  "recent-chats": "Jump back into your most recent conversations.",
  "recent-activity": "Recently opened workspaces, one click away.",
};

const MAX_ACTION_PILLS = 8;
const MAX_RECENT_CHATS = 4;
const MAX_RECENT_WORKSPACES = 4;

/**
 * Two design tiers, one landing:
 *
 * 1. Shortcuts and quick actions are pill buttons — the same design the
 *    landing quick actions have always had (`aurora-glass` pill material).
 * 2. Recent chats and recent activity are full-sized widget cards sharing
 *    the chat composer's material: `.chat-composer-surface` translucent
 *    fill, `--agent-border` outline, and the composer's high corner radius.
 */
const PILL_CLASSNAME =
  "aurora-glass inline-flex max-w-full min-w-0 items-center gap-[6px] rounded-[var(--agent-pill-radius)] border border-[var(--agent-border)] bg-[var(--agent-panel-bg)] px-[14px] py-[7px] text-left font-sans text-[12px] leading-none font-normal text-[var(--text-primary)] whitespace-nowrap transition-colors hover:bg-[var(--agent-card-hover-bg)] disabled:cursor-not-allowed disabled:opacity-60";
const PILL_ICON_CLASSNAME = "size-[12px] shrink-0 text-[var(--text-secondary)]";
const PILL_ROW_CLASSNAME = "flex w-full min-w-0 flex-wrap items-center gap-[8px]";
const WIDGET_CARD_CLASSNAME =
  "chat-composer-surface w-full min-w-0 rounded-[var(--agent-composer-radius)] border border-[var(--agent-border)] p-[8px]";
const WIDGET_CARD_ROW_CLASSNAME =
  "flex w-full min-w-0 items-center gap-[9px] rounded-[calc(var(--agent-composer-radius)-8px)] px-[10px] py-[7px] text-left font-sans text-[12.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--agent-card-hover-bg)]";
const WIDGET_CARD_META_CLASSNAME =
  "shrink-0 font-sans text-[10.5px] text-[var(--text-disabled)]";

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) {
    return `${days}d`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return "now";
}

function isRecentChatCandidate(summary: AgentRailConversationSummary): boolean {
  if (summary.archivedAt != null) {
    return false;
  }
  const busy =
    summary.status === "running" || summary.status === "awaiting_permission";
  if (summary.title === "New chat" && !busy) {
    return false;
  }
  return !summary.title.startsWith("Draft: ");
}

type ActionRunState =
  | { phase: "running" }
  | { phase: "confirm" }
  | { phase: "done"; result: QuickActionRunResult }
  | { phase: "error"; message: string; result?: QuickActionRunResult };

function ActionResultPopover({
  title,
  state,
  onClose,
}: {
  title: string;
  state: ActionRunState;
  onClose: () => void;
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
    return trimmed.split(/\r?\n/).slice(-14).join("\n");
  };
  const stdout = outputTail(result?.stdout);
  const stderr = outputTail(result?.stderr);
  return (
    <div
      ref={ref}
      className="absolute bottom-[calc(100%+7px)] left-0 z-50 max-h-[320px] w-[min(420px,calc(100vw-24px))] overflow-auto rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[12px] shadow-[0_18px_50px_rgba(0,0,0,0.35)]"
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
      <div className="space-y-[8px]">
        {message ? (
          <div className="font-sans text-[11.5px] text-[var(--status-error)]">{message}</div>
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
    </div>
  );
}

/**
 * Customizable landing stack rendered under the new-chat composer, with two
 * design tiers and no widget titles: shortcut and quick-action PILLS (the
 * quick actions system keeps its own button design; commands execute against
 * the actively selected workspace's path), and full-sized widget CARDS for
 * recent conversations and recently opened workspaces, sharing the chat
 * composer's material. The stack spans the composer's full width; order and
 * visibility are configured in Settings → General → New chat widgets and
 * persist in `settings.general.newChatWidgets`.
 */
export function NewChatWidgets({ noWorkspaceDraft }: { noWorkspaceDraft: boolean }) {
  const { settings } = useGlobalSettings();
  const {
    activeWorkspaceId,
    workspaceInfo,
    workspaces,
    recentWorkspaceIds,
    homeWorkspaceId,
    openWorkspaceById,
    updateWorkspaceSession,
  } = useWorkspace();
  const {
    groups,
    pinnedRailConversations,
    openConversationSummary,
    setRightPaneOpen,
    setStandaloneDraftActive,
  } = useAgentShellState();
  const { activeServer } = useServerConnections();
  const { effectiveActions, loaded: actionsLoaded } = useQuickActionsConfig();
  const runCommand = useIDECommandRunner();

  const widgetsState = settings.general.newChatWidgets;
  const visibleWidgets = useMemo(
    () => widgetsState.order.filter((id) => !widgetsState.hidden.includes(id)),
    [widgetsState.hidden, widgetsState.order]
  );

  const actionsWidgetVisible =
    visibleWidgets.includes("actions") && !noWorkspaceDraft;

  const { insights } = useWorkspaceInsights({
    workspaceId: activeWorkspaceId,
    enabled: actionsWidgetVisible,
  });

  // ── Shortcuts ──────────────────────────────────────────────────────────────
  const planShortcutHint = useMemo(() => {
    return (
      getShortcutDisplayForCommand(
        settings.keyboardShortcuts.bindings,
        "workbench.action.focusChatPlanMode",
        detectShortcutPlatform()
      ) || "Mod+I"
    );
  }, [settings.keyboardShortcuts.bindings]);

  const voiceAgentShortcutHint = useMemo(() => {
    return getShortcutDisplayForCommand(
      settings.keyboardShortcuts.bindings,
      "workbench.action.startVoiceAgent",
      detectShortcutPlatform()
    );
  }, [settings.keyboardShortcuts.bindings]);

  // ── Actions (quick actions run at the active workspace's root) ────────────
  const visibleActions = useMemo(() => {
    if (!actionsWidgetVisible || !actionsLoaded) {
      return [] as QuickActionDefinition[];
    }
    return effectiveActions
      .filter(
        (action) =>
          action.showPill &&
          isQuickActionVisibleInContext(action, {
            insights,
            conversationRunning: false,
            // The landing has no conversation yet; prompt actions are hidden.
            hasConversation: false,
          })
      )
      .slice(0, MAX_ACTION_PILLS);
  }, [actionsLoaded, actionsWidgetVisible, effectiveActions, insights]);

  const [runStates, setRunStates] = useState<Record<string, ActionRunState>>({});
  const [openResultActionId, setOpenResultActionId] = useState<string | null>(null);
  const confirmTimersRef = useRef<Record<string, number>>({});

  useEffect(() => {
    setRunStates({});
    setOpenResultActionId(null);
  }, [activeWorkspaceId]);

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

  const openActionsSettings = useCallback(() => {
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: { ...current.settingsView, activeNav: "actions" },
      layout: { ...current.layout, shellView: "settings", priorShellView: "agent" },
    }));
  }, [updateWorkspaceSession]);

  const executeAction = useCallback(
    async (action: QuickActionDefinition) => {
      if (action.kind === "ui") {
        executeQuickActionUiCommand(action.uiCommand ?? "", {
          runIdeCommand: runCommand,
          openActionsSettings,
          updateWorkspaceSession,
        });
        return;
      }
      setRunState(action.id, { phase: "running" });
      try {
        // Runs on the server against the actively selected workspace: the
        // request carries the active workspace id, and command actions spawn
        // at that workspace's root path.
        const response = await runQuickAction(action.id);
        const result = response.result;
        if (result.ok) {
          setRunState(action.id, { phase: "done", result });
          if (result.kind === "command" && (result.stdout?.trim() || result.stderr?.trim())) {
            setOpenResultActionId(action.id);
          }
          window.setTimeout(() => {
            setRunState(action.id, null);
            setOpenResultActionId((current) => (current === action.id ? null : current));
          }, 6000);
        } else {
          setRunState(action.id, {
            phase: "error",
            message: result.error ?? "Action failed.",
            result,
          });
          setOpenResultActionId(action.id);
        }
      } catch (error) {
        setRunState(action.id, {
          phase: "error",
          message: error instanceof Error ? error.message : "Action failed.",
        });
        setOpenResultActionId(action.id);
      } finally {
        requestWorkspaceInsightsRefresh();
      }
    },
    [openActionsSettings, runCommand, setRunState, updateWorkspaceSession]
  );

  const handleActionClick = useCallback(
    (action: QuickActionDefinition) => {
      const current = runStates[action.id];
      if (current?.phase === "running") {
        return;
      }
      if (current?.phase === "error" || current?.phase === "done") {
        setOpenResultActionId((open) => (open === action.id ? null : action.id));
        return;
      }
      if (action.confirm && current?.phase !== "confirm") {
        setRunState(action.id, { phase: "confirm" });
        confirmTimersRef.current[action.id] = window.setTimeout(() => {
          setRunState(action.id, null);
        }, 5000);
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

  // ── Recent chats ───────────────────────────────────────────────────────────
  const recentChats = useMemo(() => {
    const seen = new Set<string>();
    const summaries: AgentRailConversationSummary[] = [];
    const push = (summary: AgentRailConversationSummary) => {
      if (seen.has(summary.id) || !isRecentChatCandidate(summary)) {
        return;
      }
      seen.add(summary.id);
      summaries.push(summary);
    };
    for (const summary of pinnedRailConversations) {
      push(summary);
    }
    for (const group of groups) {
      for (const summary of group.conversations) {
        push(summary);
      }
    }
    return summaries
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_RECENT_CHATS);
  }, [groups, pinnedRailConversations]);

  const workspaceNameById = useMemo(() => {
    const names = new Map<string, string>();
    for (const group of groups) {
      if (!names.has(group.workspace.id)) {
        names.set(group.workspace.id, group.workspace.name);
      }
    }
    for (const workspace of workspaces) {
      if (!names.has(workspace.id)) {
        names.set(workspace.id, workspace.name);
      }
    }
    return names;
  }, [groups, workspaces]);

  // ── Recent activity (recently opened workspaces) ──────────────────────────
  const recentWorkspaces = useMemo(() => {
    const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    return recentWorkspaceIds
      .filter((id) => id !== activeWorkspaceId)
      .map((id) => byId.get(id))
      .filter(
        (workspace): workspace is NonNullable<typeof workspace> =>
          workspace != null && !isStandaloneChatWorkspace(workspace)
      )
      .slice(0, MAX_RECENT_WORKSPACES);
  }, [activeWorkspaceId, recentWorkspaceIds, workspaces]);

  // ── Tile renderers (uniform look, no titles) ───────────────────────────────
  const shortcutPills: ReactNode[] = [
    <button
      key="shortcut-plan"
      type="button"
      onClick={() => runCommand?.("workbench.action.focusChatPlanMode")}
      className={PILL_CLASSNAME}
      title={`Start planning a new idea (${planShortcutHint})`}
    >
      <Lightbulb className={PILL_ICON_CLASSNAME} strokeWidth={1.5} aria-hidden />
      <span className="truncate">
        Plan new idea{" "}
        <span className="text-[var(--text-secondary)]">({planShortcutHint})</span>
      </span>
    </button>,
    <button
      key="shortcut-voice"
      type="button"
      onClick={() => runCommand?.("workbench.action.startVoiceAgent")}
      className={PILL_CLASSNAME}
      title={
        voiceAgentShortcutHint
          ? `Start a voice agent session (${voiceAgentShortcutHint})`
          : "Start a voice agent session"
      }
    >
      <AudioLines className={PILL_ICON_CLASSNAME} strokeWidth={1.5} aria-hidden />
      <span className="truncate">
        Start voice agent
        {voiceAgentShortcutHint ? (
          <span className="text-[var(--text-secondary)]">
            {" "}
            ({voiceAgentShortcutHint})
          </span>
        ) : null}
      </span>
    </button>,
    <button
      key="shortcut-editor"
      type="button"
      onClick={() => setRightPaneOpen(true)}
      className={PILL_CLASSNAME}
      title="Open the editor panel"
    >
      <PanelRight className={PILL_ICON_CLASSNAME} strokeWidth={1.5} aria-hidden />
      <span className="truncate">Open editor panel</span>
    </button>,
  ];

  const actionPills: ReactNode[] = visibleActions.map((action) => {
    const Icon = quickActionPillIcon(action.icon);
    const runState = runStates[action.id];
    const isRunning = runState?.phase === "running";
    const isConfirm = runState?.phase === "confirm";
    const isError = runState?.phase === "error";
    const isDone = runState?.phase === "done";
    const runsIn = workspaceInfo?.root ? ` — runs in ${workspaceInfo.root}` : "";
    return (
      <div key={`action-${action.id}`} className="relative min-w-0">
        <button
          type="button"
          onClick={() => handleActionClick(action)}
          disabled={isRunning}
          className={`${PILL_CLASSNAME} ${
            isError
              ? "!border-[color-mix(in_srgb,var(--status-error)_45%,transparent)]"
              : isConfirm
                ? "!border-[color-mix(in_srgb,var(--accent)_45%,transparent)]"
                : ""
          }`}
          title={
            action.kind === "command"
              ? `${action.command ?? action.label}${runsIn}`
              : action.label
          }
        >
          {isRunning ? (
            <LoaderCircle
              className="size-[12px] shrink-0 animate-spin text-[var(--accent)]"
              strokeWidth={2}
              aria-hidden
            />
          ) : isDone ? (
            <Check
              className="size-[12px] shrink-0 text-[var(--status-success,#4ade80)]"
              strokeWidth={2.2}
              aria-hidden
            />
          ) : isError ? (
            <X
              className="size-[12px] shrink-0 text-[var(--status-error)]"
              strokeWidth={2.2}
              aria-hidden
            />
          ) : (
            <Icon className={PILL_ICON_CLASSNAME} strokeWidth={1.5} aria-hidden />
          )}
          <span className="truncate">
            {isConfirm ? `Run ${action.label}?` : action.label}
          </span>
        </button>
        {openResultActionId === action.id && runState ? (
          <ActionResultPopover
            title={action.label}
            state={runState}
            onClose={() => setOpenResultActionId(null)}
          />
        ) : null}
      </div>
    );
  });

  const recentChatsCard: ReactNode =
    recentChats.length > 0 ? (
      <div key="recent-chats" className={WIDGET_CARD_CLASSNAME}>
        {recentChats.map((summary) => {
          const workspaceName = workspaceNameById.get(summary.workspaceId);
          const otherWorkspace =
            workspaceName != null && summary.workspaceId !== activeWorkspaceId
              ? workspaceName
              : null;
          return (
            <button
              key={summary.id}
              type="button"
              onClick={() => void openConversationSummary(summary).catch(() => undefined)}
              className={WIDGET_CARD_ROW_CLASSNAME}
              title={
                otherWorkspace ? `${summary.title} — ${otherWorkspace}` : summary.title
              }
            >
              <MessageSquare
                className="size-[13px] shrink-0 text-[var(--text-secondary)]"
                strokeWidth={1.5}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">{summary.title}</span>
              {otherWorkspace ? (
                <span className="max-w-[110px] shrink truncate font-sans text-[10.5px] text-[var(--text-disabled)]">
                  {otherWorkspace}
                </span>
              ) : null}
              <span className={WIDGET_CARD_META_CLASSNAME}>
                {formatRelativeTime(summary.updatedAt)}
              </span>
            </button>
          );
        })}
      </div>
    ) : null;

  const recentActivityCard: ReactNode =
    recentWorkspaces.length > 0 ? (
      <div key="recent-activity" className={WIDGET_CARD_CLASSNAME}>
        {recentWorkspaces.map((workspace) => {
          const appearance = getWorkspaceRailAppearance(
            settings.general.workspaceRailAppearances,
            `${activeServer.id}:${workspace.id}`,
            { isHome: workspace.id === homeWorkspaceId }
          );
          return (
            <button
              key={workspace.id}
              type="button"
              onClick={() => {
                setStandaloneDraftActive(false);
                void openWorkspaceById(workspace.id).catch(() => undefined);
              }}
              className={WIDGET_CARD_ROW_CLASSNAME}
              title={workspace.root}
            >
              <WorkspaceFolderIcon
                iconName={appearance.icon}
                color={appearance.color}
                className="size-[13px] shrink-0"
                strokeWidth={1.5}
              />
              <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
              {workspace.lastOpenedAt ? (
                <span className={WIDGET_CARD_META_CLASSNAME}>
                  {formatRelativeTime(workspace.lastOpenedAt)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    ) : null;

  const widgetNodes: ReactNode[] = visibleWidgets
    .map((id) => {
      switch (id) {
        case "shortcuts":
          return (
            <div key="shortcuts" className={PILL_ROW_CLASSNAME}>
              {shortcutPills}
            </div>
          );
        case "actions":
          return actionPills.length > 0 ? (
            <div key="actions" className={PILL_ROW_CLASSNAME}>
              {actionPills}
            </div>
          ) : null;
        case "recent-chats":
          return recentChatsCard;
        case "recent-activity":
          return recentActivityCard;
        default:
          return null;
      }
    })
    .filter((node) => node != null);

  // Full width, aligned with the chat composer above. Customization lives in
  // Settings → General → New chat widgets — no inline edit chrome.
  return <div className="mt-[10px] flex w-full min-w-0 flex-col gap-[10px]">{widgetNodes}</div>;
}

/**
 * Toggle a widget in/out of `settings.general.newChatWidgets.hidden`.
 * Used by Settings → General → New chat widgets.
 */
export function useNewChatWidgetVisibilityToggle(): (id: NewChatWidgetId) => void {
  const { updateSettings } = useGlobalSettings();
  return useCallback(
    (id: NewChatWidgetId) => {
      updateSettings((current) => {
        const hidden = current.general.newChatWidgets.hidden;
        return {
          ...current,
          general: {
            ...current.general,
            newChatWidgets: {
              ...current.general.newChatWidgets,
              hidden: hidden.includes(id)
                ? hidden.filter((value) => value !== id)
                : [...hidden, id],
            },
          },
        };
      });
    },
    [updateSettings]
  );
}

/**
 * Move a widget within `settings.general.newChatWidgets.order`.
 * Used by Settings → General → New chat widgets.
 */
export function useNewChatWidgetMove(): (id: NewChatWidgetId, delta: -1 | 1) => void {
  const { updateSettings } = useGlobalSettings();
  return useCallback(
    (id: NewChatWidgetId, delta: -1 | 1) => {
      updateSettings((current) => {
        const order = [...current.general.newChatWidgets.order];
        const index = order.indexOf(id);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= order.length) {
          return current;
        }
        [order[index], order[target]] = [order[target]!, order[index]!];
        return {
          ...current,
          general: {
            ...current.general,
            newChatWidgets: { ...current.general.newChatWidgets, order },
          },
        };
      });
    },
    [updateSettings]
  );
}
